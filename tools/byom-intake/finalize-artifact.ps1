[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$CandidatePath,

    [Parameter(Mandatory)]
    [string]$ConversionReceiptPath
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
. (Join-Path $root "path-policy.ps1")
. (Join-Path $root "artifact-policy.ps1")
$repoRoot = (Resolve-Path (Join-Path $root "..\..")).Path
$candidateResult = & node (Join-Path $root "validate-candidate.mjs") $CandidatePath | ConvertFrom-Json
if ($candidateResult.status -ne "VALID") {
    throw "Candidate manifest is invalid."
}
$candidate = Get-Content -LiteralPath $candidateResult.path -Raw | ConvertFrom-Json
$allowedOutputRoot = Join-Path $repoRoot "results\byom"
$candidateRoot = Resolve-SafeByomPath `
    -BaseRoot $allowedOutputRoot `
    -RelativePath $candidate.artifact.output_directory.Substring("results/byom/".Length) `
    -Label "artifact.output_directory" `
    -TrustedRoot $repoRoot
$attemptsRoot = Resolve-SafeByomPath -BaseRoot $candidateRoot -RelativePath "attempts" -Label "attempts directory" -TrustedRoot $repoRoot
$resolvedReceiptPath = Resolve-SafeByomPath `
    -BaseRoot $attemptsRoot `
    -RelativePath ([System.IO.Path]::GetRelativePath($attemptsRoot, [System.IO.Path]::GetFullPath($ConversionReceiptPath))) `
    -Label "conversion receipt" `
    -TrustedRoot $repoRoot
if (-not (Test-Path -LiteralPath $resolvedReceiptPath -PathType Leaf)) {
    throw "A successful conversion receipt is required before finalization."
}
$conversionReceipt = Get-Content -LiteralPath $resolvedReceiptPath -Raw | ConvertFrom-Json
$attemptRoot = Resolve-SafeByomPath `
    -BaseRoot $attemptsRoot `
    -RelativePath ([System.IO.Path]::GetRelativePath($attemptsRoot, $conversionReceipt.attempt_root)) `
    -Label "attempt root" `
    -TrustedRoot $repoRoot
$expectedReceiptPath = Join-Path $attemptRoot "conversion-receipt.json"
if ($resolvedReceiptPath -ne $expectedReceiptPath) {
    throw "Conversion receipt path does not match its recorded attempt root."
}
$modelDirectory = Resolve-SafeByomPath -BaseRoot $attemptRoot -RelativePath "model" -Label "model directory" -TrustedRoot $repoRoot
if (-not (Test-Path -LiteralPath $modelDirectory -PathType Container)) {
    throw "Converted model directory is missing: $modelDirectory"
}
$candidateHash = (Get-FileHash $candidateResult.path -Algorithm SHA256).Hash.ToLowerInvariant()
if (
    -not $conversionReceipt.executed -or
    $conversionReceipt.exit_code -ne 0 -or
    $conversionReceipt.candidate_id -ne $candidate.candidate_id -or
    $conversionReceipt.candidate_sha256 -ne $candidateHash
) {
    throw "Conversion receipt does not prove a successful conversion for this candidate."
}

$foundryManifestPath = Join-Path $modelDirectory "inference_model.json"
$registrationIndexPath = Join-Path $candidateRoot "foundry.local.modelinfo.json"
$catalogIndexPath = Join-Path $candidateRoot "foundry.modelinfo.json"
foreach ($generatedMetadata in @($foundryManifestPath, $registrationIndexPath, $catalogIndexPath)) {
    Remove-Item -LiteralPath $generatedMetadata -Force -ErrorAction SilentlyContinue
}

$files = @(Get-ChildItem -LiteralPath $modelDirectory -Recurse -File)
Assert-RequiredByomArtifacts -Files $files -Patterns $candidate.artifact.required_artifacts
$finishedAt = [DateTimeOffset]::Parse($conversionReceipt.finished_at).UtcDateTime.AddSeconds(5)
if ($files | Where-Object LastWriteTimeUtc -gt $finishedAt) {
    throw "Converted artifact contains files modified after the successful conversion receipt."
}
$totalBytes = ($files | Measure-Object Length -Sum).Sum
if ($totalBytes -gt $candidate.artifact.expected_max_size_bytes) {
    throw "Converted artifact exceeds expected_max_size_bytes: $totalBytes"
}

$inventory = @(
    Get-ChildItem -LiteralPath $modelDirectory -Recurse -File |
        Sort-Object FullName |
        ForEach-Object {
            [ordered]@{
                path = $_.FullName.Substring($modelDirectory.Length + 1).Replace("\", "/")
                size_bytes = $_.Length
                sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
)

$finalTotalBytes = 0
foreach ($entry in $inventory) {
    $finalTotalBytes += $entry.size_bytes
}

$receipt = [ordered]@{
    schema_version = "sealed-delegation/byom-artifact-receipt/v1"
    candidate_id = $candidate.candidate_id
    finalized_at = (Get-Date).ToUniversalTime().ToString("o")
    candidate_root = $candidateRoot
    attempt_id = $conversionReceipt.attempt_id
    conversion_receipt_path = $resolvedReceiptPath
    conversion_receipt_sha256 = (Get-FileHash $resolvedReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    model_cache_dir = $attemptRoot
    model_directory = $modelDirectory
    inference_model_name = $candidate.artifact.inference_model_name
    registration_status = "not_attempted"
    intended_registration_method = "Foundry Local SDK local catalog RegisterModel"
    total_size_bytes = $finalTotalBytes
    file_count = $inventory.Count
    expected_max_size_bytes = $candidate.artifact.expected_max_size_bytes
    files = $inventory
}
$receiptPath = Join-Path $attemptRoot "artifact-receipt.json"
$receipt | ConvertTo-Json -Depth 8 | Set-Content $receiptPath -Encoding utf8
$receipt | ConvertTo-Json -Depth 8
