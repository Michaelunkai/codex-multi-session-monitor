[CmdletBinding()]
param(
    [ValidateSet('Ensure', 'Status', 'Stop')]
    [string]$Action = 'Ensure',
    [int]$MonitorPort = 8766,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tsRoot = Join-Path $root 'runtime\tailscale\PFiles64\Tailscale'
$tailscale = Join-Path $tsRoot 'tailscale.exe'
$tailscaled = Join-Path $tsRoot 'tailscaled.exe'
$stateRoot = Join-Path $root 'data\tailscale'
$stateFile = Join-Path $stateRoot 'tailscaled.state'
$socket = '\\.\pipe\CodexMultiSessionMonitorTailscale'
$stdoutPath = Join-Path $root 'logs\tailscaled.stdout.log'
$stderrPath = Join-Path $root 'logs\tailscaled.stderr.log'
$authStdoutPath = Join-Path $root 'logs\tailscale-auth.stdout.log'
$authStderrPath = Join-Path $root 'logs\tailscale-auth.stderr.log'
$monitorPidPath = Join-Path $root 'data\monitor.pid.json'
$publicUrlPath = Join-Path $stateRoot 'public-url.txt'
$authUrlPath = Join-Path $stateRoot 'auth-url.txt'

foreach ($directory in @($stateRoot, (Join-Path $root 'logs'), (Join-Path $root 'temp'), (Join-Path $root 'cache'))) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
$env:TEMP = Join-Path $root 'temp'
$env:TMP = Join-Path $root 'temp'
$env:XDG_CACHE_HOME = Join-Path $root 'cache'
$env:TS_DEBUG_FIREWALL_MODE = 'auto'

function Write-Message {
    param([string]$Message)
    if (-not $Quiet) { Write-Output $Message }
}

function Test-RequiredFiles {
    foreach ($file in @($tailscale, $tailscaled)) {
        if (-not (Test-Path -LiteralPath $file)) { throw ('Portable Tailscale file is missing: ' + $file) }
    }
}

function Get-ExactProcess {
    param([string]$Executable, [string]$RequiredText)
    @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -eq $Executable -and $_.CommandLine -like ('*' + $RequiredText + '*') })
}

function Invoke-Tailscale {
    param([string[]]$Arguments)
    $commandArguments = @('--socket=' + $socket) + @($Arguments)
    $output = (& $tailscale @commandArguments 2>&1 | Out-String).Trim()
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output }
}

function Get-PreservedPublicUrl {
    if (-not (Test-Path -LiteralPath $publicUrlPath)) { return '' }
    $url = (Get-Content -LiteralPath $publicUrlPath -Raw).Trim().TrimEnd('/')
    if ($url -notmatch '^https://[A-Za-z0-9][A-Za-z0-9.-]*\.ts\.net$') { return '' }
    return $url
}

function Test-PreservedFunnel {
    $url = Get-PreservedPublicUrl
    $tokenPath = Join-Path $root 'config\access.token'
    if (-not $url -or -not (Test-Path -LiteralPath $tokenPath)) { return $false }
    try {
        $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
        if ($token.Length -lt 32) { return $false }
        $response = Invoke-WebRequest -Uri ($url + '/api/liveness') -Headers @{ Authorization = 'Bearer ' + $token } -UseBasicParsing -TimeoutSec 5
        $payload = $response.Content | ConvertFrom-Json
        return [bool]($response.StatusCode -eq 200 -and $payload.ok -and $payload.readOnly)
    } catch {
        return $false
    }
}

function Get-TailscaleJsonStatus {
    $probe = Invoke-Tailscale -Arguments @('status', '--json')
    if ($probe.ExitCode -ne 0 -or -not $probe.Output) { return $null }
    try { return ($probe.Output | ConvertFrom-Json) } catch { return $null }
}

