[CmdletBinding()]
param(
    [switch]$LocalOnly,
    [switch]$QuietAccess,
    [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$logRoot = Join-Path $root 'logs'
$dataRoot = Join-Path $root 'data'
$tempRoot = Join-Path $root 'temp'
$configPath = Join-Path $root 'config\monitor.json'
$node = Join-Path $root 'runtime\node\node.exe'
$serverScript = Join-Path $root 'app\server.js'
$pidPath = Join-Path $dataRoot 'monitor.pid.json'
$stdoutPath = Join-Path $logRoot 'server.stdout.log'
$stderrPath = Join-Path $logRoot 'server.stderr.log'
foreach ($directory in @($logRoot, $dataRoot, $tempRoot, (Join-Path $root 'cache'))) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
$env:TEMP = $tempRoot
$env:TMP = $tempRoot
$env:NPM_CONFIG_CACHE = Join-Path $root 'cache\npm'
$env:NPM_CONFIG_PREFIX = Join-Path $root 'runtime\npm-global'
$env:XDG_CACHE_HOME = Join-Path $root 'cache'
$env:PSModuleAnalysisCachePath = Join-Path $root 'cache\powershell-analysis'
$env:POWERSHELL_TELEMETRY_OPTOUT = '1'
$env:MONITOR_ROOT = $root
$env:MONITOR_CONFIG = $configPath
$env:Path = (Join-Path $root 'runtime\node') + ';' + $env:Path
$mutex = [System.Threading.Mutex]::new($false, 'Local\CodexMultiSessionMonitorStart')
if (-not $mutex.WaitOne(30000)) { throw 'Another monitor START is still running.' }
try {
$stopFlag = Join-Path $root 'data\stop.request'
if (Test-Path -LiteralPath $stopFlag) { Remove-Item -LiteralPath $stopFlag -Force }

function Write-StartLog {
    param([string]$Message)
    $line = (Get-Date -Format 'o') + ' ' + $Message
    Add-Content -LiteralPath (Join-Path $logRoot 'start.log') -Value $line
    Write-Output $line
}

function Test-PrivateIPv4 {
    param([string]$Address)
    $parts = $Address.Split('.')
    if ($parts.Count -ne 4) { return $false }
    $a = [int]$parts[0]
    $b = [int]$parts[1]
    return ($a -eq 10) -or ($a -eq 192 -and $b -eq 168) -or ($a -eq 172 -and $b -ge 16 -and $b -le 31)
}

function Get-PrivateBindAddress {
    try {
        $addresses = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
            Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -notin @('Loopback', 'Tunnel') } |
            Sort-Object @{Expression={ if ($_.GetIPProperties().GatewayAddresses.Count -gt 0) {0} else {1} }} |
            ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
            Where-Object { $_.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } |
            ForEach-Object { $_.Address.IPAddressToString } |
            Where-Object { $_ -ne '127.0.0.1' -and -not $_.StartsWith('169.254.') -and (Test-PrivateIPv4 $_) }
        return ($addresses | Select-Object -First 1)
    } catch {
        return $null
    }
}

function Test-PortAvailable {
    param([string]$HostName, [int]$ListenPort)
    $listener = $null
    try {
        $ip = [System.Net.IPAddress]::Parse($HostName)
        $listener = [System.Net.Sockets.TcpListener]::new($ip, $ListenPort)
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($listener) { $listener.Stop() }
    }
}

function Get-AvailablePort {
    param([string]$HostName, [int]$RequestedPort)
    if ($RequestedPort -lt 1024 -or $RequestedPort -gt 65500) { throw 'Port must be between 1024 and 65500.' }
    for ($candidate = $RequestedPort; $candidate -le ($RequestedPort + 49); $candidate++) {
        if (Test-PortAvailable -HostName $HostName -ListenPort $candidate) { return $candidate }
    }
    throw ('No available port found in the requested range starting at ' + $RequestedPort + '.')
}

function Get-ExactMonitorProcess {
    $matches = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -eq $node -and $_.CommandLine -like ('*' + $serverScript + '*') }
    return @($matches)
}

function Get-MonitorToken {
    $tokenPath = Join-Path $root 'config\access.token'
    if (-not (Test-Path -LiteralPath $tokenPath)) { return '' }
    return (Get-Content -LiteralPath $tokenPath -Raw).Trim()
}

function Ensure-Supervisor {
    $supervisorScript = Join-Path $PSScriptRoot 'supervisor.js'
    $lockPath = Join-Path $dataRoot 'supervisor.lock'
    if (Test-Path -LiteralPath $lockPath) {
        $supervisorId = 0
        if ([int]::TryParse((Get-Content $lockPath -Raw).Trim(), [ref]$supervisorId)) {
            $supervisorProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $supervisorId) -ErrorAction SilentlyContinue
            if ($supervisorProcess -and $supervisorProcess.ExecutablePath -eq $node -and $supervisorProcess.CommandLine -like ('*' + $supervisorScript + '*')) { return }
        }
    }
    $scheduler = Join-Path $env:WINDIR 'System32\schtasks.exe'
    & $scheduler /Query /TN 'Codex-MultiSession-Monitor' 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        & $scheduler /Run /TN 'Codex-MultiSession-Monitor' | Out-Null
    } else {
        Start-Process -FilePath $node -ArgumentList @($supervisorScript) -WorkingDirectory $root -WindowStyle Hidden | Out-Null
    }
}

