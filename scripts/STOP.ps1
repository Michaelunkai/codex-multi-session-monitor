[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
[IO.File]::WriteAllText((Join-Path $root 'data\stop.request'), (Get-Date -Format o))
$node = Join-Path $root 'runtime\node\codex-monitor-node.exe'
$serverScript = Join-Path $root 'app\server.js'
$pidPath = Join-Path $root 'data\monitor.pid.json'
$supervisorScript = Join-Path $PSScriptRoot 'supervisor.js'
$supervisorLock = Join-Path $root 'data\supervisor.lock'
$supervisorReceipt = Join-Path $root 'data\supervisor.pid.json'
$supervisorMatches = @()
if (Test-Path -LiteralPath $supervisorLock) {
    $supervisorId = 0
    if ([int]::TryParse((Get-Content $supervisorLock -Raw).Trim(), [ref]$supervisorId)) {
        $supervisorCandidate = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $supervisorId) -ErrorAction SilentlyContinue
        if ($supervisorCandidate -and $supervisorCandidate.ExecutablePath -eq $node -and $supervisorCandidate.CommandLine -like ('*' + $supervisorScript + '*')) { $supervisorMatches = @($supervisorCandidate) }
    }
}
if ($supervisorMatches.Count -eq 0) {
    $supervisorMatches = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $node -and $_.CommandLine -like ('*' + $supervisorScript + '*') })
}
if ($supervisorMatches.Count -gt 1) { throw 'More than one exact supervisor process was found; refusing to stop ambiguously.' }
if ($supervisorMatches.Count -eq 1) {
    $supervisorTargetPid = [int]$supervisorMatches[0].ProcessId
    Stop-Process -Id $supervisorTargetPid -Force
    for ($attempt = 1; $attempt -le 20; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (-not (Get-Process -Id $supervisorTargetPid -ErrorAction SilentlyContinue)) { break }
    }
    if (Get-Process -Id $supervisorTargetPid -ErrorAction SilentlyContinue) { throw ('Supervisor PID ' + $supervisorTargetPid + ' did not stop.') }
    Remove-Item -LiteralPath $supervisorLock -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $supervisorReceipt -Force -ErrorAction SilentlyContinue
    Write-Output ('Supervisor stopped. PID ' + $supervisorTargetPid + ' was the exact F:-resident supervisor process.')
}
$matches = @()
if (Test-Path -LiteralPath $pidPath) {
    $record = Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json
    if ($record.pid) {
        $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$record.pid) -ErrorAction SilentlyContinue
        if ($candidate -and $candidate.ExecutablePath -eq $node -and $candidate.CommandLine -like ('*' + $serverScript + '*')) { $matches = @($candidate) }
    }
}
if ($matches.Count -eq 0) {
    $matches = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $node -and $_.CommandLine -like ('*' + $serverScript + '*') })
}
if ($matches.Count -eq 0) {
    Write-Output 'Monitor is not running.'
    & (Join-Path $PSScriptRoot 'tailscale.ps1') -Action Stop
    exit 0
}
if ($matches.Count -gt 1) { throw 'More than one exact monitor process was found; refusing to stop ambiguously.' }
$targetPid = [int]$matches[0].ProcessId
Stop-Process -Id $targetPid -Force
for ($attempt = 1; $attempt -le 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) { break }
}
if (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) { throw ('Monitor PID ' + $targetPid + ' did not stop.') }
[System.IO.File]::WriteAllText($pidPath, '{}', [System.Text.Encoding]::UTF8)
Write-Output ('Monitor stopped. PID ' + $targetPid + ' was the exact F:-resident monitor process.')
& (Join-Path $PSScriptRoot 'tailscale.ps1') -Action Stop
