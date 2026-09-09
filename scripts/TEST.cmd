@echo off
setlocal
call "%~dp0ENV.cmd"
"%~dp0..\runtime\node\node.exe" --test "%~dp0..\tests\adapter.test.js" "%~dp0..\tests\deploy.test.js" "%~dp0..\tests\live-telemetry.test.js" "%~dp0..\tests\live-update.test.js" "%~dp0..\tests\ui.test.js"
exit /b %ERRORLEVEL%
