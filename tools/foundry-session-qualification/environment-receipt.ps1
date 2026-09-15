[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot,

    [Parameter(Mandatory = $true)]
    [string]$ManifestPath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [string]$CopilotExecutable
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$manifest = (Resolve-Path -LiteralPath $ManifestPath).Path
$qualificationRoot = $PSScriptRoot
$adapterRoot = (Resolve-Path (Join-Path $qualificationRoot "..\foundry-session-probe")).Path
$packageLockPath = Join-Path $adapterRoot "package-lock.json"
$policyPath = Join-Path $repoRoot ".github\skills\local-agent-delegation\references\approved-routes.json"

function Get-NativeCopilot {
    if ($CopilotExecutable) {
        $resolved = (Resolve-Path -LiteralPath $CopilotExecutable -ErrorAction Stop).Path
        if ((Get-Item -LiteralPath $resolved).Length -le 0) {
            throw "The pinned Copilot executable is empty."
        }
        return $resolved
    }
    $commands = @(Get-Command copilot -All -ErrorAction Stop)
    $native = $commands |
        Where-Object {
            $_.CommandType -eq "Application" -and
                [System.IO.Path]::GetExtension($_.Source) -ieq ".exe" -and
                (Get-Item -LiteralPath $_.Source).Length -gt 0
        } |
        Select-Object -First 1
    if (-not $native) {
        throw "Qualification requires the native Copilot executable used by the child launcher."
    }
    return $native.Source
}

function Get-CommandOutput([string]$FileName, [string[]]$Arguments) {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FileName
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $Arguments) {
        $startInfo.ArgumentList.Add($argument)
    }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $null = $process.Start()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw "$FileName $($Arguments -join ' ') failed: $stderr"
    }
    return ($stdout + $stderr).Trim()
}

