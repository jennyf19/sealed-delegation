function Get-SealedDelegationRouteDecision {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$PolicyPath,

        [Parameter(Mandatory)]
        [string]$RuntimeId,

        [Parameter(Mandatory)]
        [string]$Model,

        [Parameter(Mandatory)]
        [ValidateSet("on", "off")]
        [string]$Stream,

        [Parameter(Mandatory)]
        [int]$MaxPromptTokens,

        [Parameter(Mandatory)]
        [string]$Profile,

        [switch]$AllowUnqualifiedRoute
    )

    $resolvedPolicy = (Resolve-Path -LiteralPath $PolicyPath -ErrorAction Stop).Path
    $policy = Get-Content -LiteralPath $resolvedPolicy -Raw | ConvertFrom-Json
    if ($policy.schema_version -ne "sealed-delegation/approved-routes/v1") {
        throw "Unsupported route policy schema: $($policy.schema_version)"
    }

    $route = @($policy.routes) | Where-Object {
        $_.status -eq "qualified" -and
        $_.runtime -ceq $RuntimeId -and
        $_.model -ceq $Model -and
        $_.stream -ceq $Stream -and
        [int]$_.max_prompt_tokens -eq $MaxPromptTokens -and
        $Profile -in @($_.profiles)
    } | Select-Object -First 1

    $qualified = $null -ne $route
    if (-not $qualified -and -not $AllowUnqualifiedRoute) {
        throw "Route is not approved: runtime=$RuntimeId model=$Model stream=$Stream max_prompt_tokens=$MaxPromptTokens profile=$Profile. Use an approved route or pass -AllowUnqualifiedRoute after governance review."
    }

    [pscustomobject]@{
        policy_path = $resolvedPolicy
        policy_sha256 = (Get-FileHash -LiteralPath $resolvedPolicy -Algorithm SHA256).Hash.ToLowerInvariant()
        policy_id = $policy.policy_id
        route_id = $(if ($qualified) { $route.id } else { $null })
        qualified = $qualified
        override_used = -not $qualified
        runtime = $RuntimeId
        model = $Model
        stream = $Stream
        max_prompt_tokens = $MaxPromptTokens
        profile = $Profile
    }
}