function Get-Health {
    param([string]$Protocol, [string]$HostName, [int]$ListenPort, [string]$Token)
    if (-not $Token) { return $null }
    $url = $Protocol + '://' + $HostName + ':' + $ListenPort + '/api/health?token=' + [Uri]::EscapeDataString($Token)
    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -SkipCertificateCheck -TimeoutSec 3
        return ($response.Content | ConvertFrom-Json)
    } catch {
        return $null
    }
}

$bindHost = if ($LocalOnly) { '127.0.0.1' } else { Get-PrivateBindAddress }
if (-not (Test-Path -LiteralPath $node)) { throw ('Portable Node runtime missing: ' + $node) }
if (-not (Test-Path -LiteralPath $serverScript)) { throw ('Monitor server missing: ' + $serverScript) }
if (-not $bindHost) {
    $bindHost = '127.0.0.1'
    Write-StartLog 'No private IPv4 address was found; binding to localhost only.'
}
& (Join-Path $PSScriptRoot 'ensure-token.ps1') -Root $root | Out-Null
$token = Get-MonitorToken
if ($token.Length -lt 64) { throw 'Access token was not created correctly.' }

$existing = if (Test-Path -LiteralPath $pidPath) { Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json } else { $null }
if ($existing -and $existing.pid) {
    $existingProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$existing.pid) -ErrorAction SilentlyContinue
    if ($existingProcess -and $existingProcess.ExecutablePath -eq $node -and $existingProcess.CommandLine -like ('*' + $serverScript + '*')) {
        $existingProtocol = if ($existing.protocol) { [string]$existing.protocol } else { 'https' }
        $existingHost = if ($existing.bindHost) { [string]$existing.bindHost } else { $bindHost }
        $health = Get-Health -Protocol $existingProtocol -HostName $existingHost -ListenPort ([int]$existing.port) -Token $token
        if ($health -and $health.ok) {
            Write-StartLog ('Monitor already running; PID ' + $existing.pid + '.')
            Write-Output ('Dashboard: ' + $existingProtocol + '://' + $existingHost + ':' + $existing.port + '/')
            if (-not $QuietAccess) { Write-Output ('Android/private access URL: ' + $existingProtocol + '://' + $existingHost + ':' + $existing.port + '/#token=' + $token) }
            Ensure-Supervisor
            exit 0
        }
        Write-StartLog ('Existing exact monitor PID ' + $existing.pid + ' is unhealthy; stopping it before recovery.')
        Stop-Process -Id ([int]$existing.pid) -Force -ErrorAction SilentlyContinue
        for ($wait = 1; $wait -le 10; $wait++) {
            Start-Sleep -Milliseconds 200
            if (-not (Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$existing.pid) -ErrorAction SilentlyContinue)) { break }
        }
    }
}

$unrecorded = @(Get-ExactMonitorProcess)
if ($unrecorded.Count) { throw 'An exact monitor process exists without a healthy PID record. Run STOP before START.' }
$listenPort = Get-AvailablePort -HostName $bindHost -RequestedPort $Port
if ($listenPort -ne $Port) {
    Write-StartLog ('Requested port ' + $Port + ' is unavailable; selected free port ' + $listenPort + '.')
}
& (Join-Path $PSScriptRoot 'ensure-config.ps1') -Root $root -BindHost $bindHost -Port $listenPort | Out-Null
& (Join-Path $PSScriptRoot 'ensure-certificate.ps1') -Root $root -BindHost $bindHost | Out-Null
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$protocol = if ($config.tls.enabled) { 'https' } else { 'http' }
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($stdoutPath, '', $utf8NoBom)
[System.IO.File]::WriteAllText($stderrPath, '', $utf8NoBom)

$process = Start-Process -FilePath $node -ArgumentList @($serverScript, '--config', $configPath) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
Write-StartLog ('Started monitor process PID ' + $process.Id + '.')
$health = $null
for ($attempt = 1; $attempt -le 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    $health = Get-Health -Protocol $protocol -HostName $bindHost -ListenPort $listenPort -Token $token
    if ($health -and $health.ok) { break }
}
if (-not $health -or -not $health.ok) {
    $tail = if (Test-Path -LiteralPath $stderrPath) { (Get-Content -LiteralPath $stderrPath -Tail 20) -join ' | ' } else { 'no stderr log' }
    Write-StartLog ('Startup failed. ' + $tail)
    $check = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $process.Id) -ErrorAction SilentlyContinue
    if ($check -and $check.ExecutablePath -eq $node -and $check.CommandLine -like ('*' + $serverScript + '*')) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    throw ('Dashboard did not become healthy. Inspect ' + $stderrPath)
}

Write-StartLog ('Healthy monitor on ' + $protocol + '://' + $bindHost + ':' + $listenPort + '.')
Write-Output ''
Write-Output 'Codex Multi-Session Monitor is ready.'
Write-Output ('Dashboard: ' + $protocol + '://' + $bindHost + ':' + $listenPort + '/')
if ($bindHost -eq '127.0.0.1') {
    Write-Output 'Android access: unavailable on localhost; run START.ps1 after joining a private LAN or use -LocalOnly only for PC diagnostics.'
} else {
    if (-not $QuietAccess) { Write-Output ('Android/private access URL: ' + $protocol + '://' + $bindHost + ':' + $listenPort + '/#token=' + $token) }
    Write-Output 'Android: connect to the same private Wi-Fi and open the URL above. The certificate is self-signed; accept the one-time browser warning.'
}
Write-Output ('Token file: ' + (Join-Path $root 'config\access.token'))
Write-Output ('Logs: ' + $logRoot)
Ensure-Supervisor
} catch {
    Write-StartLog ('START failed: ' + $_.Exception.Message)
    throw
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
