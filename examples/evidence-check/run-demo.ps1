[CmdletBinding()]
param(
    [string]$RuntimeId = "foundry-local",
    [string]$Model = "qwen2.5-7b-instruct-generic-gpu",
    [int]$MaxPromptTokens = 16384,
    [int]$TimeoutSeconds = 300,
    [string]$OutPath,
    [string]$RoutePolicyPath,
    [switch]$AllowUnqualifiedRoute
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$root = (Resolve-Path (Join-Path $here "..\..")).Path
. (Join-Path $root "tools\foundry-shim-lib.ps1")
. (Join-Path $root ".github\skills\local-agent-delegation\scripts\route_policy.ps1")

$source = Join-Path $here "fixture.md"
$RoutePolicyPath = if ($RoutePolicyPath) {
    $RoutePolicyPath
} else {
    Join-Path $root ".github\skills\local-agent-delegation\references\approved-routes.json"
}
$null = Get-SealedDelegationRouteDecision `
    -PolicyPath $RoutePolicyPath `
    -RuntimeId $RuntimeId `
    -Model $Model `
    -Stream "on" `
    -MaxPromptTokens $MaxPromptTokens `
    -Profile "sealed" `
    -AllowUnqualifiedRoute:$AllowUnqualifiedRoute
if ($RuntimeId -ne "foundry-local") {
    throw "The bundled sealed demo currently requires RuntimeId foundry-local."
}
$OutPath = if ($OutPath) { $OutPath } else { Join-Path $here "results\sealed-result.json" }
New-Item -ItemType Directory -Force (Split-Path $OutPath -Parent) | Out-Null
$runtime = Initialize-LocalDelegationFoundryModel `
    -Model $Model `
    -FoundryAlias $Model `
    -ReceiptPath (Join-Path (Split-Path $OutPath -Parent) "runtime.json")

$sealedArgs = @(
    (Join-Path $here "sealed-demo.mjs"),
    "--base-url", $runtime.final_upstream,
    "--runtime", $RuntimeId,
    "--model", $Model,
    "--max-prompt-tokens", [string]$MaxPromptTokens,
    "--policy", $RoutePolicyPath,
    "--source", $source,
    "--out", $OutPath,
    "--timeout-seconds", [string]$TimeoutSeconds
)
if ($AllowUnqualifiedRoute) {
    $sealedArgs += "--allow-unqualified-route"
}
node @sealedArgs
exit $LASTEXITCODE
