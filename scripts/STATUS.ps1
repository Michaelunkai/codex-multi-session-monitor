[CmdletBinding()]
param(
    [switch]$ShowAccessUrl
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config\monitor.json'
$pidPath = Join-Path $root 'data\monitor.pid.json'
$tokenPath = Join-Path $root 'config\access.token'
$publicUrlPath = Join-Path $root 'data\tailscale\public-url.txt'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Monitor configuration is missing. Run START.ps1.' }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$token = if (Test-Path -LiteralPath $tokenPath) { (Get-Content -LiteralPath $tokenPath -Raw).Trim() } else { '' }
$protocol = if ($config.tls.enabled) { 'https' } else { 'http' }
$runtime = if (Test-Path -LiteralPath $pidPath) { Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json } else { $null }
$node = Join-Path $root 'runtime\node\node.exe'
$serverScript = Join-Path $root 'app\server.js'
$process = if ($runtime -and $runtime.pid) { Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$runtime.pid) -ErrorAction SilentlyContinue } else { $null }
$exact = $process -and $process.ExecutablePath -eq $node -and $process.CommandLine -like ('*' + $serverScript + '*')
$health = $null
if ($exact) {
    $healthUrl = $protocol + '://' + $config.bindHost + ':' + [int]$runtime.port + '/api/health?token=' + [Uri]::EscapeDataString($token)
    try { $health = (Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -SkipCertificateCheck -TimeoutSec 3).Content | ConvertFrom-Json } catch {}
}
$addressPort = if ($runtime -and $runtime.port) { [int]$runtime.port } else { [int]$config.port }
$supervisorLock = Join-Path $root 'data\supervisor.lock'
$supervisorRunning = $false
if (Test-Path -LiteralPath $supervisorLock) {
    $supervisorId = 0
    if ([int]::TryParse((Get-Content $supervisorLock -Raw).Trim(), [ref]$supervisorId)) {
        $sp = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $supervisorId) -ErrorAction SilentlyContinue
        $supervisorRunning = [bool]($sp -and $sp.ExecutablePath -eq $node -and $sp.CommandLine -like ('*' + (Join-Path $root 'scripts\supervisor.js') + '*'))
    }
}
$bridgeStatus = $null
try {
    $bridgeJson = & (Join-Path $PSScriptRoot 'tailscale.ps1') -Action Status 2>$null
    if ($bridgeJson) { $bridgeStatus = ($bridgeJson | ConvertFrom-Json) }
} catch {}
[pscustomobject]@{
    Running = [bool]$exact
    Supervisor = $supervisorRunning
    Healthy = [bool]($health -and $health.ok)
    PID = if ($exact) { [int]$runtime.pid } else { $null }
    Address = $protocol + '://' + $config.bindHost + ':' + $addressPort + '/'
    LocalPcAccess = if ($exact) { 'automatic; open Address on this PC' } else { 'unavailable' }
    Scope = if ($config.bindHost -eq '127.0.0.1') { 'localhost only' } else { 'private LAN address' }
    DiscoveredSessions = if ($health) { [int]$health.summary.totalNonArchived } else { $null }
    RunningSessions = if ($health) { [int]$health.summary.runningCount } else { $null }
    LiveOutputSessions = if ($health) { [int]$health.summary.runningCount } else { $null }
    HiddenHistory = if ($health) { [int]$health.summary.hiddenNonRunningCount } else { $null }
    LiveWindowSeconds = if ($health) { [int]$health.summary.liveWindowSeconds } else { $null }
    OutputTransport = if ($health) { [string]$health.summary.outputTransport } else { $null }
    TelemetryErrors = if ($health) { [int]$health.summary.telemetryErrorCount } else { $null }
    ReadErrors = if ($health) { ($health.summary.readErrors -join ' | ') } else { 'health unavailable' }
    PrivateBridgeDaemon = if ($bridgeStatus) { [bool]$bridgeStatus.Daemon } else { $false }
    PrivateBridgeLoggedIn = if ($bridgeStatus) { [bool]$bridgeStatus.LoggedIn } else { $false }
    PrivateBridgeUrl = if ($bridgeStatus) { [string]$bridgeStatus.FunnelUrl } else { '' }
    PrivateBridgeAuthUrl = if ($bridgeStatus) { [string]$bridgeStatus.AuthUrl } else { '' }
} | Format-List
if ($ShowAccessUrl -and $exact) {
    $publicEndpoint = if (Test-Path -LiteralPath $publicUrlPath) { (Get-Content -LiteralPath $publicUrlPath -Raw).Trim() } else { '' }
    if ($publicEndpoint) {
        Write-Output ('Hosted access URL: https://michaelunkai.github.io/codex-multi-session-monitor-pages/#token=' + $token + '&endpoint=' + [Uri]::EscapeDataString($publicEndpoint))
    } else {
        Write-Output ('Local access URL: ' + $protocol + '://' + $config.bindHost + ':' + [int]$runtime.port + '/#token=' + $token)
    }
}
