#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Task,

    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory,

    [ValidateSet("read", "edit", "code")]
    [string]$Profile = "read",

    [ValidateSet("partnership", "contract")]
    [string]$InteractionMode = "partnership",

    [ValidateSet("prepare", "review", "evidence-check", "general")]
    [string]$TaskMode = "prepare",

    [string[]]$Tools,
    [string[]]$InputPaths,
    [switch]$AllowWrites,
    [switch]$AllowShell,
    [switch]$AllowProtectedBranch,
    [string[]]$ProtectedBranches = @("main", "master", "trunk", "develop"),
    [switch]$AllowRemoteEndpoint,
    [switch]$AllowCredentialEnvironment,
    [switch]$AllowPotentialSecrets,
    [switch]$AllowUnqualifiedRoute,

    [string]$BaseUrl = $env:LOCAL_MODEL_BASE_URL,
    [string]$RuntimeId = $(if ($env:LOCAL_MODEL_RUNTIME) { $env:LOCAL_MODEL_RUNTIME } else { "foundry-local" }),
    [string]$Model = $(if ($env:LOCAL_MODEL) { $env:LOCAL_MODEL } else { "qwen2.5-7b-instruct-generic-gpu" }),
    [string]$FoundryAlias = $(if ($env:LOCAL_MODEL_FOUNDRY_ALIAS) { $env:LOCAL_MODEL_FOUNDRY_ALIAS } else { "qwen2.5-7b-instruct-generic-gpu" }),
    [int]$MaxPromptTokens = 16384,
    [int]$MaxOutputTokens = 1024,
    [ValidateSet("on", "off")]
    [string]$Stream = "on",
    [int]$TimeoutSeconds = 900,
    [string]$RunRoot = $(Join-Path $HOME ".copilot\local-agent-runs"),
    [string]$RoutePolicyPath = $(Join-Path $PSScriptRoot "..\references\approved-routes.json"),
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "output_policy.ps1")
. (Join-Path $PSScriptRoot "route_policy.ps1")

$partnershipPreamble = (Get-Content (Join-Path $PSScriptRoot "..\references\partnership-preamble.txt") -Raw).Trim()
$taskModeInstruction = switch ($TaskMode) {
    "prepare" { "Produce the requested artifact; never claim completion without it." }
    "review" { "Finding evidence-grounded issues completes a review. Block only when missing evidence prevents the review itself." }
    "evidence-check" { "Determine whether the exact result is supported. If an input is missing, do not estimate: block and name the exact missing input. External verification is required." }
    default { "Complete the assigned task, or state exactly what prevents completion." }
}
$profileTools = @{
    read = @("view")
    edit = @("view", "glob", "edit", "create")
    code = @("view", "glob", "edit", "create", "powershell", "read_powershell")
}
$knownTools = @("view", "glob", "edit", "create", "powershell", "read_powershell")
$writeTools = @("edit", "create")
$shellTools = @("powershell", "read_powershell")

function Get-ApiRoot([string]$Url) {
    $value = $Url.TrimEnd("/")
    if ($value.EndsWith("/v1")) { return $value }
    return "$value/v1"
}

function Test-LoopbackUrl([string]$Url) {
    $parsed = [uri]$Url
    if ($parsed.Scheme -notin @("http", "https")) { return $false }
    if (-not [string]::IsNullOrEmpty($parsed.UserInfo)) { return $false }
    if ($parsed.Host -eq "localhost") { return $true }
    $address = $null
    if ([System.Net.IPAddress]::TryParse($parsed.Host, [ref]$address)) {
        return [System.Net.IPAddress]::IsLoopback($address)
    }
    return $false
}

function Get-PotentialSecretReason([string]$Text) {
    $patterns = [ordered]@{
        "private key material" = "-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"
        "GitHub token" = "\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}\b"
        "AWS access key" = "\bAKIA[0-9A-Z]{16}\b"
        "Azure storage account key" = "(?i)\bAccountKey\s*=\s*[A-Za-z0-9+/=]{20,}"
        "assigned secret value" = "(?i)\b(?:client[_-]?secret|password|access[_-]?token)\s*[:=]\s*['""]?[A-Za-z0-9_./+=-]{16,}"
    }
    foreach ($entry in $patterns.GetEnumerator()) {
        if ($Text -match $entry.Value) {
            return $entry.Key
        }
    }
    return $null
}

