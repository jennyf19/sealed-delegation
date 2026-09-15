#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "artifact-policy.ps1")

$valid = @(
    [pscustomobject]@{ Name = "genai_config.json"; Length = 10 },
    [pscustomobject]@{ Name = "model.onnx"; Length = 20 },
    [pscustomobject]@{ Name = "model.bin"; Length = 30 }
)
Assert-RequiredByomArtifacts -Files $valid -Patterns @("genai_config.json", "*.onnx", "*.bin")

$failed = $false
try {
    Assert-RequiredByomArtifacts `
        -Files @([pscustomobject]@{ Name = "model.bin"; Length = 0 }) `
        -Patterns @("*.bin")
} catch {
    $failed = $_.Exception.Message -match "only empty files"
}
if (-not $failed) { throw "Empty required artifacts were not rejected." }

Write-Host "PASS: BYOM artifact policy checks"
