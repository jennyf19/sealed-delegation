[CmdletBinding()]
param(
    [switch]$SkipLive,
    [string]$Model = "qwen2.5-7b-instruct-generic-gpu",
    [int]$MaxPromptTokens = 16384,
    [int]$TimeoutSeconds = 900
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

& pwsh -NoProfile -File (Join-Path $root ".github\skills\local-agent-delegation\test_policy.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& pwsh -NoProfile -File (Join-Path $root "tools\test-foundry-shim-lib.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& node --test (Join-Path $root "tools\foundry-stream-shim.test.mjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($SkipLive) {
    Write-Host "PASS: static sealed-delegation checks"
    exit 0
}

& pwsh -NoProfile -File (Join-Path $root "tools\local-agent-preflight.ps1") `
    -StartFoundryShim `
    -Model $Model `
    -FoundryAlias $Model `
    -MaxPromptTokens $MaxPromptTokens `
    -TimeoutSeconds $TimeoutSeconds `
    -RunRoot (Join-Path $root "results\preflight")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& pwsh -NoProfile -File (Join-Path $root "examples\evidence-check\run-demo.ps1") `
    -Model $Model `
    -TimeoutSeconds $TimeoutSeconds `
    -OutPath (Join-Path $root "results\sealed-demo\receipt.json")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "PASS: full sealed-delegation checks"