function Get-FoundryUrl {
    $foundry = Get-Command foundry -ErrorAction SilentlyContinue
    if (-not $foundry) {
        throw "Foundry Local is not installed. Supply a loopback -BaseUrl for another OpenAI-compatible runtime."
    }
    $status = foundry status -o json | ConvertFrom-Json
    if (-not $status.service.ready) {
        foundry server start | Out-Null
        $deadline = (Get-Date).AddSeconds(60)
        do {
            Start-Sleep -Seconds 2
            $status = foundry status -o json | ConvertFrom-Json
        } until ($status.service.ready -or (Get-Date) -gt $deadline)
    }
    if (-not $status.service.ready -or -not $status.service.webUrls) {
        throw "Foundry Local did not become ready."
    }
    return $status.service.webUrls[0]
}

function Invoke-ModelHealth([string]$ApiRoot) {
    $body = @{
        model = $Model
        temperature = 0
        max_tokens = 8
        messages = @(@{ role = "user"; content = "Reply exactly READY" })
    } | ConvertTo-Json -Depth 5
    if ($AllowRemoteEndpoint) {
        Invoke-RestMethod "$ApiRoot/chat/completions" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 120 -MaximumRedirection 0
    } else {
        Invoke-RestMethod "$ApiRoot/chat/completions" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 120 -NoProxy -MaximumRedirection 0
    }
}

$resolvedWorkingDirectory = (Resolve-Path $WorkingDirectory).Path
if (-not (Test-Path $resolvedWorkingDirectory -PathType Container)) {
    throw "WorkingDirectory must be an existing directory."
}

$potentialSecret = Get-PotentialSecretReason $Task
if ($potentialSecret -and -not $AllowPotentialSecrets) {
    throw "Task text appears to contain $potentialSecret. Remove the value or pass -AllowPotentialSecrets after reviewing receipt persistence."
}

if ($InputPaths -and ($Profile -ne "read" -or $AllowWrites -or $AllowShell)) {
    throw "Staged InputPaths are supported only for the read profile without write or shell access."
}
$resolvedInputs = @()
foreach ($inputPath in @($InputPaths | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
    $candidate = if ([System.IO.Path]::IsPathRooted($inputPath)) {
        $inputPath
    } else {
        Join-Path $resolvedWorkingDirectory $inputPath
    }
    $resolvedInput = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $resolvedInput -PathType Leaf)) {
        throw "InputPaths entries must resolve to files: $inputPath"
    }
    $resolvedInputs += [pscustomobject]@{
        requested_path = $inputPath
        source_path = $resolvedInput
        staged_name = [System.IO.Path]::GetFileName($resolvedInput)
    }
}
$duplicateNames = @(
    $resolvedInputs |
        Group-Object staged_name |
        Where-Object Count -gt 1 |
        Select-Object -ExpandProperty Name
)
if ($duplicateNames) {
    throw "Staged InputPaths must have unique file names: $($duplicateNames -join ', ')."
}

if ($Tools) {
    [string[]]$selectedTools = @($Tools)
} else {
    [string[]]$selectedTools = @($profileTools[$Profile])
}
$unknown = @($selectedTools | Where-Object { $_ -notin $knownTools })
if ($unknown) {
    throw "Unsupported tools: $($unknown -join ', '). Allowed: $($knownTools -join ', ')."
}
if (($selectedTools | Where-Object { $_ -in $writeTools }) -and -not $AllowWrites) {
    throw "Mutation tools require -AllowWrites."
}
if (($selectedTools | Where-Object { $_ -in $shellTools }) -and -not $AllowShell) {
    throw "Shell tools require -AllowShell."
}

$gitRoot = git -C $resolvedWorkingDirectory rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -eq 0 -and ($AllowWrites -or $AllowShell)) {
    $branch = (git -C $resolvedWorkingDirectory rev-parse --abbrev-ref HEAD).Trim()
    $originHead = git -C $resolvedWorkingDirectory symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $originHead -match '^origin/(.+)$') {
        $ProtectedBranches = @($ProtectedBranches + $Matches[1] | Select-Object -Unique)
    }
    if ($branch -in $ProtectedBranches -and -not $AllowProtectedBranch) {
        throw "Refusing a mutating local agent on protected branch '$branch'. Use an isolated worktree."
    }
}

