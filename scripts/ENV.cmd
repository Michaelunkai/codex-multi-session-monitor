@echo off
set "TEMP=%~dp0..\temp"
set "TMP=%~dp0..\temp"
set "PSModuleAnalysisCachePath=%~dp0..\cache\powershell-analysis"
set "POWERSHELL_TELEMETRY_OPTOUT=1"
set "XDG_CACHE_HOME=%~dp0..\cache"
set "NPM_CONFIG_CACHE=%~dp0..\cache\npm"
set "NPM_CONFIG_PREFIX=%~dp0..\runtime\npm-global"
