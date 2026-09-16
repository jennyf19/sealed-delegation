#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "recipe-policy.ps1")

$candidate = [pscustomobject]@{
    conversion = [pscustomobject]@{
        device = "gpu"
        execution_provider = "OpenVINOExecutionProvider"
        precision = "int4"
    }
}
$recipe = [pscustomobject]@{
    systems = [pscustomobject]@{
        local_system = [pscustomobject]@{
            accelerators = @(
                [pscustomobject]@{
                    device = "gpu"
                    execution_providers = @("OpenVINOExecutionProvider")
                }
            )
        }
    }
    passes = [pscustomobject]@{
        optimum_convert = [pscustomobject]@{
            ov_quant_config = [pscustomobject]@{
                weight_format = "int4"
            }
        }
    }
}

$actual = Assert-ByomRecipeMatchesCandidate -Candidate $candidate -Recipe $recipe
if ($actual.device -ne "gpu") { throw "Matching recipe did not return effective settings." }

foreach ($field in @("device", "execution_provider", "precision")) {
    $changed = $candidate | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $changed.conversion.$field = "mismatch"
    $failed = $false
    try {
        Assert-ByomRecipeMatchesCandidate -Candidate $changed -Recipe $recipe | Out-Null
    } catch {
        $failed = $_.Exception.Message -match "does not match"
    }
    if (-not $failed) { throw "Recipe mismatch was not rejected for $field." }
}

Write-Host "PASS: BYOM recipe policy checks"