$routeDecision = Get-SealedDelegationRouteDecision `
    -PolicyPath $RoutePolicyPath `
    -RuntimeId $RuntimeId `
    -Model $Model `
    -Stream $Stream `
    -MaxPromptTokens $MaxPromptTokens `
    -Profile $Profile `
    -AllowUnqualifiedRoute:$AllowUnqualifiedRoute

if (-not $BaseUrl) {
    if ($Stream -eq "on" -and -not $DryRun) {
        throw "The qualified streaming route requires an explicit loopback -BaseUrl, such as the temporary Foundry stream shim. Run tools\local-agent-preflight.ps1 -StartFoundryShim first."
    }
    $BaseUrl = if ($DryRun) { "http://127.0.0.1:0" } else { Get-FoundryUrl }
}
if (-not $AllowRemoteEndpoint -and -not (Test-LoopbackUrl $BaseUrl)) {
    throw "Refusing a non-loopback provider. Pass -AllowRemoteEndpoint only after reviewing the data boundary."
}
$api = Get-ApiRoot $BaseUrl

if (-not $DryRun) {
    try {
        $null = Invoke-ModelHealth $api
    } catch {
        if (-not (Get-Command foundry -ErrorAction SilentlyContinue)) { throw }
        foundry model load $FoundryAlias | Out-Null
        $null = Invoke-ModelHealth $api
    }
}

$copilotCommands = @(Get-Command copilot -All -ErrorAction Stop)
$copilotNative = $copilotCommands |
    Where-Object {
        if ($IsWindows) {
            return $_.CommandType -eq "Application" -and
                [System.IO.Path]::GetExtension($_.Source) -ieq ".exe"
        }
        return $_.CommandType -eq "Application" -and
            [System.IO.Path]::GetExtension($_.Source) -notin @(".cmd", ".bat")
    } |
    Select-Object -First 1
$copilotScript = $copilotCommands |
    Where-Object { $_.Source.EndsWith(".ps1", [System.StringComparison]::OrdinalIgnoreCase) } |
    Select-Object -First 1

if ($copilotNative) {
    $copilotCommand = $copilotNative.Source
    $copilotLauncher = $copilotNative.Source
    [string[]]$copilotPrefixArguments = @()
} elseif ($copilotScript) {
    $pwsh = Get-Command pwsh -CommandType Application -ErrorAction Stop
    $copilotCommand = $copilotScript.Source
    $copilotLauncher = $pwsh.Source
    [string[]]$copilotPrefixArguments = @("-NoProfile", "-File", $copilotScript.Source)
} else {
    throw "No directly executable Copilot CLI or PowerShell shim was found."
}
$runId = (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
$runDirectory = New-Item -ItemType Directory -Force (Join-Path $RunRoot $runId)
$stdoutPath = Join-Path $runDirectory "stdout.txt"
$stderrPath = Join-Path $runDirectory "stderr.txt"
$metadataPath = Join-Path $runDirectory "run.json"
$taskPath = Join-Path $runDirectory "task.txt"
$stagedTaskPath = Join-Path $runDirectory "staged-task.txt"
$effectiveTaskPath = Join-Path $runDirectory "effective-task.txt"
$inputManifestPath = Join-Path $runDirectory "input-manifest.json"
$childWorkingDirectory = $resolvedWorkingDirectory
$stagedTask = $Task
$stagedInputManifest = @()
if ($resolvedInputs) {
    $childWorkingDirectory = (New-Item -ItemType Directory -Force (Join-Path $runDirectory "workspace")).FullName
    foreach ($input in $resolvedInputs) {
        $stagedPath = Join-Path $childWorkingDirectory $input.staged_name
        $sourceHash = (Get-FileHash -LiteralPath $input.source_path -Algorithm SHA256).Hash.ToLowerInvariant()
        Copy-Item -LiteralPath $input.source_path -Destination $stagedPath
        $stagedHash = (Get-FileHash -LiteralPath $stagedPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($sourceHash -ne $stagedHash) {
            throw "Staged input hash mismatch: $($input.source_path)"
        }
        $inputReferences = @(
            $input.requested_path
            $input.source_path
            $input.staged_name
        ) |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Sort-Object Length -Descending -Unique
        if ($inputReferences.Count -gt 0) {
            $inputPattern = ($inputReferences | ForEach-Object { [regex]::Escape($_) }) -join "|"
            $literalStagedPath = $stagedPath.Replace('$', '$$')
            $stagedTask = [regex]::Replace(
                $stagedTask,
                $inputPattern,
                $literalStagedPath,
                [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
            )
        }
        $stagedInputManifest += [pscustomobject]@{
            source_path = $input.source_path
            staged_name = $input.staged_name
            staged_path = $stagedPath
            sha256 = $stagedHash
            source_sha256 = $sourceHash
            staged_sha256 = $stagedHash
            size_bytes = (Get-Item -LiteralPath $stagedPath).Length
        }
    }
    ConvertTo-Json -InputObject @($stagedInputManifest) -Depth 5 |
        Set-Content $inputManifestPath -Encoding utf8
}
$effectiveTask = if ($InteractionMode -eq "partnership") {
    "$partnershipPreamble`n`n$taskModeInstruction`n`nTASK`n$stagedTask"
} else {
    $stagedTask
}
$Task | Set-Content $taskPath -Encoding utf8
$stagedTask | Set-Content $stagedTaskPath -Encoding utf8
$effectiveTask | Set-Content $effectiveTaskPath -Encoding utf8
$taskHash = [Convert]::ToHexString(
    [System.Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Task))
).ToLowerInvariant()
$stagedTaskHash = [Convert]::ToHexString(
    [System.Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($stagedTask))
).ToLowerInvariant()
$effectiveTaskHash = [Convert]::ToHexString(
    [System.Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($effectiveTask))
).ToLowerInvariant()

