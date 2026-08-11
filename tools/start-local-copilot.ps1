[CmdletBinding()]
param(
    [string]$WorkingDirectory = (Get-Location).Path,
    [string]$Name = "local-desk",
    [string]$WorkshopDir,
    [string]$Model = "qwen2.5-7b-instruct-generic-gpu",
    [int]$MaxPromptTokens = 16384,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "foundry-shim-lib.ps1")

if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
    throw "Name must be a simple 1-64 character desk identifier."
}
$working = (Resolve-Path -LiteralPath $WorkingDirectory).Path
if (-not (Test-Path -LiteralPath $working -PathType Container)) {
    throw "WorkingDirectory must be an existing directory."
}
$workshop = if ($WorkshopDir) { (Resolve-Path -LiteralPath $WorkshopDir).Path } else { $null }
$copilot = (Get-Command copilot -CommandType Application -ErrorAction Stop).Source
$arguments = @(
    "--name", $Name,
    "--stream", "on",
    "--no-custom-instructions",
    "--available-tools=view,glob",
    "-C", $working
)
if ($workshop) {
    $arguments += @("--add-dir", $workshop)
}

if ($DryRun) {
    [pscustomobject]@{
        status = "DRY_RUN"
        copilot = $copilot
        name = $Name
        working_directory = $working
        workshop_directory = $workshop
        model = $Model
        max_prompt_tokens = $MaxPromptTokens
        available_tools = @("view", "glob")
        arguments = @($arguments)
    } | ConvertTo-Json -Depth 4
    exit 0
}

$stateRoot = Join-Path $env:LOCALAPPDATA ("SealedDelegation\workshop\" + $Name)
$home = New-Item -ItemType Directory -Force (Join-Path $stateRoot "home")
$appData = New-Item -ItemType Directory -Force (Join-Path $home "AppData\Roaming")
$localAppData = New-Item -ItemType Directory -Force (Join-Path $home "AppData\Local")
$temp = New-Item -ItemType Directory -Force (Join-Path $stateRoot "temp")
$logs = New-Item -ItemType Directory -Force (Join-Path $stateRoot "runtime")

$keys = @(
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
    "COPILOT_PROVIDER_BASE_URL", "COPILOT_PROVIDER_TYPE", "COPILOT_PROVIDER_API_KEY",
    "COPILOT_PROVIDER_WIRE_API", "COPILOT_MODEL",
    "COPILOT_PROVIDER_MAX_PROMPT_TOKENS", "COPILOT_PROVIDER_MAX_OUTPUT_TOKENS"
)
$saved = @{}
foreach ($key in $keys) {
    $saved[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
}

$shim = $null
try {
    $shim = Start-LocalDelegationFoundryShim `
        -RepoRoot $root `
        -LogDirectory $logs.FullName `
        -Model $Model `
        -FoundryAlias $Model

    $env:HOME = $home.FullName
    $env:USERPROFILE = $home.FullName
    $env:APPDATA = $appData.FullName
    $env:LOCALAPPDATA = $localAppData.FullName
    $env:TEMP = $temp.FullName
    $env:TMP = $temp.FullName
    $env:COPILOT_PROVIDER_BASE_URL = "$($shim.BaseUrl)/v1"
    $env:COPILOT_PROVIDER_TYPE = "openai"
    $env:COPILOT_PROVIDER_API_KEY = "foundry-local"
    $env:COPILOT_PROVIDER_WIRE_API = "completions"
    $env:COPILOT_MODEL = $Model
    $env:COPILOT_PROVIDER_MAX_PROMPT_TOKENS = [string]$MaxPromptTokens
    $env:COPILOT_PROVIDER_MAX_OUTPUT_TOKENS = "1024"

    Write-Host "Starting read-only local Copilot desk '$Name'. Exit Copilot to stop the temporary shim."
    & $copilot @arguments
    exit $LASTEXITCODE
} finally {
    if ($shim) {
        Stop-LocalDelegationFoundryShim $shim
    }
    foreach ($key in $keys) {
        [Environment]::SetEnvironmentVariable($key, $saved[$key], "Process")
    }
}
