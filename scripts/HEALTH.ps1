[CmdletBinding()]
param()

$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config\monitor.json'
$pidPath = Join-Path $root 'data\monitor.pid.json'
& (Join-Path $PSScriptRoot 'STATUS.ps1')
if (-not (Test-Path -LiteralPath $configPath)) { exit 2 }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$runtime = if (Test-Path -LiteralPath $pidPath) { Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json } else { $null }
if (-not $runtime -or -not $runtime.pid) { Write-Output 'Health probe failed: no runtime PID.'; exit 2 }
$node = Join-Path $root 'runtime\node\node.exe'
$serverScript = Join-Path $root 'app\server.js'
$process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$runtime.pid) -ErrorAction SilentlyContinue
if (-not ($process -and $process.ExecutablePath -eq $node -and $process.CommandLine -like ('*' + $serverScript + '*'))) {
    Write-Output 'Health probe failed: runtime PID is not the exact F:-resident monitor.'
    exit 2
}
$tokenPath = Join-Path $root 'config\access.token'
$token = if (Test-Path -LiteralPath $tokenPath) { (Get-Content -LiteralPath $tokenPath -Raw).Trim() } else { '' }
$protocol = if ($config.tls.enabled) { 'https' } else { 'http' }
$healthUrl = $protocol + '://' + $runtime.bindHost + ':' + [int]$runtime.port + '/api/health?token=' + [Uri]::EscapeDataString($token)
try {
    $health = (Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -SkipCertificateCheck -TimeoutSec 3).Content | ConvertFrom-Json
    if ($health.ok) {
        Write-Output ('Health probe passed: ' + $health.summary.runningCount + ' running sessions; running-only=' + $health.summary.displayMode + '; read-only=' + $health.summary.readOnly + '.')
        exit 0
    }
    Write-Output 'Health probe failed: server reported degraded telemetry.'
    exit 2
} catch {
    Write-Output ('Health probe failed: ' + $_.Exception.Message)
    exit 2
}
