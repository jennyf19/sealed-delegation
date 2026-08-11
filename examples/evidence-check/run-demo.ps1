[CmdletBinding()]
param(
    [string]$Model = "qwen2.5-7b-instruct-generic-gpu",
    [int]$TimeoutSeconds = 300,
    [string]$OutPath
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$root = (Resolve-Path (Join-Path $here "..\..")).Path
. (Join-Path $root "tools\foundry-shim-lib.ps1")

$source = Join-Path $here "fixture.md"
$OutPath = if ($OutPath) { $OutPath } else { Join-Path $here "results\sealed-result.json" }
New-Item -ItemType Directory -Force (Split-Path $OutPath -Parent) | Out-Null
$runtime = Initialize-LocalDelegationFoundryModel `
    -Model $Model `
    -FoundryAlias $Model `
    -ReceiptPath (Join-Path (Split-Path $OutPath -Parent) "runtime.json")

node (Join-Path $here "sealed-demo.mjs") `
    --base-url $runtime.final_upstream `
    --model $Model `
    --source $source `
    --out $OutPath `
    --timeout-seconds $TimeoutSeconds
exit $LASTEXITCODE
