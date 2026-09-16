function Assert-RequiredByomArtifacts {
    param(
        [Parameter(Mandatory)]
        [object[]]$Files,

        [Parameter(Mandatory)]
        [string[]]$Patterns
    )

    if ($Files.Count -eq 0) {
        throw "Converted model directory is empty."
    }
    foreach ($pattern in $Patterns) {
        $matches = @($Files | Where-Object Name -Like $pattern)
        if ($matches.Count -eq 0) {
            throw "Converted model is missing required artifact pattern: $pattern"
        }
        if (-not ($matches | Where-Object Length -GT 0)) {
            throw "Converted model has only empty files for required artifact pattern: $pattern"
        }
    }
}
