[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$node=Join-Path $root 'runtime\node\node.exe'
$supervisor=Join-Path $PSScriptRoot 'supervisor.js'
$xmlPath=Join-Path $root 'config\autostart-task.xml'
$xml=@"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Private read-only Codex dashboard. All software and logs are on F:. Remove with DISABLE-AUTOSTART.ps1.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>$sid</UserId><Delay>PT30S</Delay></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>$sid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
  <Actions Context="Author"><Exec><Command>$node</Command><Arguments>&quot;$supervisor&quot; --logon</Arguments><WorkingDirectory>$root</WorkingDirectory></Exec></Actions>
</Task>
"@
[IO.File]::WriteAllText($xmlPath,$xml,[Text.Encoding]::Unicode)
$scheduler=Join-Path $env:WINDIR 'System32\schtasks.exe'
& $scheduler /Create /TN 'Codex-MultiSession-Monitor' /XML $xmlPath /F
if($LASTEXITCODE -ne 0){throw 'Task registration failed.'}
& $scheduler /Run /TN 'Codex-MultiSession-Monitor'
if($LASTEXITCODE -ne 0){throw 'Registered task could not start.'}
