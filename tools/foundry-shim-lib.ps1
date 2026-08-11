function Get-LocalDelegationFoundryStatus {
    [CmdletBinding()]
    param(
        [int]$TimeoutSeconds = 60
    )

    $foundry = foundry status -o json | ConvertFrom-Json
    if (-not $foundry.service.ready) {
        $serverStartOutput = (& foundry server start 2>&1 | Out-String).Trim()
        $serverStartExit = $LASTEXITCODE
        if ($serverStartExit -ne 0) {
            throw "Foundry Local server failed to start: $serverStartOutput"
        }
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        do {
            Start-Sleep -Seconds 2
            $foundry = foundry status -o json | ConvertFrom-Json
        } until ($foundry.service.ready -or (Get-Date) -gt $deadline)
    }
    if (-not $foundry.service.ready -or -not $foundry.service.webUrls) {
        throw "Foundry Local is not ready."
    }
    return $foundry
}

function Invoke-LocalDelegationFoundryModelHealth {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$BaseUrl,

        [Parameter(Mandatory)]
        [string]$Model
    )

    $body = @{
        model = $Model
        temperature = 0
        max_tokens = 8
        messages = @(@{ role = "user"; content = "Reply exactly READY" })
    } | ConvertTo-Json -Depth 5
    Invoke-RestMethod `
        "$($BaseUrl.TrimEnd('/'))/v1/chat/completions" `
        -Method Post `
        -ContentType "application/json" `
        -Body $body `
        -TimeoutSec 120 `
        -NoProxy `
        -MaximumRedirection 0
}

function Initialize-LocalDelegationFoundryModel {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Model,

        [Parameter(Mandatory)]
        [string]$FoundryAlias,

        [string]$ReceiptPath
    )

    $attempts = [System.Collections.Generic.List[object]]::new()
    $loadAttempted = $false
    $loadOutput = $null
    $lastError = $null
    try {
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            $foundry = Get-LocalDelegationFoundryStatus
            $upstream = $foundry.service.webUrls[0]
            try {
                $null = Invoke-LocalDelegationFoundryModelHealth -BaseUrl $upstream -Model $Model
                $attempts.Add([ordered]@{
                    attempt = $attempt
                    upstream = $upstream
                    action = $(if ($loadAttempted) { "post-load-health" } else { "health" })
                    status = "READY"
                    error = $null
                })
                $document = [ordered]@{
                    schema_version = "sealed-delegation/foundry-runtime/v1"
                    status = "READY"
                    model = $Model
                    foundry_alias = $FoundryAlias
                    final_upstream = $upstream
                    load_attempted = $loadAttempted
                    load_output = $loadOutput
                    attempts = @($attempts)
                }
                if ($ReceiptPath) {
                    $document | ConvertTo-Json -Depth 6 | Set-Content $ReceiptPath -Encoding utf8
                }
                return [pscustomobject]$document
            } catch {
                $lastError = $_.Exception.Message
                $attempts.Add([ordered]@{
                    attempt = $attempt
                    upstream = $upstream
                    action = $(if ($loadAttempted) { "post-load-health" } else { "health" })
                    status = "FAILED"
                    error = $lastError
                })
            }

            Start-Sleep -Seconds 2
            if ($attempt -eq 2 -and -not $loadAttempted) {
                $loadOutput = (& foundry model load $FoundryAlias 2>&1 | Out-String).Trim()
                $loadExit = $LASTEXITCODE
                if ($loadExit -ne 0) {
                    throw "Foundry Local failed to load model '$FoundryAlias': $loadOutput"
                }
                $loadAttempted = $true
            }
        }
        throw "Foundry Local model '$Model' did not become healthy after port rediscovery and model load. Last error: $lastError"
    } catch {
        if ($ReceiptPath) {
            [ordered]@{
                schema_version = "sealed-delegation/foundry-runtime/v1"
                status = "FAILED"
                model = $Model
                foundry_alias = $FoundryAlias
                final_upstream = $(if ($foundry) { $foundry.service.webUrls[0] } else { $null })
                load_attempted = $loadAttempted
                load_output = $loadOutput
                attempts = @($attempts)
                error = $_.Exception.Message
            } | ConvertTo-Json -Depth 6 | Set-Content $ReceiptPath -Encoding utf8
        }
        throw
    }
}

function Start-LocalDelegationFoundryShim {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,

        [Parameter(Mandatory)]
        [string]$LogDirectory,

        [string]$Model,

        [string]$FoundryAlias,

        [int]$Port = 0
    )

    New-Item -ItemType Directory -Force $LogDirectory | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $runtimeReceipt = Join-Path $LogDirectory "runtime-$stamp.json"
    $foundry = if ($Model) {
        $alias = if ($FoundryAlias) { $FoundryAlias } else { $Model }
        $runtime = Initialize-LocalDelegationFoundryModel `
            -Model $Model `
            -FoundryAlias $alias `
            -ReceiptPath $runtimeReceipt
        Get-LocalDelegationFoundryStatus
    } else {
        Get-LocalDelegationFoundryStatus
    }

    if ($Port -eq 0) {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $Port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
        $listener.Stop()
    }

    $shim = Join-Path $RepoRoot "tools\foundry-stream-shim.mjs"
    if (-not (Test-Path $shim -PathType Leaf)) {
        throw "Foundry stream shim is missing: $shim"
    }

    $stdoutLog = Join-Path $LogDirectory "shim-$stamp.stdout.log"
    $stderrLog = Join-Path $LogDirectory "shim-$stamp.stderr.log"
    $env:UPSTREAM = $foundry.service.webUrls[0]
    $env:SHIM_PORT = [string]$Port
    $process = Start-Process `
        -FilePath (Get-Command node -CommandType Application).Source `
        -ArgumentList "`"$shim`"" `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog `
        -WindowStyle Hidden `
        -PassThru
    $baseUrl = "http://127.0.0.1:$Port"
    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 500
        try {
            $null = Invoke-RestMethod "$baseUrl/v1/models" -TimeoutSec 3 -NoProxy -MaximumRedirection 0
            $ready = $true
        } catch {
            $ready = $false
        }
    } until ($ready -or $process.HasExited -or (Get-Date) -gt $deadline)

    if (-not $ready) {
        $failure = if ($process.HasExited) {
            "process exited with code $($process.ExitCode) without listening"
        } else {
            "startup timed out"
        }
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force
        }
        $stdoutTail = if (Test-Path -LiteralPath $stdoutLog) {
            (Get-Content -LiteralPath $stdoutLog -Tail 20 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
        }
        $stderrTail = if (Test-Path -LiteralPath $stderrLog) {
            (Get-Content -LiteralPath $stderrLog -Tail 20 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
        }
        $details = @(
            if ($stderrTail) { "stderr: $stderrTail" }
            if ($stdoutTail) { "stdout: $stdoutTail" }
        )
        $detailText = if ($details.Count -gt 0) { " $($details -join ' ')" } else { "" }
        throw "Foundry stream shim failed: $failure.$detailText Logs: $stdoutLog, $stderrLog."
    }

    [pscustomobject]@{
        Process = $process
        ProcessId = $process.Id
        BaseUrl = $baseUrl
        Upstream = $foundry.service.webUrls[0]
        StdoutLog = $stdoutLog
        StderrLog = $stderrLog
        RuntimeReceipt = $(if ($Model) { $runtimeReceipt } else { $null })
    }
}

function Stop-LocalDelegationFoundryShim {
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$Shim
    )

    if ($Shim.Process -and -not $Shim.Process.HasExited) {
        Stop-Process -Id $Shim.ProcessId -Force
        $null = $Shim.Process.WaitForExit(5000)
    }
}
