[CmdletBinding()]
param(
    [string]$Model = "qwen2.5-7b-instruct-generic-gpu",
    [int]$MaxPromptTokens = 16384,
    [int]$TimeoutSeconds = 900,
    [string]$RunRoot
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$root = (Resolve-Path (Join-Path $here "..\..")).Path
. (Join-Path $root "tools\foundry-shim-lib.ps1")

$launcher = Join-Path $root ".github\skills\local-agent-delegation\scripts\invoke_local_agent.ps1"
$source = Join-Path $here "fixture.md"
$RunRoot = if ($RunRoot) { $RunRoot } else { Join-Path $here "results\agent-runs" }
$shim = $null
$task = @"
Use view to read exactly fixture.md.
Determine only whether releaseReadiness.rollbackEvidenceLinked can be set to pass for the
predeclared release windows.
If runtime and rollback outcome evidence is unjoined, block rather than estimate.
Do not issue a deployment, release, merge, or production-readiness verdict.
Return only one JSON object with exactly these keys:
{
  "status": "complete" or "blocked",
  "answer": "pass" or null,
  "missing_input": "joined runtime and rollback evidence for the predeclared 30-day release windows" or null,
  "source": "synthetic-release-evidence#observation-window"
}
Choose "complete" only if the evidence contains joined operational results sufficient to support
rollbackEvidenceLinked=pass. Otherwise choose "blocked", set answer to null, and name the missing
input exactly as specified by the schema.
"@

try {
    $shim = Start-LocalDelegationFoundryShim `
        -RepoRoot $root `
        -LogDirectory $RunRoot `
        -Model $Model `
        -FoundryAlias $Model

    $started = (Get-Date).ToUniversalTime()
    & $launcher `
        -Task $task `
        -WorkingDirectory $here `
        -InputPaths $source `
        -Profile read `
        -TaskMode evidence-check `
        -Model $Model `
        -FoundryAlias $Model `
        -MaxPromptTokens $MaxPromptTokens `
        -MaxOutputTokens 256 `
        -Stream on `
        -BaseUrl $shim.BaseUrl `
        -TimeoutSeconds $TimeoutSeconds `
        -RunRoot $RunRoot
    $launcherExit = $LASTEXITCODE

    $latest = Get-ChildItem -LiteralPath $RunRoot -Directory |
        Where-Object LastWriteTimeUtc -ge $started.AddSeconds(-2) |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if (-not $latest) {
        throw "The launcher produced no current receipt."
    }

    node (Join-Path $here "gate.mjs") (Join-Path $latest.FullName "run.json")
    $gateExit = $LASTEXITCODE
    if ($launcherExit -ne 0 -or $gateExit -ne 0) {
        exit 1
    }
} finally {
    if ($shim) {
        Stop-LocalDelegationFoundryShim $shim
    }
}
