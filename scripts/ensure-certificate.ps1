[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [Parameter(Mandatory = $true)]
    [string]$BindHost,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$tlsRoot = Join-Path $Root 'config\tls'
$keyPath = Join-Path $tlsRoot 'server-key.pem'
$certPath = Join-Path $tlsRoot 'server-cert.pem'
$bindHostPath = Join-Path $tlsRoot 'server-cert.bind-host'
New-Item -ItemType Directory -Path $tlsRoot -Force | Out-Null
 $existingBindHost = if (Test-Path -LiteralPath $bindHostPath) { (Get-Content -LiteralPath $bindHostPath -Raw).Trim() } else { '' }
if ((Test-Path -LiteralPath $keyPath) -and (Test-Path -LiteralPath $certPath) -and $existingBindHost -eq $BindHost -and -not $Force) {
    Write-Output 'TLS certificate already exists.'
    exit 0
}

function ConvertTo-Pem {
    param(
        [byte[]]$Bytes,
        [string]$Label
    )
    $base64 = [Convert]::ToBase64String($Bytes)
    $lines = New-Object System.Collections.Generic.List[string]
    for ($offset = 0; $offset -lt $base64.Length; $offset += 64) {
        $length = [Math]::Min(64, $base64.Length - $offset)
        $lines.Add($base64.Substring($offset, $length))
    }
    return ((@('-----BEGIN ' + $Label + '-----') + $lines.ToArray() + @('-----END ' + $Label + '-----')) -join [Environment]::NewLine) + [Environment]::NewLine
}

$rsa = [System.Security.Cryptography.RSA]::Create(2048)
try {
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
        'CN=Codex Multi-Session Monitor',
        $rsa,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $sanBuilder = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $sanBuilder.AddDnsName('localhost')
    $sanBuilder.AddIpAddress([System.Net.IPAddress]::Parse('127.0.0.1'))
    $bindIp = $null
    if ([System.Net.IPAddress]::TryParse($BindHost, [ref]$bindIp) -and $bindIp.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
        $sanBuilder.AddIpAddress($bindIp)
    }
    $request.CertificateExtensions.Add($sanBuilder.Build())
    $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
    $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature, $true))
    $certificate = $request.CreateSelfSigned([DateTimeOffset]::Now.AddMinutes(-5), [DateTimeOffset]::Now.AddYears(2))
    [System.IO.File]::WriteAllText($certPath, (ConvertTo-Pem -Bytes $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert) -Label 'CERTIFICATE'), [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText($keyPath, (ConvertTo-Pem -Bytes $rsa.ExportPkcs8PrivateKey() -Label 'PRIVATE KEY'), [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText($bindHostPath, $BindHost, (New-Object System.Text.UTF8Encoding($false)))
    $certificate.Dispose()
} finally {
    $rsa.Dispose()
}

try {
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($currentSid, 'FullControl', 'Allow')))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, 'FullControl', 'Allow')))
    Set-Acl -LiteralPath $keyPath -AclObject $acl
} catch {
    Write-Warning ('Could not tighten TLS key ACL; the key remains under the project root. ' + $_.Exception.Message)
}

Write-Output ('Self-signed TLS certificate generated for localhost and ' + $BindHost + '.')