function Wait-ForTailscaleStatus {
    $last = $null
    for ($attempt = 1; $attempt -le 120; $attempt++) {
        $last = Get-TailscaleJsonStatus
        if ($last -and [string]$last.BackendState -in @('Running', 'NeedsLogin', 'NeedsMachineAuth', 'Stopped', 'GoingOffline')) { return $last }
        # Tailscale server-mode state can remain owned by the Windows SID that
        # created it even after the local account is recreated or renamed. In
        # that case the CLI returns 401 although the authenticated cached
        # Funnel is healthy. Prove the real transport instead of reporting a
        # false logout or trying to replace valid persistent state.
        if (($attempt % 4) -eq 0 -and (Test-PreservedFunnel)) {
            return [pscustomobject]@{ BackendState = 'Running'; PreservedFunnel = $true }
        }
        Start-Sleep -Milliseconds 250
    }
    if ($last) { return $last }
    throw 'The private bridge daemon did not return parseable status through its F:-resident socket.'
}

function Ensure-Daemon {
    $matches = @(Get-ExactProcess -Executable $tailscaled -RequiredText ('--socket=' + $socket))
    if ($matches.Count -gt 1) { throw 'More than one project Tailscale daemon was found; refusing to choose ambiguously.' }
    if ($matches.Count -eq 0) {
        $arguments = @(
            '--tun=userspace-networking',
            ('--state=' + $stateFile),
            ('--statedir=' + $stateRoot),
            ('--socket=' + $socket),
            '--no-logs-no-support'
        )
        $process = Start-Process -FilePath $tailscaled -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
        Write-Message ('Private bridge daemon started; PID ' + $process.Id + '.')
    }
    Wait-ForTailscaleStatus | Out-Null
}

function Get-AuthUrl {
    $texts = New-Object System.Collections.Generic.List[string]
    foreach ($file in @($authStdoutPath, $authStderrPath)) {
        if (Test-Path -LiteralPath $file) { $texts.Add((Get-Content -LiteralPath $file -Raw)) }
    }
    $status = Invoke-Tailscale -Arguments @('status')
    $texts.Add($status.Output)
    $match = [regex]::Match(($texts -join [Environment]::NewLine), 'https://login\.tailscale\.com/[A-Za-z0-9/?=_-]+')
    if ($match.Success) {
        [System.IO.File]::WriteAllText($authUrlPath, $match.Value, [System.Text.Encoding]::ASCII)
        return $match.Value
    }
    return ''
}

function Ensure-Auth {
    $authProcesses = @(Get-ExactProcess -Executable $tailscale -RequiredText ('--socket=' + $socket) |
        Where-Object { $_.CommandLine -match '\s(up|login)(\s|$)' })
    if ($authProcesses.Count -gt 1) { throw 'More than one project Tailscale authorization process was found.' }
    if ($authProcesses.Count -eq 0) {
        [System.IO.File]::WriteAllText($authStdoutPath, '', (New-Object System.Text.UTF8Encoding($false)))
        [System.IO.File]::WriteAllText($authStderrPath, '', (New-Object System.Text.UTF8Encoding($false)))
        $arguments = @(
            ('--socket=' + $socket),
            'up',
            '--hostname=codex-monitor',
            '--accept-dns=false',
            '--accept-routes=false',
            '--unattended=true'
        )
        Start-Process -FilePath $tailscale -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $authStdoutPath -RedirectStandardError $authStderrPath | Out-Null
        Start-Sleep -Milliseconds 500
    }
    $url = Get-AuthUrl
    if ($url) {
        Write-Message ('Tailscale authorization required: ' + $url)
    } else {
        Write-Message 'Tailscale authorization is pending. See logs\tailscale-auth.stdout.log.'
    }
}

function Get-PublicUrl {
    $result = Invoke-Tailscale -Arguments @('funnel', 'status')
    $match = [regex]::Match($result.Output, 'https://[A-Za-z0-9][A-Za-z0-9.-]*\.ts\.net(?:/[^\s|]*)?')
    if ($match.Success) {
        $url = $match.Value.TrimEnd('/')
        [System.IO.File]::WriteAllText($publicUrlPath, $url, [System.Text.Encoding]::ASCII)
        return $url
    }
    return ''
}

