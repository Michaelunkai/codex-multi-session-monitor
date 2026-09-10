Option Explicit

Dim shell, fso, root, powershell, startScript, command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
powershell = root & "\runtime\powershell\pwsh.exe"
startScript = root & "\scripts\START.ps1"

If Not fso.FileExists(powershell) Or Not fso.FileExists(startScript) Then
  WScript.Quit 2
End If

command = Chr(34) & powershell & Chr(34) & " -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Chr(34) & startScript & Chr(34) & " -QuietAccess"
shell.Run command, 0, False
