[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runKey = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run'
$valueName = 'Codex-MultiSession-Monitor'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$cscript = Join-Path $env:WINDIR 'System32\cscript.exe'
$launcher = Join-Path $PSScriptRoot 'AUTOSTART.vbs'
$legacyTaskFile = Join-Path $root 'config\autostart-task.xml'
$receiptFile = Join-Path $root 'config\autostart-run.json'

if (-not (Test-Path -LiteralPath $wscript)) { throw ('Windows Script Host missing: ' + $wscript) }
if (-not (Test-Path -LiteralPath $cscript)) { throw ('Windows Script Host console runner missing: ' + $cscript) }
if (-not (Test-Path -LiteralPath $launcher)) { throw ('Detached automatic-start launcher missing: ' + $launcher) }

function Remove-ProjectLegacyTask {
    $scheduler = Join-Path $env:WINDIR 'System32\schtasks.exe'
    $taskXml = @(& $scheduler /Query /TN $valueName /XML 2>$null) -join [Environment]::NewLine
    if ($LASTEXITCODE -ne 0) { return }
    if ($taskXml -notmatch [regex]::Escape($root)) {
        throw 'A same-named scheduled task is not owned by this project; refusing to remove it.'
    }
    & $scheduler /End /TN $valueName 2>$null | Out-Null
    & $scheduler /Delete /TN $valueName /F 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not remove the project-owned legacy scheduled task.' }
}

$command = '"' + $wscript + '" //B //Nologo "' + $launcher + '"'
New-Item -Path $runKey -Force | Out-Null
New-ItemProperty -Path $runKey -Name $valueName -PropertyType String -Value $command -Force | Out-Null

Remove-ProjectLegacyTask
if (Test-Path -LiteralPath $legacyTaskFile) { Remove-Item -LiteralPath $legacyTaskFile -Force }
$receipt = [pscustomobject]@{
    registryPath = 'HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run'
    valueName = $valueName
    command = $command
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
}
[IO.File]::WriteAllText($receiptFile, ($receipt | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))

& $cscript //Nologo $launcher
if ($LASTEXITCODE -ne 0) { throw 'Automatic-start registration succeeded but the detached launcher did not start.' }

$statusScript = Join-Path $PSScriptRoot 'STATUS.ps1'
$ready = $false
for ($attempt = 1; $attempt -le 45; $attempt++) {
    $status = @(& (Join-Path $root 'runtime\powershell\pwsh.exe') -NoLogo -NoProfile -File $statusScript 2>&1) -join [Environment]::NewLine
    if ($status -match 'Running\s*:\s*True' -and $status -match 'Supervisor\s*:\s*True' -and $status -match 'PrivateBridgeLoggedIn\s*:\s*True') {
        $ready = $true
        break
    }
    Start-Sleep -Seconds 1
}
if (-not $ready) { throw 'Automatic-start registration succeeded but the detached monitor stack did not become healthy.' }
Write-Output 'Automatic startup is registered in the current-user Run key and launches the F:-resident detached START wrapper.'
