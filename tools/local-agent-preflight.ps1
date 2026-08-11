# local-agent-preflight.ps1 — prove the whole local GHCP child path with a staged-file canary
#
# Usage:
#   pwsh tools/scripts/local-agent-preflight.ps1
#   pwsh tools/scripts/local-agent-preflight.ps1 -BaseUrl http://127.0.0.1:1234 -Model model-id -Stream on

[CmdletBinding()]
param(
    [string]$BaseUrl = $env:LOCAL_MODEL_BASE_URL,
    [string]$RuntimeId = $(if ($env:LOCAL_MODEL_RUNTIME) { $env:LOCAL_MODEL_RUNTIME } else { "foundry-local" }),
    [string]$Model = $(if ($env:LOCAL_MODEL) { $env:LOCAL_MODEL } else { "qwen2.5-7b-instruct-generic-gpu" }),
    [string]$FoundryAlias = $env:LOCAL_MODEL_FOUNDRY_ALIAS,
    [ValidateSet("on", "off")]
    [string]$Stream = $(if ($env:LOCAL_MODEL_STREAM) { $env:LOCAL_MODEL_STREAM } else { "off" }),
    [int]$MaxPromptTokens = $(if ($env:LOCAL_MODEL_MAX_PROMPT_TOKENS) { [int]$env:LOCAL_MODEL_MAX_PROMPT_TOKENS } else { 16384 }),
    [int]$MaxOutputTokens = 64,
    [int]$TimeoutSeconds = 600,
    [string]$RunRoot = $(Join-Path $HOME ".copilot\local-agent-preflight-runs"),
    [string]$RoutePolicyPath,
    [switch]$AllowUnqualifiedRoute,
    [switch]$StartFoundryShim,
    [int]$ShimPort = 0
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "foundry-shim-lib.ps1")
$FoundryAlias = if ($FoundryAlias) { $FoundryAlias } else { $Model }
$launcher = Join-Path $repoRoot ".github\skills\local-agent-delegation\scripts\invoke_local_agent.ps1"
$routePolicyHelper = Join-Path $repoRoot ".github\skills\local-agent-delegation\scripts\route_policy.ps1"
. $routePolicyHelper
$RoutePolicyPath = if ($RoutePolicyPath) {
    $RoutePolicyPath
} else {
    Join-Path $repoRoot ".github\skills\local-agent-delegation\references\approved-routes.json"
}
$policyStream = if ($StartFoundryShim) { "on" } else { $Stream }
$null = Get-SealedDelegationRouteDecision `
    -PolicyPath $RoutePolicyPath `
    -RuntimeId $RuntimeId `
    -Model $Model `
    -Stream $policyStream `
    -MaxPromptTokens $MaxPromptTokens `
    -Profile "read" `
    -AllowUnqualifiedRoute:$AllowUnqualifiedRoute
$fixtureRoot = Join-Path $env:TEMP ("sealed-delegation-preflight-" + [guid]::NewGuid().ToString("N"))
$fixture = Join-Path $fixtureRoot "canary.txt"
$nonce = [guid]::NewGuid().ToString("N")
$expected = "CANARY: $nonce"
$started = (Get-Date).ToUniversalTime()
$shimHandle = $null
$ready = $false

try {
    New-Item -ItemType Directory -Force $fixtureRoot | Out-Null
    New-Item -ItemType Directory -Force $RunRoot | Out-Null

    if ($StartFoundryShim) {
        if ($RuntimeId -ne "foundry-local") {
            throw "-StartFoundryShim requires RuntimeId foundry-local."
        }
        if ($BaseUrl) {
            throw "-StartFoundryShim discovers Foundry Local dynamically; do not also pass -BaseUrl."
        }
        $shimHandle = Start-LocalDelegationFoundryShim `
            -RepoRoot $repoRoot `
            -LogDirectory $RunRoot `
            -Model $Model `
            -FoundryAlias $FoundryAlias `
            -Port $ShimPort
        $BaseUrl = $shimHandle.BaseUrl
        $Stream = "on"
    }

    "nonce=$nonce" | Set-Content $fixture -Encoding utf8
    $invoke = @{
        Task = "Use view to read exactly canary.txt. Reply exactly CANARY: <nonce value from the file>."
        WorkingDirectory = $repoRoot
        Profile = "read"
        InputPaths = @($fixture)
        TaskMode = "prepare"
        RuntimeId = $RuntimeId
        Model = $Model
        FoundryAlias = $FoundryAlias
        MaxPromptTokens = $MaxPromptTokens
        MaxOutputTokens = $MaxOutputTokens
        Stream = $Stream
        TimeoutSeconds = $TimeoutSeconds
        RunRoot = $RunRoot
        RoutePolicyPath = $RoutePolicyPath
        AllowUnqualifiedRoute = $AllowUnqualifiedRoute
    }
    if ($BaseUrl) {
        $invoke.BaseUrl = $BaseUrl
    }

    $launcherError = $null
    try {
        $launcherOutput = (& $launcher @invoke *>&1 | Out-String).Trim()
        $launcherExit = $LASTEXITCODE
    } catch {
        $launcherOutput = ""
        $launcherExit = 1
        $launcherError = $_.Exception.Message
    }

    $latest = Get-ChildItem $RunRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object LastWriteTimeUtc -ge $started.AddSeconds(-2) |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    $run = if ($latest -and (Test-Path (Join-Path $latest.FullName "run.json"))) {
        Get-Content (Join-Path $latest.FullName "run.json") -Raw | ConvertFrom-Json
    } else {
        $null
    }
    $stdout = if ($run -and (Test-Path $run.stdout_path)) {
        (Get-Content $run.stdout_path -Raw).Trim()
    } else {
        ""
    }
    $sourceHash = (Get-FileHash $fixture -Algorithm SHA256).Hash.ToLowerInvariant()
    $stagedHash = if ($run -and @($run.staged_inputs).Count -eq 1) {
        $run.staged_inputs[0].sha256
    } else {
        $null
    }
    $ready = $launcherExit -eq 0 `
        -and $run.status -eq "COMPLETED" `
        -and $stdout -ceq $expected `
        -and $stagedHash -ceq $sourceHash

    [pscustomobject]@{
        status = $(if ($ready) { "READY" } else { "FAILED" })
        model = $Model
        base_url = $(if ($run) { $run.provider_base_url } else { $BaseUrl })
        stream = $Stream
        shim_process_id = $(if ($shimHandle) { $shimHandle.ProcessId } else { $null })
        shim_stopped_after_canary = [bool]$shimHandle
        run_id = $(if ($run) { $run.run_id } else { $null })
        launcher_status = $(if ($run) { $run.status } else { $null })
        launcher_exit_code = $launcherExit
        staged_input_hash_verified = $stagedHash -ceq $sourceHash
        expected = $expected
        actual = $stdout
        elapsed_seconds = $(if ($run) { $run.elapsed_seconds } else { $null })
        receipt = $(if ($latest) { Join-Path $latest.FullName "run.json" } else { $null })
        error = $(if ($launcherError) { $launcherError } elseif (-not $ready) { $launcherOutput } else { $null })
    } | ConvertTo-Json -Depth 5

    if (-not $ready) {
        exit 1
    }
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
    if ($shimHandle) {
        Stop-LocalDelegationFoundryShim $shimHandle
    }
}
