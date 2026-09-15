[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$CandidatePath,

    [string]$Python = "python",

    [switch]$Execute
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
. (Join-Path $root "path-policy.ps1")
. (Join-Path $root "recipe-policy.ps1")
$candidateResult = & node (Join-Path $root "validate-candidate.mjs") $CandidatePath | ConvertFrom-Json
if ($candidateResult.status -ne "VALID") {
    throw "Candidate manifest is invalid."
}

$candidate = Get-Content -LiteralPath $candidateResult.path -Raw | ConvertFrom-Json
$repoRoot = (Resolve-Path (Join-Path $root "..\..")).Path
$allowedOutputRoot = Join-Path $repoRoot "results\byom"
$candidateRoot = Resolve-SafeByomPath `
    -BaseRoot $allowedOutputRoot `
    -RelativePath $candidate.artifact.output_directory.Substring("results/byom/".Length) `
    -Label "artifact.output_directory" `
    -TrustedRoot $repoRoot
$lockPath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $candidate.conversion.requirements_lock_path))
$expectedLockRoot = Join-Path $repoRoot "tools\byom-intake"
$lockPath = Resolve-SafeByomPath `
    -BaseRoot $expectedLockRoot `
    -RelativePath $candidate.conversion.requirements_lock_path.Substring("tools/byom-intake/".Length) `
    -Label "requirements_lock_path" `
    -TrustedRoot $repoRoot