function Get-HashReceipt([string]$Path) {
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $normalized = (Get-Content -LiteralPath $resolved -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
    $hash = [Convert]::ToHexString(
        [System.Security.Cryptography.SHA256]::HashData(
            [System.Text.Encoding]::UTF8.GetBytes($normalized)
        )
    ).ToLowerInvariant()
    return [ordered]@{
        path = $resolved
        sha256 = $hash
        hash_mode = "utf8-lf"
    }
}

function Get-BinaryTreeReceipt([string]$Path) {
    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    if (-not (Get-Item -LiteralPath $resolved).PSIsContainer) {
        throw "Native runtime path is not a directory: $resolved"
    }
    $files = @(Get-ChildItem -LiteralPath $resolved -Recurse -File |
        Sort-Object FullName |
        ForEach-Object {
            [ordered]@{
                path = [System.IO.Path]::GetRelativePath($resolved, $_.FullName).Replace('\', '/')
                sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                size_bytes = $_.Length
            }
        })
    if ($files.Count -eq 0) {
        throw "Native runtime path contains no files: $resolved"
    }
    $hashMaterial = ($files | ForEach-Object { "$($_.path)`0$($_.sha256)" }) -join "`n"
    $treeHash = [Convert]::ToHexString(
        [System.Security.Cryptography.SHA256]::HashData(
            [System.Text.Encoding]::UTF8.GetBytes($hashMaterial)
        )
    ).ToLowerInvariant()
    return [ordered]@{
        path = $resolved
        tree_sha256 = $treeHash
        file_count = $files.Count
        files = $files
    }
}

$copilotExecutable = Get-NativeCopilot
$copilotVersion = Get-CommandOutput $copilotExecutable @("--version")
$foundryExecutable = (Get-Command foundry -CommandType Application -ErrorAction Stop).Source
$foundryVersion = Get-CommandOutput $foundryExecutable @("--version")
$cacheLocation = Get-CommandOutput $foundryExecutable @("cache", "location", "-o", "json") |
    ConvertFrom-Json
$modelCacheOverride = $env:FOUNDRY_MODEL_CACHE
$libraryPathOverride = $env:FOUNDRY_LIBRARY_PATH
$skipInstallOverride = $env:FOUNDRY_LOCAL_SKIP_INSTALL
$effectiveModelCache = if ([string]::IsNullOrWhiteSpace($modelCacheOverride)) {
    (Resolve-Path -LiteralPath $cacheLocation.path -ErrorAction Stop).Path
} else {
    (Resolve-Path -LiteralPath $modelCacheOverride -ErrorAction Stop).Path
}
if (-not [string]::IsNullOrWhiteSpace($modelCacheOverride) -and
    [System.IO.Path]::GetFullPath($cacheLocation.path).TrimEnd('\') -ine
        [System.IO.Path]::GetFullPath($effectiveModelCache).TrimEnd('\')) {
    throw "Foundry CLI cache location does not match FOUNDRY_MODEL_CACHE."
}
$nodePlatform = Get-CommandOutput "node" @("-p", "process.platform + '-' + process.arch")
$sdkRoot = Join-Path $adapterRoot "node_modules\foundry-local-sdk"
$defaultLibraryPath = Join-Path $sdkRoot "prebuilds\$nodePlatform"
$effectiveLibraryPath = if ([string]::IsNullOrWhiteSpace($libraryPathOverride)) {
    (Resolve-Path -LiteralPath $defaultLibraryPath -ErrorAction Stop).Path
} else {
    (Resolve-Path -LiteralPath $libraryPathOverride -ErrorAction Stop).Path
}
if (-not [string]::IsNullOrWhiteSpace($skipInstallOverride) -and
    [string]::IsNullOrWhiteSpace($libraryPathOverride)) {
    throw "FOUNDRY_LOCAL_SKIP_INSTALL requires an explicit FOUNDRY_LIBRARY_PATH."
}
$nativeRuntime = Get-BinaryTreeReceipt $effectiveLibraryPath
$cachedModels = Get-CommandOutput $foundryExecutable @(
    "model", "list", "--cached", "--variants",
    "--search", "qwen2.5-7b-instruct-generic-gpu", "-o", "json"
) | ConvertFrom-Json
$targetModel = @($cachedModels.variants) |
    Where-Object variantId -eq "qwen2.5-7b-instruct-generic-gpu:4" |
    Select-Object -First 1
if (-not $targetModel -or -not $targetModel.cached) {
    throw "The exact target model qwen2.5-7b-instruct-generic-gpu:4 is not cached."
}

$packageLock = Get-Content -LiteralPath $packageLockPath -Raw | ConvertFrom-Json -AsHashTable
$sdkVersion = $packageLock["packages"]["node_modules/foundry-local-sdk"]["version"]
if ($sdkVersion -ne "2.0.1") {
    throw "The Session qualification requires foundry-local-sdk 2.0.1; found $sdkVersion."
}

$corpusJson = & node (Join-Path $qualificationRoot "validate-corpus.mjs") $manifest --compact
if ($LASTEXITCODE -ne 0) {
    throw "Corpus validation failed."
}
$corpus = $corpusJson | ConvertFrom-Json

$operatingSystem = Get-CimInstance Win32_OperatingSystem
$computerSystem = Get-CimInstance Win32_ComputerSystem
$processors = @(Get-CimInstance Win32_Processor)
$videoControllers = @(Get-CimInstance Win32_VideoController)
$filesToHash = @(
    $policyPath
    $manifest
    (Join-Path $qualificationRoot "prompt-template.txt")
    (Join-Path $qualificationRoot "runner.mjs")
    (Join-Path $qualificationRoot "attempt-execution.mjs")
    (Join-Path $qualificationRoot "grader.mjs")
    (Join-Path $qualificationRoot "qualification-lib.mjs")
    (Join-Path $qualificationRoot "failure-injection-lib.mjs")
    (Join-Path $qualificationRoot "failure-injection.mjs")
    (Join-Path $qualificationRoot "report.mjs")
    (Join-Path $qualificationRoot "environment-receipt.ps1")
    (Join-Path $adapterRoot "adapter.mjs")
    (Join-Path $repoRoot ".github\skills\local-agent-delegation\scripts\invoke_local_agent.ps1")
)

$receipt = [ordered]@{
    schema_version = "sealed-delegation/session-environment/v2"
    recorded_at = (Get-Date).ToUniversalTime().ToString("o")
    repository = [ordered]@{
        root = $repoRoot
        commit_sha = (git -C $repoRoot rev-parse HEAD).Trim()
        branch = (git -C $repoRoot rev-parse --abbrev-ref HEAD).Trim()
        clean = [string]::IsNullOrWhiteSpace((git -C $repoRoot status --short))
    }
    route = [ordered]@{
        runtime = "foundry-local-session"
        model = "qwen2.5-7b-instruct-generic-gpu:4"
        stream = "on"
        tools = @("view")
        profile = "read"
        task_mode = "evidence-check"
        max_prompt_tokens = 16384
    }
    copilot = [ordered]@{
        executable = $copilotExecutable
        executable_sha256 = (Get-FileHash -LiteralPath $copilotExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
        version_output = $copilotVersion
    }
    foundry_cli = [ordered]@{
        executable = $foundryExecutable
        version = $foundryVersion
        cache_location = $cacheLocation.path
    }
    foundry_sdk = [ordered]@{
        package = "foundry-local-sdk"
        version = $sdkVersion
        package_lock = $packageLockPath
    }
    model_cache = $targetModel
    runtime_paths = [ordered]@{
        model_cache = [ordered]@{
            effective_path = $effectiveModelCache
            override_present = -not [string]::IsNullOrWhiteSpace($modelCacheOverride)
            override_value = $(if ([string]::IsNullOrWhiteSpace($modelCacheOverride)) { $null } else { $modelCacheOverride })
        }
        native_library = [ordered]@{
            effective_path = $effectiveLibraryPath
            override_present = -not [string]::IsNullOrWhiteSpace($libraryPathOverride)
            override_value = $(if ([string]::IsNullOrWhiteSpace($libraryPathOverride)) { $null } else { $libraryPathOverride })
            skip_install_override = $(if ([string]::IsNullOrWhiteSpace($skipInstallOverride)) { $null } else { $skipInstallOverride })
            runtime = $nativeRuntime
        }
    }
    adapter = [ordered]@{
        bind_address = "127.0.0.1"
        port = 0
        port_selection = "ephemeral"
        model_alias = $targetModel.alias
        telemetry = "per-request JSONL without prompts or response content"
        lifecycle = "started immediately before serial qualification and closed immediately after"
    }
    host = [ordered]@{
        os = $operatingSystem.Caption
        os_version = $operatingSystem.Version
        architecture = $operatingSystem.OSArchitecture
        manufacturer = $computerSystem.Manufacturer
        model = $computerSystem.Model
        memory_bytes = [int64]$computerSystem.TotalPhysicalMemory
        processors = @($processors | ForEach-Object {
            [ordered]@{
                name = $_.Name.Trim()
                cores = $_.NumberOfCores
                logical_processors = $_.NumberOfLogicalProcessors
            }
        })
        accelerators = @($videoControllers | ForEach-Object {
            [ordered]@{
                name = $_.Name
                driver_version = $_.DriverVersion
                adapter_ram = $_.AdapterRAM
            }
        })
    }
    corpus = $corpus
    file_hashes = @($filesToHash | ForEach-Object { Get-HashReceipt $_ })
}

$outputDirectory = Split-Path -Parent $OutputPath
if ($outputDirectory) {
    New-Item -ItemType Directory -Force $outputDirectory | Out-Null
}
$receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $OutputPath -Encoding utf8
$receipt | ConvertTo-Json -Depth 10
