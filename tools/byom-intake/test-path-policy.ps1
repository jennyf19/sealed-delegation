#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "path-policy.ps1")

$temporary = Join-Path $env:TEMP ("byom-path-policy-" + [guid]::NewGuid().ToString("N"))
try {
    $allowed = Join-Path $temporary "allowed"
    $outside = Join-Path $temporary "outside"
    New-Item -ItemType Directory -Force $allowed, $outside | Out-Null

    $safe = Resolve-SafeByomPath -BaseRoot $allowed -RelativePath "candidate\model" -Label "output" -TrustedRoot $temporary
    if (-not $safe.StartsWith($allowed, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Safe path did not remain under the allowed root."
    }

    $failed = $false
    try {
        Resolve-SafeByomPath -BaseRoot $allowed -RelativePath "..\outside" -Label "output" -TrustedRoot $temporary | Out-Null
    } catch {
        $failed = $_.Exception.Message -match "must resolve beneath"
    }
    if (-not $failed) { throw "Parent traversal was not rejected." }

    $junction = Join-Path $allowed "redirect"
    New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
    $failed = $false
    try {
        Resolve-SafeByomPath -BaseRoot $allowed -RelativePath "redirect\model" -Label "output" -TrustedRoot $temporary | Out-Null
    } catch {
        $failed = $_.Exception.Message -match "reparse point"
    }
    if (-not $failed) { throw "Junction traversal was not rejected." }

    $junctionRoot = Join-Path $temporary "junction-root"
    New-Item -ItemType Junction -Path $junctionRoot -Target $outside | Out-Null
    $failed = $false
    try {
        Resolve-SafeByomPath -BaseRoot $junctionRoot -RelativePath "model" -Label "output" -TrustedRoot $temporary | Out-Null
    } catch {
        $failed = $_.Exception.Message -match "reparse point"
    }
    if (-not $failed) { throw "Junction base root was not rejected." }

    $ancestorRoot = Join-Path $temporary "repo"
    New-Item -ItemType Directory -Force $ancestorRoot | Out-Null
    $ancestorResults = Join-Path $ancestorRoot "results"
    New-Item -ItemType Junction -Path $ancestorResults -Target $outside | Out-Null
    New-Item -ItemType Directory -Force (Join-Path $outside "byom") | Out-Null
    $failed = $false
    try {
        Resolve-SafeByomPath `
            -BaseRoot (Join-Path $ancestorResults "byom") `
            -RelativePath "candidate" `
            -Label "output" `
            -TrustedRoot $ancestorRoot | Out-Null
    } catch {
        $failed = $_.Exception.Message -match "reparse point"
    }
    if (-not $failed) { throw "Ancestor junction was not rejected." }

    Write-Host "PASS: BYOM path policy checks"
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
