[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Destination,

    [switch]$Force
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationPath) {
    if (-not $Force) {
        throw "Destination already exists: $destinationPath"
    }
    Remove-Item -LiteralPath $destinationPath -Force
}
New-Item -ItemType Directory -Force (Split-Path $destinationPath -Parent) | Out-Null

$staging = Join-Path $env:TEMP ("sealed-delegation-package-" + [guid]::NewGuid().ToString("N"))
try {
    New-Item -ItemType Directory -Force $staging | Out-Null
    $files = Get-ChildItem -LiteralPath $root -Recurse -File |
        Where-Object {
            $_.FullName -notmatch "[\\/]\.git[\\/]" -and
            $_.FullName -notmatch "[\\/]results[\\/]" -and
            $_.Extension -ne ".zip"
        }
    foreach ($file in $files) {
        $relative = [IO.Path]::GetRelativePath($root, $file.FullName)
        $target = Join-Path $staging $relative
        New-Item -ItemType Directory -Force (Split-Path $target -Parent) | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $target
    }

    $manifestFiles = Get-ChildItem -LiteralPath $staging -Recurse -File |
        Sort-Object FullName |
        ForEach-Object {
            [ordered]@{
                path = [IO.Path]::GetRelativePath($staging, $_.FullName).Replace("\", "/")
                size_bytes = $_.Length
                sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
    [ordered]@{
        schema_version = "sealed-delegation/test-package/v1"
        created_at = (Get-Date).ToUniversalTime().ToString("o")
        files = @($manifestFiles)
    } | ConvertTo-Json -Depth 5 |
        Set-Content (Join-Path $staging "MANIFEST.json") -Encoding utf8

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory(
        $staging,
        $destinationPath,
        [IO.Compression.CompressionLevel]::Optimal,
        $false
    )

    [pscustomobject]@{
        status = "CREATED"
        path = $destinationPath
        size_bytes = (Get-Item -LiteralPath $destinationPath).Length
        sha256 = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash.ToLowerInvariant()
        file_count = @($manifestFiles).Count + 1
    } | ConvertTo-Json
} finally {
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
}
