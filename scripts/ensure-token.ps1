[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Root
)

$ErrorActionPreference = 'Stop'
$configRoot = Join-Path $Root 'config'
$tokenPath = Join-Path $configRoot 'access.token'
New-Item -ItemType Directory -Path $configRoot -Force | Out-Null

$existing = if (Test-Path -LiteralPath $tokenPath) { (Get-Content -LiteralPath $tokenPath -Raw).Trim() } else { '' }
if ($existing.Length -ge 64) {
    Write-Output 'Access token already exists.'
    exit 0
}

$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$token = [Convert]::ToHexString($bytes).ToLowerInvariant()
[System.IO.File]::WriteAllText($tokenPath, $token, [System.Text.Encoding]::ASCII)

try {
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($currentSid, 'FullControl', 'Allow')))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, 'FullControl', 'Allow')))
    Set-Acl -LiteralPath $tokenPath -AclObject $acl
} catch {
    Write-Warning ('Could not tighten token ACL; the file remains under the project root. ' + $_.Exception.Message)
}

Write-Output 'Access token generated under the project config directory.'
