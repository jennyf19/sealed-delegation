function Get-LocalAgentOutputFailureReason {
    param(
        [AllowEmptyString()]
        [string]$Stdout,

        [int]$StagedInputCount = 0
    )

    if ([string]::IsNullOrWhiteSpace($Stdout)) {
        return "empty_stdout"
    }

    $diagnosticPattern = "(?im)^\s*(?:WARNING:\s*)?Package extraction took \d+ms\s*$"
    $semanticOutput = [regex]::Replace($Stdout, $diagnosticPattern, "").Trim()
    if ([string]::IsNullOrWhiteSpace($semanticOutput)) {
        return "diagnostic_only_stdout"
    }

    if ($semanticOutput.Length -gt 64 -and $semanticOutput -match '^[\"#0\s]+$') {
        return "serialization_noise_stdout"
    }

    $rawToolCallPattern = "(?s)<tool_call>\s*(?:\{|<function(?:=|>))"
    if ($semanticOutput -match $rawToolCallPattern) {
        return "raw_tool_call_markup"
    }

    $accessFailurePattern = "(?i)\b(permission denied|permission issue(?: accessing)?|(?:necessary|required) permissions to (?:read|access)|unable to (?:read|access) (?:the )?(?:file|specified file)|ensure you have (?:the )?(?:necessary )?permissions|review (?:the )?file permissions|check (?:the )?file permissions)\b"
    if ($StagedInputCount -gt 0 -and $semanticOutput -match $accessFailurePattern) {
        return "staged_input_access_claim"
    }

    return $null
}