$lockHash = (Get-FileHash $lockPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($lockHash -ne $candidate.conversion.requirements_lock_sha256) {
    throw "Requirements lock hash does not match the candidate manifest."
}
$attemptId = if ($Execute) {
    (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
} else {
    "preparation"
}
New-Item -ItemType Directory -Force $candidateRoot | Out-Null
$attemptsRoot = Resolve-SafeByomPath -BaseRoot $candidateRoot -RelativePath "attempts" -Label "attempts directory" -TrustedRoot $repoRoot
New-Item -ItemType Directory -Force $attemptsRoot | Out-Null
$attemptRoot = Resolve-SafeByomPath -BaseRoot $attemptsRoot -RelativePath $attemptId -Label "attempt directory" -TrustedRoot $repoRoot
New-Item -ItemType Directory -Force $attemptRoot | Out-Null
$workRoot = Resolve-SafeByomPath -BaseRoot $attemptRoot -RelativePath "work" -Label "work directory" -TrustedRoot $repoRoot
New-Item -ItemType Directory -Force $workRoot | Out-Null
$recipeRoot = Resolve-SafeByomPath -BaseRoot $workRoot -RelativePath "recipe" -Label "recipe directory" -TrustedRoot $repoRoot
$recipePath = Join-Path $recipeRoot ([System.IO.Path]::GetFileName($candidate.conversion.recipe_path))
$resolvedConfigPath = Join-Path $workRoot "resolved-olive-config.json"
$receiptPath = Join-Path $attemptRoot "conversion-receipt.json"
$preparationReceiptPath = Join-Path $attemptRoot "preparation-receipt.json"

New-Item -ItemType Directory -Force $recipeRoot | Out-Null

$recipeBaseUrl = "https://raw.githubusercontent.com/$($candidate.conversion.recipe_repository)/$($candidate.conversion.recipe_revision)/"
$recipeUri = [Uri]::new([Uri]$recipeBaseUrl, $candidate.conversion.recipe_path)
if (-not $recipeUri.AbsoluteUri.StartsWith($recipeBaseUrl, [System.StringComparison]::Ordinal)) {
    throw "Recipe URI escaped the pinned repository and revision."
}
$recipeUrl = $recipeUri.AbsoluteUri
Invoke-WebRequest -Uri $recipeUrl -OutFile $recipePath -MaximumRedirection 0

$recipe = Get-Content -LiteralPath $recipePath -Raw | ConvertFrom-Json
$effectiveRecipe = Assert-ByomRecipeMatchesCandidate -Candidate $candidate -Recipe $recipe
$recipe.input_model.model_path = $candidate.source.repository
$recipe.input_model | Add-Member -NotePropertyName "load_kwargs" -NotePropertyValue ([pscustomobject]@{
    revision = $candidate.source.revision
    trust_remote_code = $false
}) -Force
$recipe.passes.optimum_convert.extra_args | Add-Member `
    -NotePropertyName "revision" `
    -NotePropertyValue $candidate.source.revision `
    -Force
$recipe.passes.optimum_convert.extra_args | Add-Member `
    -NotePropertyName "trust_remote_code" `
    -NotePropertyValue $false `
    -Force
$modelOutput = Resolve-SafeByomPath -BaseRoot $attemptRoot -RelativePath "model" -Label "model output directory" -TrustedRoot $repoRoot
$oliveCache = Resolve-SafeByomPath -BaseRoot $workRoot -RelativePath "olive-cache" -Label "Olive cache directory" -TrustedRoot $repoRoot
if ($IsWindows) {
    $longestExpectedPath = Join-Path $oliveCache "default_workflow\evaluations"
    if ($longestExpectedPath.Length -ge 240) {
        throw "The candidate output path is too long for reliable Olive operation on Windows ($($longestExpectedPath.Length) characters). Use a shorter artifact.output_directory."
    }
}
$recipe.output_dir = $modelOutput.Replace("\", "/")
$recipe.cache_dir = $oliveCache.Replace("\", "/")
$recipe | ConvertTo-Json -Depth 20 | Set-Content $resolvedConfigPath -Encoding utf8

$pythonVersion = (& $Python --version 2>&1 | Out-String).Trim()
$oliveVersion = ""
$oliveExit = 0
try {
    $oliveVersion = (& $Python -c "import olive; print(olive.__version__)" 2>&1 | Out-String).Trim()
} catch {
    $oliveExit = 1
}

$packageVersions = & $Python -c @"
import importlib.metadata as m, json
names = [
    "numpy",
    "openvino",
    "openvino-tokenizers",
    "onnxruntime-openvino",
    "optimum-intel",
    "nncf",
]
print(json.dumps({name: m.version(name) for name in names}))
"@ | ConvertFrom-Json

$installedDistributions = @(& $Python -m pip freeze --all | Sort-Object)
$installedMap = @{}
$environmentMismatches = @()
foreach ($line in $installedDistributions) {
    if ($line -match '^([A-Za-z0-9_.-]+)==(.+)$') {
        $name = ($Matches[1].ToLowerInvariant() -replace '[-_.]+', '-')
        $installedMap[$name] = $Matches[2]
    } elseif (-not [string]::IsNullOrWhiteSpace($line)) {
        $environmentMismatches += "unrecognized installed distribution: $line"
    }
}
$lockedMap = @{}
foreach ($line in Get-Content -LiteralPath $lockPath) {
    if ($line -match '^([A-Za-z0-9_.-]+)==([^\s\\]+)') {
        $name = ($Matches[1].ToLowerInvariant() -replace '[-_.]+', '-')
        $lockedMap[$name] = $Matches[2]
    }
}
foreach ($name in $lockedMap.Keys) {
    if (-not $installedMap.ContainsKey($name) -or $installedMap[$name] -ne $lockedMap[$name]) {
        $environmentMismatches += "${name}: expected $($lockedMap[$name]), got $($installedMap[$name])"
    }
}
foreach ($name in $installedMap.Keys) {
    if (-not $lockedMap.ContainsKey($name)) {
        $environmentMismatches += "${name}: installed but absent from lock"
    }
}

$receipt = [ordered]@{
    schema_version = "sealed-delegation/byom-conversion-receipt/v1"
    candidate_id = $candidate.candidate_id
    prepared_at = (Get-Date).ToUniversalTime().ToString("o")
    candidate_path = $candidateResult.path
    candidate_sha256 = (Get-FileHash $candidateResult.path -Algorithm SHA256).Hash.ToLowerInvariant()
    source_repository = $candidate.source.repository
    source_revision = $candidate.source.revision
    license_id = $candidate.source.license_id
    license_url = $candidate.source.license_url
    recipe_url = $recipeUrl
    recipe_revision = $candidate.conversion.recipe_revision
    recipe_sha256 = (Get-FileHash $recipePath -Algorithm SHA256).Hash.ToLowerInvariant()
    effective_device = $effectiveRecipe.device
    effective_execution_provider = $effectiveRecipe.execution_provider
    effective_precision = $effectiveRecipe.precision
    resolved_config_path = $resolvedConfigPath
    resolved_config_sha256 = (Get-FileHash $resolvedConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
    candidate_root = $candidateRoot
    attempt_id = $attemptId
    attempt_root = $attemptRoot
    output_root = $attemptRoot
    python = $pythonVersion
    expected_olive_version = $candidate.conversion.olive_version
    installed_olive_version = $oliveVersion
    installed_environment = [ordered]@{
        python_version = $pythonVersion.Replace("Python ", "")
        numpy_version = $packageVersions.numpy
        openvino_version = $packageVersions.openvino
        openvino_tokenizers_version = $packageVersions.'openvino-tokenizers'
        onnxruntime_openvino_version = $packageVersions.'onnxruntime-openvino'
        optimum_intel_version = $packageVersions.'optimum-intel'
        nncf_version = $packageVersions.nncf
    }
    requirements_lock_path = $lockPath
    requirements_lock_sha256 = $lockHash
    installed_distributions = $installedDistributions
    installed_distributions_sha256 = (
        [System.BitConverter]::ToString(
            [System.Security.Cryptography.SHA256]::HashData(
                [System.Text.Encoding]::UTF8.GetBytes(($installedDistributions -join "`n") + "`n")
            )
        ).Replace("-", "").ToLowerInvariant()
    )
    environment_mismatches = $environmentMismatches
    executed = $false
    exit_code = $null
    started_at = $null
    finished_at = $null
}

$receipt | ConvertTo-Json -Depth 8 | Set-Content $preparationReceiptPath -Encoding utf8
if (-not $Execute) {
    $receipt | ConvertTo-Json -Depth 8
    exit 0
}

if ($oliveExit -ne 0 -or $oliveVersion -ne $candidate.conversion.olive_version) {
    throw "Olive $($candidate.conversion.olive_version) is required; installed version: '$oliveVersion'."
}
if ($environmentMismatches.Count -gt 0) {
    throw "Installed environment differs from the hash-locked requirements: $($environmentMismatches -join '; ')"
}
foreach ($field in $candidate.conversion.environment.PSObject.Properties.Name) {
    $actual = $receipt.installed_environment[$field]
    $expected = $candidate.conversion.environment.$field
    if ($actual -ne $expected) {
        throw "Conversion environment mismatch for ${field}: expected '$expected', got '$actual'."
    }
}

$openvinoLib = (& $Python -c "import openvino,pathlib; print(pathlib.Path(openvino.__file__).parent/'libs')" | Out-String).Trim()
$env:PATH = "$openvinoLib;$env:PATH"

$receipt.executed = $true
$receipt.started_at = (Get-Date).ToUniversalTime().ToString("o")
& $Python -m olive run --config $resolvedConfigPath
$receipt.exit_code = $LASTEXITCODE
$receipt.finished_at = (Get-Date).ToUniversalTime().ToString("o")
$receipt | ConvertTo-Json -Depth 8 | Set-Content $receiptPath -Encoding utf8
$receipt | ConvertTo-Json -Depth 8
if ($receipt.exit_code -ne 0) { exit $receipt.exit_code }
