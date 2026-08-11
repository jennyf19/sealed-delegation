#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "scripts\invoke_local_agent.ps1"
$outputPolicy = Join-Path $PSScriptRoot "scripts\output_policy.ps1"
. $outputPolicy
$temporary = New-Item -ItemType Directory -Force (Join-Path $env:TEMP ("local-agent-policy-" + [guid]::NewGuid().ToString("N")))
try {
    $runRoot = Join-Path $temporary "runs"
    $result = & $script -Task "read only" -WorkingDirectory $temporary -Profile read -RunRoot $runRoot -DryRun | ConvertFrom-Json
    if ($result.status -ne "DRY_RUN") { throw "read dry-run did not complete" }
    if (@($result.tools) -join "," -ne "view") { throw "read profile tool drift" }
    if ($result.credential_environment_inherited) { throw "credentials inherited by default" }
    if ([System.IO.Path]::GetExtension($result.copilot_launcher) -ieq ".ps1") {
        throw "PowerShell shim was selected as a native process launcher"
    }
    if ($IsWindows -and [System.IO.Path]::GetExtension($result.copilot_launcher) -ine ".exe") {
        throw "Windows launcher is not an executable"
    }
    if ($result.interaction_mode -ne "partnership") { throw "partnership was not the default interaction mode" }
    if ($result.task_mode -ne "prepare") { throw "prepare was not the default task mode" }
    if ($result.effective_task_sha256 -eq $result.task_sha256) { throw "partnership framing was not applied" }
    if ($result.model -ne "qwen2.5-7b-instruct-generic-gpu") { throw "default model drifted outside the qualified tuple" }
    if ($result.max_prompt_tokens -ne 16384) { throw "default prompt budget drifted outside the qualified tuple" }
    if ($result.stream -ne "on") { throw "default stream mode drifted outside the qualified tuple" }
    if (-not $result.route_qualified -or $result.unqualified_route_override) {
        throw "default route was not qualified by policy"
    }
    if ($result.route_id -ne "foundry-qwen25-7b-qualified") {
        throw "default route id drifted"
    }

    $failed = $false
    try {
        & $script `
            -Task "read fixture" `
            -WorkingDirectory $temporary `
            -Model "unapproved-model" `
            -FoundryAlias "unapproved-model" `
            -RunRoot $runRoot `
            -DryRun 2>$null | Out-Null
    } catch {
        $failed = $_.Exception.Message -match "Route is not approved"
    }
    if (-not $failed) { throw "unapproved model was not rejected" }

    $failed = $false
    try {
        & $script `
            -Task "read fixture" `
            -WorkingDirectory $temporary `
            -RuntimeId "lm-studio" `
            -RunRoot $runRoot `
            -DryRun 2>$null | Out-Null
    } catch {
        $failed = $_.Exception.Message -match "Route is not approved"
    }
    if (-not $failed) { throw "unapproved runtime was not rejected" }

    $override = & $script `
        -Task "read fixture" `
        -WorkingDirectory $temporary `
        -RuntimeId "lm-studio" `
        -Model "unapproved-model" `
        -FoundryAlias "unapproved-model" `
        -AllowUnqualifiedRoute `
        -RunRoot $runRoot `
        -DryRun | ConvertFrom-Json
    if ($override.route_qualified -or -not $override.unqualified_route_override) {
        throw "unqualified route override was not recorded"
    }

    $failed = $false
    try {
        & $script `
            -Task "read fixture" `
            -WorkingDirectory $temporary `
            -BaseUrl "https://example.com" `
            -DryRun 2>$null | Out-Null
    } catch {
        $failed = $_.Exception.Message -match "non-loopback"
    }
    if (-not $failed) { throw "non-loopback provider was not rejected" }

    $failed = $false
    try {
        & $script `
            -Task "Use access_token=ghp_abcdefghijklmnopqrstuvwxyz1234567890" `
            -WorkingDirectory $temporary `
            -RunRoot $runRoot `
            -DryRun 2>$null | Out-Null
    } catch {
        $failed = $_.Exception.Message -match "GitHub token"
    }
    if (-not $failed) { throw "potential task secret was not rejected" }

    $contract = & $script -Task "read only" -WorkingDirectory $temporary -Profile read -InteractionMode contract -RunRoot $runRoot -DryRun | ConvertFrom-Json
    if ($contract.effective_task_sha256 -ne $contract.task_sha256) { throw "contract mode changed the task" }
    $evidenceCheck = & $script -Task "calculate exact result" -WorkingDirectory $temporary -Profile read -TaskMode evidence-check -RunRoot $runRoot -DryRun | ConvertFrom-Json
    if ($evidenceCheck.task_mode -ne "evidence-check") { throw "evidence-check task mode was not recorded" }

    $stagedSource = Join-Path $temporary "staged-source.txt"
    "staged fixture" | Set-Content $stagedSource -Encoding utf8
    $staged = & $script `
        -Task "Use view to read exactly staged-source.txt." `
        -WorkingDirectory $temporary `
        -Profile read `
        -InputPaths $stagedSource `
        -RunRoot $runRoot `
        -DryRun | ConvertFrom-Json
    if (@($staged.staged_inputs).Count -ne 1) { throw "staged input was not recorded" }
    if ($staged.child_working_directory -eq $staged.working_directory) { throw "staged input did not isolate the child workspace" }
    if ($staged.staged_task_sha256 -eq $staged.task_sha256) { throw "absolute input path was not rewritten" }
    if (-not (Test-Path $staged.staged_inputs[0].staged_path -PathType Leaf)) { throw "staged input copy is missing" }
    $stagedTaskText = Get-Content $staged.staged_task_path -Raw
    if (-not $stagedTaskText.Contains($staged.staged_inputs[0].staged_path)) {
        throw "bare staged filename was not rewritten to the exact staged path"
    }
    if ($staged.staged_inputs[0].sha256 -ne (Get-FileHash $stagedSource -Algorithm SHA256).Hash.ToLowerInvariant()) {
        throw "staged input hash drifted"
    }
    if ($staged.staged_inputs[0].source_sha256 -ne $staged.staged_inputs[0].staged_sha256) {
        throw "source and staged input hashes differ"
    }

    $failed = $false
    try {
        & $script -Task "write" -WorkingDirectory $temporary -Profile edit -RunRoot $runRoot -DryRun 2>$null | Out-Null
    } catch {
        $failed = $_.Exception.Message -match "AllowWrites"
    }
    if (-not $failed) { throw "edit profile did not require AllowWrites" }

    $protected = New-Item -ItemType Directory -Force (Join-Path $temporary "protected")
    git -C $protected init -b trunk --quiet
    "fixture" | Set-Content (Join-Path $protected "fixture.txt") -Encoding utf8
    git -C $protected add fixture.txt
    git -C $protected -c user.name=Test -c user.email=test@example.invalid commit -m fixture --quiet
    $failed = $false
    try {
        & $script -Task "edit" -WorkingDirectory $protected -Profile edit -AllowWrites -RunRoot $runRoot -DryRun 2>$null | Out-Null
    } catch {
        $failed = $_.Exception.Message -match "protected branch 'trunk'"
    }
    if (-not $failed) { throw "trunk branch was not protected" }

    if ((Get-LocalAgentOutputFailureReason "") -ne "empty_stdout") {
        throw "empty output was not rejected"
    }
    if ((Get-LocalAgentOutputFailureReason "<tool_call>`n{}`n<tool_call>") -ne "raw_tool_call_markup") {
        throw "raw tool-call markup was not rejected"
    }
    if ($null -ne (Get-LocalAgentOutputFailureReason '{"result":"ok"}')) {
        throw "valid output was rejected"
    }
    if ((Get-LocalAgentOutputFailureReason -Stdout "Permission denied; check file permissions." -StagedInputCount 1) -ne "staged_input_access_claim") {
        throw "staged input access claim was not rejected"
    }
    if ($null -ne (Get-LocalAgentOutputFailureReason -Stdout "Permission denied; check file permissions." -StagedInputCount 0)) {
        throw "unstaged access claim was rejected without deterministic evidence"
    }
    if ($null -ne (Get-LocalAgentOutputFailureReason -Stdout "The report documents access rights for operators." -StagedInputCount 1)) {
        throw "valid access-rights content was rejected"
    }

    Write-Host "PASS: local-agent delegation policy checks"
    exit 0
} finally {
    Remove-Item $temporary -Recurse -Force
}
