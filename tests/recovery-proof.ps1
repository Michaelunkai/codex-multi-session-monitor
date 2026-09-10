$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$runtimePath=Join-Path $root 'data\monitor.pid.json'
$node=Join-Path $root 'runtime\node\codex-monitor-node.exe'
$before=Get-Content $runtimePath -Raw | ConvertFrom-Json
$proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$before.pid)
if($proc.ExecutablePath -ne $node -or $proc.CommandLine -notlike ('*'+(Join-Path $root 'app\server.js')+'*')){throw 'Refuse to crash a process not belonging to this project.'}
$codexBefore=@(Get-Process ChatGPT,codex -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id | Sort-Object)
Stop-Process -Id ([int]$before.pid) -Force
$recovered=$false
for($i=0;$i -lt 45;$i++){
 Start-Sleep -Seconds 1
 try{
  $after=Get-Content $runtimePath -Raw | ConvertFrom-Json
  if($after.pid -and $after.pid -ne $before.pid){
   $cfg=Get-Content (Join-Path $root 'config\monitor.json') -Raw | ConvertFrom-Json
   $token=(Get-Content $cfg.auth.tokenFile -Raw).Trim()
   $protocol=if($cfg.tls.enabled){'https'}else{'http'}
   $h=Invoke-RestMethod ($protocol+'://'+$after.bindHost+':'+$after.port+'/api/health') -Headers @{Authorization='Bearer '+$token} -SkipCertificateCheck -TimeoutSec 3
   if($h.ok){$recovered=$true;break}
  }
 }catch{}
}
$codexAfter=@(Get-Process ChatGPT,codex -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id | Sort-Object)
$report=[pscustomobject]@{CheckedAt=(Get-Date -Format o);CrashRecovery=$recovered;BeforePID=$before.pid;AfterPID=$after.pid;Seconds=$i+1;CodexProcessesBefore=$codexBefore;CodexProcessesAfter=$codexAfter;CodexPidsUnchanged=(($codexBefore -join ',') -eq ($codexAfter -join ','))}
$report | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $root 'logs\recovery-proof.json') -Encoding utf8NoBOM
$report | Format-List
if(-not $recovered){exit 1}
