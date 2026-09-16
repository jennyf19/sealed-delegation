function Assert-ByomRecipeMatchesCandidate {
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$Candidate,

        [Parameter(Mandatory)]
        [pscustomobject]$Recipe
    )

    $accelerator = $Recipe.systems.local_system.accelerators[0]
    $actual = [ordered]@{
        device = $accelerator.device
        execution_provider = $accelerator.execution_providers[0]
        precision = $Recipe.passes.optimum_convert.ov_quant_config.weight_format
    }
    foreach ($field in $actual.Keys) {
        if ($actual[$field] -ne $Candidate.conversion.$field) {
            throw "Recipe $field '$($actual[$field])' does not match candidate $field '$($Candidate.conversion.$field)'."
        }
    }
    return [pscustomobject]$actual
}
