#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "foundry-shim-lib.ps1")

$temporary = New-Item -ItemType Directory -Force (
    Join-Path $env:TEMP ("foundry-shim-lib-test-" + [guid]::NewGuid().ToString("N"))
)
try {
    function Start-Sleep {}
    function foundry {
        $script:loadCalls++
        $global:LASTEXITCODE = 0
    }

    $script:statusUrls = @("http://127.0.0.1:58890", "http://127.0.0.1:51090")
    $script:statusIndex = 0
    $script:healthFailures = 1
    $script:healthCalls = 0
    $script:loadCalls = 0
    function Get-LocalDelegationFoundryStatus {
        $index = [Math]::Min($script:statusIndex, $script:statusUrls.Count - 1)
        $script:statusIndex++
        [pscustomobject]@{
            service = [pscustomobject]@{
                ready = $true
                webUrls = @($script:statusUrls[$index])
            }
        }
    }
    function Invoke-LocalDelegationFoundryModelHealth {
        param([string]$BaseUrl, [string]$Model)
        $script:healthCalls++
        if ($script:healthCalls -le $script:healthFailures) {
            throw "simulated stale upstream"
        }
        [pscustomobject]@{ status = "READY"; base_url = $BaseUrl; model = $Model }
    }

    $rediscoveryReceipt = Join-Path $temporary "rediscovery.json"
    $rediscovery = Initialize-LocalDelegationFoundryModel `
        -Model "fixture-model" `
        -FoundryAlias "fixture-alias" `
        -ReceiptPath $rediscoveryReceipt
    if ($rediscovery.final_upstream -ne "http://127.0.0.1:51090") {
        throw "dynamic upstream was not rediscovered"
    }
    if ($rediscovery.load_attempted -or $script:loadCalls -ne 0) {
        throw "model load ran before port rediscovery was retried"
    }
    if (-not (Test-Path -LiteralPath $rediscoveryReceipt -PathType Leaf)) {
        throw "runtime stabilization receipt was not written"
    }

    $script:statusUrls = @(
        "http://127.0.0.1:50001",
        "http://127.0.0.1:50001",
        "http://127.0.0.1:50002"
    )
    $script:statusIndex = 0
    $script:healthFailures = 2
    $script:healthCalls = 0
    $script:loadCalls = 0
    $loadReceipt = Join-Path $temporary "load.json"
    $loaded = Initialize-LocalDelegationFoundryModel `
        -Model "fixture-model" `
        -FoundryAlias "fixture-alias" `
        -ReceiptPath $loadReceipt
    if (-not $loaded.load_attempted -or $script:loadCalls -ne 1) {
        throw "model load fallback did not run exactly once"
    }
    if ($loaded.final_upstream -ne "http://127.0.0.1:50002") {
        throw "post-load upstream was not captured"
    }

    Write-Host "PASS: Foundry runtime stabilization checks"
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
