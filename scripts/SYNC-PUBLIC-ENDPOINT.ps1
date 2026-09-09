[CmdletBinding()]
param(
    [string]$PublicEndpoint
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$publicUrlPath = Join-Path $root 'data\tailscale\public-url.txt'
if (-not $PublicEndpoint) {
    if (-not (Test-Path -LiteralPath $publicUrlPath)) { throw 'No stable private-bridge URL is recorded yet.' }
    $PublicEndpoint = (Get-Content -LiteralPath $publicUrlPath -Raw).Trim()
}
$parsed = $null
if (-not [Uri]::TryCreate($PublicEndpoint, [UriKind]::Absolute, [ref]$parsed) -or $parsed.Scheme -ne 'https' -or $parsed.Host -notmatch '\.ts\.net$') {
    throw 'PublicEndpoint must be an HTTPS *.ts.net origin.'
}
$endpoint = $parsed.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
$files = @(
    (Join-Path $root 'app\public\index.html'),
    (Join-Path $root 'deploy\index.html'),
    (Join-Path $root 'public-site\index.html')
)
foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath $file)) { continue }
    $html = Get-Content -LiteralPath $file -Raw
    $replacement = '<meta name="codex-monitor-share-endpoint" content="' + $endpoint + '">'
    if ($html -match '<meta name="codex-monitor-share-endpoint"[^>]*>') {
        $html = [regex]::Replace($html, '<meta name="codex-monitor-share-endpoint"[^>]*>', [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $replacement }, 1)
    } else {
        $html = $html.Replace('<meta name="codex-monitor-deploy-url"', $replacement + [Environment]::NewLine + '  <meta name="codex-monitor-deploy-url"')
    }
    if ($file -like '*deploy\index.html' -or $file -like '*public-site\index.html') {
        $html = [regex]::Replace($html, '<meta name="codex-monitor-endpoint"[^>]*>', '<meta name="codex-monitor-endpoint" content="' + $endpoint + '">', 1)
    }
    [System.IO.File]::WriteAllText($file, $html, (New-Object System.Text.UTF8Encoding($false)))
}
Write-Output ('Published endpoint synchronized: ' + $endpoint)