$arguments = @(
    "-p", $effectiveTask,
    "--allow-all-tools",
    "-s",
    "--stream", $Stream,
    "--no-custom-instructions",
    "--no-ask-user",
    "--available-tools=$($selectedTools -join ',')",
    "-C", $childWorkingDirectory
)

$metadata = [ordered]@{
    schema_version = "local-agent-delegation/run/v1"
    run_id = $runId
    started_at = (Get-Date).ToUniversalTime().ToString("o")
    task_sha256 = $taskHash
    working_directory = $resolvedWorkingDirectory
    child_working_directory = $childWorkingDirectory
    profile = $Profile
    interaction_mode = $InteractionMode
    task_mode = $TaskMode
    tools = @($selectedTools)
    protected_branches = @($ProtectedBranches)
    provider_base_url = $api
    runtime = $RuntimeId
    model = $Model
    max_prompt_tokens = $MaxPromptTokens
    max_output_tokens = $MaxOutputTokens
    stream = $Stream
    timeout_seconds = $TimeoutSeconds
    dry_run = [bool]$DryRun
    task_path = $taskPath
    staged_task_path = $stagedTaskPath
    staged_task_sha256 = $stagedTaskHash
    input_manifest_path = $(if ($stagedInputManifest.Count -gt 0) { $inputManifestPath } else { $null })
    staged_inputs = @($stagedInputManifest)
    copilot_command = $copilotCommand
    copilot_launcher = $copilotLauncher
    effective_task_path = $effectiveTaskPath
    effective_task_sha256 = $effectiveTaskHash
    credential_environment_inherited = [bool]$AllowCredentialEnvironment
    environment_mode = $(if ($AllowCredentialEnvironment) { "inherited" } else { "minimal-isolated-home" })
    route_policy_path = $routeDecision.policy_path
    route_policy_sha256 = $routeDecision.policy_sha256
    route_policy_id = $routeDecision.policy_id
    route_id = $routeDecision.route_id
    route_qualified = $routeDecision.qualified
    unqualified_route_override = $routeDecision.override_used
}

