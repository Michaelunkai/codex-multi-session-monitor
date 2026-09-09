$scheduler=Join-Path $env:WINDIR 'System32\schtasks.exe'
& $scheduler /End /TN 'Codex-MultiSession-Monitor'
& $scheduler /Delete /TN 'Codex-MultiSession-Monitor' /F
if($LASTEXITCODE -ne 0){throw 'Task removal failed or task was already absent.'}
