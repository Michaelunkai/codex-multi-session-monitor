$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$files=@(Get-ChildItem -LiteralPath $root -File -Recurse -Force)
$links=@(Get-ChildItem -LiteralPath $root -Recurse -Force | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint})
$checks=@()
foreach($base in @('C:\Users\micha\AppData\Local','C:\Users\micha\AppData\Roaming','C:\Users\micha\AppData\Local\Temp','C:\ProgramData')){
 $hits=@(Get-ChildItem -LiteralPath $base -Force -ErrorAction SilentlyContinue | Where-Object {$_.Name -match 'Codex-MultiSession-Monitor|agentsview|CodexMonitorHUD'})
 $checks += [pscustomobject]@{Directory=$base;ProjectNamedResidues=$hits.Count;Paths=@($hits.FullName)}
}
$drive=[IO.DriveInfo]::new('F:\')
$acl=Get-Acl (Join-Path $root 'config\access.token')
$keyAcl=Get-Acl (Join-Path $root 'config\tls\server-key.pem')
$report=[pscustomobject]@{CheckedAt=(Get-Date -Format o);Root=$root;FileCount=$files.Count;TotalBytes=($files|Measure-Object Length -Sum).Sum;Filesystem=$drive.DriveFormat;FreeBytes=$drive.AvailableFreeSpace;ReparsePoints=$links.Count;CResidueChecks=$checks;TokenAcl=$acl.AccessToString;PrivateKeyAcl=$keyAcl.AccessToString;ControlledOSRegistration='Windows scheduled task Codex-MultiSession-Monitor; definition exported under config';Caveat='Targeted residue scan; no claim of zero OS, Codex, browser, or tooling writes outside F:. Existing npm directories preserved.'}
$report|ConvertTo-Json -Depth 5|Set-Content (Join-Path $root 'logs\storage-audit.json') -Encoding utf8NoBOM
$report|Format-List
