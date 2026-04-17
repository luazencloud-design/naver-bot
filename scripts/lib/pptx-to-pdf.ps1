#
# pptx-to-pdf.ps1
#
# Converts a PowerPoint .pptx file to .pdf using Microsoft
# PowerPoint via COM automation. Requires PowerPoint to be
# installed. Designed to be called from Node via child_process.
#
# Usage:
#   powershell.exe -ExecutionPolicy Bypass -NoProfile `
#     -File pptx-to-pdf.ps1 -InputPath "in.pptx" -OutputPath "out.pdf"
#
# Exit codes:
#   0  success
#   1  conversion error (e.g. corrupt file, password protected)
#   2  input file not found
#   3  PowerPoint COM not available (not installed)
#

param(
    [Parameter(Mandatory=$true)][string]$InputPath,
    [Parameter(Mandatory=$true)][string]$OutputPath
)

$ErrorActionPreference = "Stop"

# Resolve to absolute paths — PowerPoint COM requires them.
$InputPath  = [System.IO.Path]::GetFullPath($InputPath)
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)

if (-not (Test-Path -LiteralPath $InputPath)) {
    Write-Host "ERROR: Input file not found: $InputPath"
    exit 2
}

$app  = $null
$pres = $null

# Step 1: obtain PowerPoint Application COM object.
try {
    $app = New-Object -ComObject PowerPoint.Application -ErrorAction Stop
} catch {
    Write-Host "ERROR: PowerPoint COM is unavailable. Is Microsoft PowerPoint installed?"
    Write-Host "Details: $($_.Exception.Message)"
    exit 3
}

# Step 2: open + save-as-PDF + clean up.
try {
    # Presentations.Open(FileName, ReadOnly, Untitled, WithWindow)
    # MsoTriState: msoTrue = -1, msoFalse = 0
    # We want ReadOnly=-1, Untitled=-1 (so SaveAs doesn't prompt), WithWindow=0.
    $pres = $app.Presentations.Open($InputPath, -1, -1, 0)

    # PpSaveAsFileType.ppSaveAsPDF = 32
    $pres.SaveAs($OutputPath, 32)

    Write-Host "OK: $OutputPath"
    exit 0
} catch {
    Write-Host "ERROR: Conversion failed: $($_.Exception.Message)"
    exit 1
} finally {
    if ($pres) {
        try { $pres.Close() } catch {}
    }
    if ($app) {
        try { $app.Quit() } catch {}
    }
}
