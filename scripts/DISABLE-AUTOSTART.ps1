[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runKey = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run'
$valueName = 'Codex-MultiSession-Monitor'
$receiptFile = Join-Path $root 'config\autostart-run.json'
$legacyTaskFile = Join-Path $root 'config\autostart-task.xml'

if (Test-Path -LiteralPath $runKey) {
    Remove-ItemProperty -LiteralPath $runKey -Name $valueName -Force -ErrorAction SilentlyContinue
}

$scheduler = Join-Path $env:WINDIR 'System32\schtasks.exe'
$taskXml = @(& $scheduler /Query /TN $valueName /XML 2>$null) -join [Environment]::NewLine
if ($LASTEXITCODE -eq 0) {
    if ($taskXml -notmatch [regex]::Escape($root)) {
        throw 'A same-named scheduled task is not owned by this project; refusing to remove it.'
    }
    & $scheduler /End /TN $valueName 2>$null | Out-Null
    & $scheduler /Delete /TN $valueName /F 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not remove the project-owned legacy scheduled task.' }
}
if (Test-Path -LiteralPath $receiptFile) { Remove-Item -LiteralPath $receiptFile -Force }
if (Test-Path -LiteralPath $legacyTaskFile) { Remove-Item -LiteralPath $legacyTaskFile -Force }
Write-Output 'Automatic startup was removed. The current monitor, if running, was left untouched.'
