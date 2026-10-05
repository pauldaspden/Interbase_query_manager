# InterBase DB discovery across server shares (numeric mode selection)
# Modes:
#   0 = All DBs (default)             -> all *.IB files (numeric exclusions still apply)
#   1 = Affinity DBs                  -> only 4-digit numeric filenames (and exclusions)
#   2 = Affinity Live DBs             -> only 4-digit numeric filenames where number < 5000,
#                                       excluding LiveDbExclusions, and excluding global exclusions
#   3 = All of the above              -> runs modes 0, 1 and 2 and produces all three output files

$Shares = @(
    "\\PIDB06\DATABASES$",
    "\\PIDB07\DATABASES$",
    "\\PIDB08\DATABASES",
    "\\PIDB09\DATABASES$",
    "\\PIDB10\DATABASES$"
)

# Live DB exclusions (numeric). These are excluded ONLY in Mode 2 (Affinity Live DBs)
$LiveDbExclusions = @(1153, 2600, 2601, 2605, 2604, 2603, 2699, 2703, 2799, 4000, 4006, 4007, 4008, 4009)

# Databases excluded in ALL modes (numeric only)
$ExcludedDbNumbers = @(3056)

function Convert-UncToInterBaseConnString {
    param([Parameter(Mandatory=$true)][string]$UncFullPath)

    if ($UncFullPath -notmatch '^\\\\([^\\]+)\\([^\\]+)(\\.*)?$') { return $null }

    $server = $matches[1]
    $share  = $matches[2]
    $rest   = $matches[3]

    # Map DATABASES / DATABASES$ -> E:\DATABASES (per your convention)
    $localRoot = "E:\$($share.TrimEnd('$'))"

    $relative = ($rest -replace '^\\', '')
    $localPath = if ([string]::IsNullOrWhiteSpace($relative)) {
        $localRoot
    } else {
        Join-Path $localRoot $relative
    }

    return "$server`:$localPath"
}

function Matches-Mode {
    param(
        [Parameter(Mandatory=$true)][System.IO.FileInfo]$File,
        [int]$Mode,
        [int[]]$LiveExclusions,
        [int[]]$Excluded
    )

    $base = $File.BaseName

    # Global numeric exclusion (applies to ALL modes)
    if ($base -match '^\d+$') {
        $nAll = [int]$base
        if ($Excluded -contains $nAll) { return $false }
    }

    switch ($Mode) {
        0 {  # All DBs
            return $true
        }

        1 {  # Affinity DBs (4-digit numeric only)
            return ($base -match '^\d{4}$')
        }

        2 {  # Affinity Live DBs (4-digit numeric < 5000, excluding LiveExclusions)
            if ($base -notmatch '^\d{4}$') { return $false }

            $n = [int]$base
            if ($n -ge 5000) { return $false }
            if ($LiveExclusions -contains $n) { return $false }

            return $true
        }

        default { return $true }
    }
}

function Run-ScanMode {
    param([int]$ScanMode)

    $OutputFile = switch ($ScanMode) {
        0 { "All DBs.txt" }
        1 { "Affinity DBs.txt" }
        2 { "Affinity Live DBs.txt" }
    }

    $results = New-Object System.Collections.Generic.List[string]

    foreach ($shareRoot in $Shares) {

        if (-not (Test-Path -LiteralPath $shareRoot)) {
            Write-Warning "Cannot access: $shareRoot"
            continue
        }

        Get-ChildItem -LiteralPath $shareRoot -Recurse -File -Filter "*.IB" -ErrorAction SilentlyContinue |
            Where-Object {
                Matches-Mode `
                    -File $_ `
                    -Mode $ScanMode `
                    -LiveExclusions $LiveDbExclusions `
                    -Excluded $ExcludedDbNumbers
            } |
            ForEach-Object {
                $cs = Convert-UncToInterBaseConnString -UncFullPath $_.FullName
                if ($cs) { $results.Add($cs) }
            }
    }

    $sorted = $results | Sort-Object

    $sorted | Set-Content -Encoding ASCII -Path $OutputFile
    $sorted
    Write-Host "Wrote $($sorted.Count) entries to $OutputFile (Mode: $ScanMode)"
}

Write-Host "Select Mode:"
Write-Host "  0 = All DBs (default)"
Write-Host "  1 = Affinity DBs"
Write-Host "  2 = Affinity Live DBs"
Write-Host "  3 = All of the above"

$ModeInput = Read-Host "Enter mode number"
if ([string]::IsNullOrWhiteSpace($ModeInput)) {
    $Mode = 0
}
elseif ($ModeInput -match '^[0-3]$') {
    $Mode = [int]$ModeInput
}
else {
    Write-Warning "Invalid selection, using default: All DBs"
    $Mode = 0
}

if ($Mode -eq 3) {
    Write-Host ""
    Write-Host "Running all three scans..."
    Write-Host ""
    Run-ScanMode -ScanMode 0
    Write-Host ""
    Run-ScanMode -ScanMode 1
    Write-Host ""
    Run-ScanMode -ScanMode 2
}
else {
    Run-ScanMode -ScanMode $Mode
}