if ($DryRun) {
    $metadata.status = "DRY_RUN"
    $metadata | ConvertTo-Json -Depth 6 | Set-Content $metadataPath -Encoding utf8
    $metadata | ConvertTo-Json -Depth 6
    exit 0
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $copilotLauncher
$startInfo.WorkingDirectory = $childWorkingDirectory
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.CreateNoWindow = $true
$childEnvironmentRoot = $null
if (-not $AllowCredentialEnvironment) {
    $safeKeys = @(
        "SystemRoot",
        "SystemDrive",
        "WINDIR",
        "COMSPEC",
        "PATH",
        "PATHEXT",
        "OS",
        "ALLUSERSPROFILE",
        "COMMONPROGRAMFILES",
        "COMMONPROGRAMFILES(X86)",
        "COMMONPROGRAMW6432",
        "COMPUTERNAME",
        "DRIVERDATA",
        "PROCESSOR_ARCHITECTURE",
        "PROCESSOR_IDENTIFIER",
        "PROCESSOR_LEVEL",
        "PROCESSOR_REVISION",
        "NUMBER_OF_PROCESSORS",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "ProgramData",
        "PUBLIC",
        "SESSIONNAME",
        "PSModulePath",
        "POWERSHELL_DISTRIBUTION_CHANNEL",
        "POWERSHELL_UPDATECHECK",
        "NODEFAULTCURRENTDIRECTORYINEXEPATH",
        "GIT_EXEC_PATH",
        "DOTNET_ROOT",
        "LANG",
        "LC_ALL",
        "LC_CTYPE"
    )
    foreach ($key in @($startInfo.Environment.Keys)) {
        if ($key -notin $safeKeys) {
            $null = $startInfo.Environment.Remove($key)
        }
    }
        # Keep Copilot's nested SQLite and package paths below the Windows path-length limit.
        $childEnvironmentRoot = New-Item -ItemType Directory -Force (
            Join-Path ([System.IO.Path]::GetTempPath()) "copilot-local-agent-$runId"
        )
        $childHome = New-Item -ItemType Directory -Force (Join-Path $childEnvironmentRoot "home")
        $childTemp = New-Item -ItemType Directory -Force (Join-Path $childEnvironmentRoot "temp")
        $childAppData = New-Item -ItemType Directory -Force (Join-Path $childHome "AppData\Roaming")
        $childLocalAppData = New-Item -ItemType Directory -Force (Join-Path $childHome "AppData\Local")
        $azureConfig = New-Item -ItemType Directory -Force (Join-Path $childHome ".azure")
        $emptyGitConfig = Join-Path $childHome ".gitconfig"
        "" | Set-Content $emptyGitConfig -Encoding utf8
        $homeRoot = [System.IO.Path]::GetPathRoot($childHome.FullName).TrimEnd("\")
        $homePath = $childHome.FullName.Substring($homeRoot.Length)
        if (-not $homePath.StartsWith("\")) { $homePath = "\$homePath" }
        $startInfo.Environment["HOME"] = $childHome.FullName
        $startInfo.Environment["USERPROFILE"] = $childHome.FullName
        $startInfo.Environment["HOMEDRIVE"] = $homeRoot
        $startInfo.Environment["HOMEPATH"] = $homePath
        $startInfo.Environment["APPDATA"] = $childAppData.FullName
        $startInfo.Environment["LOCALAPPDATA"] = $childLocalAppData.FullName
        $startInfo.Environment["TEMP"] = $childTemp.FullName
        $startInfo.Environment["TMP"] = $childTemp.FullName
        $startInfo.Environment["AZURE_CONFIG_DIR"] = $azureConfig.FullName
        $startInfo.Environment["GIT_CONFIG_NOSYSTEM"] = "1"
        $startInfo.Environment["GIT_CONFIG_GLOBAL"] = $emptyGitConfig
        $startInfo.Environment["GIT_TERMINAL_PROMPT"] = "0"
        $startInfo.Environment["GCM_INTERACTIVE"] = "Never"
        $startInfo.Environment["GIT_CONFIG_COUNT"] = "1"
        $startInfo.Environment["GIT_CONFIG_KEY_0"] = "credential.helper"
        $startInfo.Environment["GIT_CONFIG_VALUE_0"] = ""
    }
$providerKeys = @(
    "COPILOT_PROVIDER_BEARER_TOKEN",
    "COPILOT_PROVIDER_HEADERS",
    "COPILOT_PROVIDER_AZURE_API_VERSION",
    "COPILOT_PROVIDER_TRANSPORT",
    "COPILOT_PROVIDER_MODEL_ID",
    "COPILOT_PROVIDER_WIRE_MODEL"
)
foreach ($key in $providerKeys) {
    $null = $startInfo.Environment.Remove($key)
}
if (-not $AllowRemoteEndpoint) {
    foreach ($key in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")) {
        $null = $startInfo.Environment.Remove($key)
    }
    $startInfo.Environment["NO_PROXY"] = "127.0.0.1,localhost,::1"
    $startInfo.Environment["no_proxy"] = "127.0.0.1,localhost,::1"
}
$startInfo.Environment["COPILOT_PROVIDER_BASE_URL"] = $api
$startInfo.Environment["COPILOT_PROVIDER_TYPE"] = "openai"
$startInfo.Environment["COPILOT_PROVIDER_API_KEY"] = "foundry-local"
$startInfo.Environment["COPILOT_PROVIDER_WIRE_API"] = "completions"
$startInfo.Environment["COPILOT_MODEL"] = $Model
$startInfo.Environment["COPILOT_PROVIDER_MAX_PROMPT_TOKENS"] = [string]$MaxPromptTokens
$startInfo.Environment["COPILOT_PROVIDER_MAX_OUTPUT_TOKENS"] = [string]$MaxOutputTokens
foreach ($argument in $copilotPrefixArguments) {
    $startInfo.ArgumentList.Add($argument)
}
foreach ($argument in $arguments) {
    $startInfo.ArgumentList.Add($argument)
}

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$started = Get-Date
try {
    $null = $process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $completed = $process.WaitForExit($TimeoutSeconds * 1000)
    if (-not $completed) {
        $process.Kill($true)
        $process.WaitForExit()
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $stdout | Set-Content $stdoutPath -Encoding utf8
    $stderr | Set-Content $stderrPath -Encoding utf8
} finally {
    if ($childEnvironmentRoot -and (Test-Path -LiteralPath $childEnvironmentRoot)) {
        Remove-Item -LiteralPath $childEnvironmentRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$metadata.finished_at = (Get-Date).ToUniversalTime().ToString("o")
$metadata.elapsed_seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 3)
$metadata.timed_out = -not $completed
$metadata.child_exit_code = if ($completed) { $process.ExitCode } else { $null }
$outputFailureReason = if ($completed -and $process.ExitCode -eq 0) {
    Get-LocalAgentOutputFailureReason -Stdout $stdout -StagedInputCount $stagedInputManifest.Count
} else {
    $null
}
$metadata.output_validation = [ordered]@{
    passed = [string]::IsNullOrEmpty($outputFailureReason)
    failure_reason = $outputFailureReason
}
$launcherExitCode = if (-not $completed) {
    124
} elseif ($process.ExitCode -ne 0) {
    $process.ExitCode
} elseif ($outputFailureReason) {
    65
} else {
    0
}
$metadata.exit_code = $launcherExitCode
$metadata.status = if (-not $completed) {
    "TIMEOUT"
} elseif ($process.ExitCode -ne 0) {
    "FAILED"
} elseif ($outputFailureReason) {
    "INVALID_OUTPUT"
} else {
    "COMPLETED"
}
$metadata.stdout_path = $stdoutPath
$metadata.stderr_path = $stderrPath
$metadata.stdout_sha256 = (Get-FileHash $stdoutPath -Algorithm SHA256).Hash.ToLowerInvariant()
$metadata.stderr_sha256 = (Get-FileHash $stderrPath -Algorithm SHA256).Hash.ToLowerInvariant()
$metadata | ConvertTo-Json -Depth 6 | Set-Content $metadataPath -Encoding utf8

Write-Output $stdout
if ($stderr) {
    if ($completed -and $process.ExitCode -eq 0) {
        Write-Warning $stderr.Trim()
    } else {
        [Console]::Error.WriteLine($stderr)
    }
}
Write-Host "`n[local-agent $runId] $($metadata.status) in $($metadata.elapsed_seconds)s; receipts: $runDirectory"
exit $launcherExitCode
