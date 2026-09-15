function Resolve-SafeByomPath {
    param(
        [Parameter(Mandatory)]
        [string]$BaseRoot,

        [Parameter(Mandatory)]
        [string]$RelativePath,

        [Parameter(Mandatory)]
        [string]$Label,

        [string]$TrustedRoot = $BaseRoot
    )

    if ([System.IO.Path]::IsPathRooted($RelativePath)) {
        throw "$Label must be relative."
    }

    $base = [System.IO.Path]::GetFullPath($BaseRoot).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $trusted = [System.IO.Path]::GetFullPath($TrustedRoot).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    if (
        $base -ne $trusted -and
        -not $base.StartsWith(
            $trusted + [System.IO.Path]::DirectorySeparatorChar,
            [System.StringComparison]::OrdinalIgnoreCase
        )
    ) {
        throw "$Label base root must be beneath the trusted root."
    }
    $resolved = [System.IO.Path]::GetFullPath((Join-Path $base $RelativePath))
    $prefix = $base + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must resolve beneath $base."
    }

    if (Test-Path -LiteralPath $trusted) {
        $trustedItem = Get-Item -LiteralPath $trusted -Force
        if (($trustedItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Label trusted root is a reparse point: $trusted"
        }
    }

    $current = $trusted
    $relative = [System.IO.Path]::GetRelativePath($trusted, $resolved)
    foreach ($segment in ($relative -split '[\\/]' | Where-Object { $_ })) {
        $current = Join-Path $current $segment
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$Label traverses a reparse point: $current"
            }
        }
    }

    return $resolved
}