function Ensure-Funnel {
    if ($MonitorPort -lt 1024 -or $MonitorPort -gt 65500) { throw 'MonitorPort must be between 1024 and 65500.' }
    $monitorHost = '127.0.0.1'
    $monitorProtocol = 'https+insecure'
    if (Test-Path -LiteralPath $monitorPidPath) {
        try {
            $runtime = Get-Content -LiteralPath $monitorPidPath -Raw | ConvertFrom-Json
            if ($runtime.bindHost) { $monitorHost = [string]$runtime.bindHost }
            if ($runtime.protocol -eq 'http') { $monitorProtocol = 'http' }
        } catch { }
    }
    if ($monitorHost -match ':') {
        $target = $monitorProtocol + '://[' + $monitorHost + ']:' + $MonitorPort
    } else {
        $target = $monitorProtocol + '://' + $monitorHost + ':' + $MonitorPort
    }
    $configured = Invoke-Tailscale -Arguments @('funnel', '--bg', $target)
    if ($configured.ExitCode -ne 0) {
        throw ('Tailscale Funnel configuration failed: ' + $configured.Output)
    }
    $url = Get-PublicUrl
    if (-not $url) { throw 'Tailscale Funnel was configured but did not return a stable ts.net URL.' }
    Write-Message ('Private HTTPS bridge: ' + $url)
    return $url
}

function Stop-Bridge {
    $authProcesses = @(Get-ExactProcess -Executable $tailscale -RequiredText ('--socket=' + $socket))
    foreach ($process in $authProcesses) {
        Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
    }
    $daemonProcesses = @(Get-ExactProcess -Executable $tailscaled -RequiredText ('--socket=' + $socket))
    if ($daemonProcesses.Count -gt 1) { throw 'More than one project Tailscale daemon was found; refusing to stop ambiguously.' }
    foreach ($process in $daemonProcesses) {
        Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
        for ($attempt = 1; $attempt -le 20; $attempt++) {
            Start-Sleep -Milliseconds 200
            if (-not (Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$process.ProcessId) -ErrorAction SilentlyContinue)) { break }
        }
        if (Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$process.ProcessId) -ErrorAction SilentlyContinue) {
            throw ('Project Tailscale daemon PID ' + $process.ProcessId + ' did not stop.')
        }
        Write-Message ('Private bridge daemon stopped; PID ' + $process.ProcessId + '.')
    }
}

Test-RequiredFiles
switch ($Action) {
    'Stop' {
        Stop-Bridge
        break
    }
    'Status' {
        $daemon = @(Get-ExactProcess -Executable $tailscaled -RequiredText ('--socket=' + $socket))
        $status = if ($daemon.Count -eq 1) { Get-TailscaleJsonStatus } else { $null }
        $loggedIn = [bool]($status -and [string]$status.BackendState -eq 'Running')
        if (-not $loggedIn -and $daemon.Count -eq 1) { $loggedIn = Test-PreservedFunnel }
        $publicUrl = if (Test-Path -LiteralPath $publicUrlPath) { (Get-Content -LiteralPath $publicUrlPath -Raw).Trim() } else { '' }
        [pscustomobject]@{
            Daemon = [bool]($daemon.Count -eq 1)
            LoggedIn = [bool]$loggedIn
            FunnelUrl = $publicUrl
            AuthUrl = if (-not $loggedIn) { Get-AuthUrl } else { '' }
        } | ConvertTo-Json -Compress
        break
    }
    'Ensure' {
        Ensure-Daemon
        $status = Wait-ForTailscaleStatus
        if ([string]$status.BackendState -ne 'Running') {
            Ensure-Auth
            break
        }
        if ($status.PSObject.Properties['PreservedFunnel'] -and $status.PreservedFunnel) {
            Write-Message ('Private HTTPS bridge: ' + (Get-PreservedPublicUrl) + ' (preserved authenticated route verified)')
            break
        }
        if ($MonitorPort) { Ensure-Funnel }
        break
    }
}
