function Get-LocalAgentOutputFailureReason {
    param(
        [AllowEmptyString()]
        [string]$Stdout,

        [int]$StagedInputCount = 0
    )

    if ([string]::IsNullOrWhiteSpace($Stdout)) {
        return "empty_stdout"
    }

    if ($Stdout.TrimStart().StartsWith("<tool_call>", [StringComparison]::Ordinal)) {
        return "raw_tool_call_markup"
    }

    $accessFailurePattern = "(?i)\b(permission denied|permission issue(?: accessing)?|(?:necessary|required) permissions to (?:read|access)|unable to (?:read|access) (?:the )?(?:file|specified file)|ensure you have (?:the )?(?:necessary )?permissions|review (?:the )?file permissions|check (?:the )?file permissions)\b"
    if ($StagedInputCount -gt 0 -and $Stdout -match $accessFailurePattern) {
        return "staged_input_access_claim"
    }

    return $null
}
