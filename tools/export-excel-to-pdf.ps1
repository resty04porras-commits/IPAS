param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [string]$WorksheetName = '',

  [string]$PrintArea = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Release-ComObject {
  param([AllowNull()]$ComObject)

  if ($ComObject) {
    try {
      [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($ComObject)
    } catch {}
  }
}

function Close-Excel {
  param(
    [AllowNull()]$Workbook,
    [AllowNull()]$Excel
  )

  if ($Workbook) {
    try { $Workbook.Close($false) } catch {}
    Release-ComObject $Workbook
  }

  if ($Excel) {
    try { $Excel.Quit() } catch {}
    Release-ComObject $Excel
  }

  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  [GC]::Collect()
}

$resolvedInput = (Resolve-Path -LiteralPath $InputPath).Path
$outputDirectory = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($outputDirectory)) {
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

$excel = $null
$workbook = $null

try {
  try {
    $excel = New-Object -ComObject Excel.Application
  } catch {
    throw "PDF export requires Windows with Microsoft Excel installed."
  }

  if (-not $excel) {
    throw "PDF export requires Windows with Microsoft Excel installed."
  }

  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $excel.EnableEvents = $false
  $excel.Interactive = $false
  try { $excel.Application.AutomationSecurity = 1 } catch {}

  Start-Sleep -Milliseconds 800

  $workbook = $excel.Workbooks.Open(
    $resolvedInput,
    0,
    $false,
    5,
    '',
    '',
    $true,
    2,
    '',
    $false,
    $false,
    0,
    $false
  )

  if (-not $workbook) {
    throw "Microsoft Excel could not open the generated workbook."
  }

  $target = $workbook
  if (-not [string]::IsNullOrWhiteSpace($WorksheetName)) {
    try {
      $target = $workbook.Worksheets.Item($WorksheetName)
    } catch {
      $target = $workbook.ActiveSheet
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($PrintArea)) {
    try {
      $target.PageSetup.PrintArea = $PrintArea
    } catch {}
  }

  $target.ExportAsFixedFormat(0, $OutputPath)
} finally {
  Close-Excel -Workbook $workbook -Excel $excel
}

if (-not (Test-Path -LiteralPath $OutputPath -ErrorAction Ignore)) {
  throw "PDF conversion appeared to succeed but output file was not created."
}
