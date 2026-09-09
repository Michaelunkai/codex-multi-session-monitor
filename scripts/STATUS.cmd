@echo off
setlocal
call "%~dp0ENV.cmd"
"%~dp0..\runtime\powershell\pwsh.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0STATUS.ps1" %*
exit /b %ERRORLEVEL%
