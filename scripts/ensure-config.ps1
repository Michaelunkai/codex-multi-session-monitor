[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [Parameter(Mandatory = $true)]
    [string]$BindHost,
    [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
$configRoot = Join-Path $Root 'config'
$configPath = Join-Path $configRoot 'monitor.json'
$templatePath = Join-Path $configRoot 'monitor.template.json'
New-Item -ItemType Directory -Path $configRoot -Force | Out-Null

$profileRoot = [Environment]::GetFolderPath('UserProfile')
$codexHome = Join-Path $profileRoot '.codex'
$stateDb = Join-Path $codexHome 'state_5.sqlite'
$historyDb = Join-Path $codexHome 'thread_history_1.sqlite'
$sessionIndex = Join-Path $codexHome 'session_index.jsonl'
foreach ($requiredPath in @($stateDb, $historyDb, $sessionIndex)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw ('Required existing Codex telemetry path is missing: ' + $requiredPath)
    }
}

$config = if (Test-Path -LiteralPath $configPath) {
    Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
} elseif (Test-Path -LiteralPath $templatePath) {
    Get-Content -LiteralPath $templatePath -Raw | ConvertFrom-Json
} else {
    [pscustomobject]@{}
}

if (-not $config.PSObject.Properties['paths']) { $config | Add-Member -NotePropertyName paths -NotePropertyValue ([pscustomobject]@{}) }
if (-not $config.PSObject.Properties['auth']) { $config | Add-Member -NotePropertyName auth -NotePropertyValue ([pscustomobject]@{}) }
if (-not $config.PSObject.Properties['tls']) { $config | Add-Member -NotePropertyName tls -NotePropertyValue ([pscustomobject]@{}) }
$config.bindHost = $BindHost
$config.port = $Port
$config.paths.stateDb = $stateDb
$config.paths.historyDb = $historyDb
$config.paths.sessionIndex = $sessionIndex
$config.auth.required = $true
$config.auth.tokenFile = Join-Path $configRoot 'access.token'
$config.tls.enabled = ($BindHost -ne '127.0.0.1')
$config.tls.keyFile = Join-Path $configRoot 'tls\server-key.pem'
$config.tls.certFile = Join-Path $configRoot 'tls\server-cert.pem'

$json = $config | ConvertTo-Json -Depth 8
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($configPath, $json, $utf8NoBom)
Write-Output ('Configuration ready: ' + $configPath)
