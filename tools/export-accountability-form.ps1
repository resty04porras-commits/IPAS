param(
  [Parameter(Mandatory = $true)]
  [string]$TemplatePath,

  [Parameter(Mandatory = $true)]
  [string]$PayloadPath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [ValidateSet('xlsx', 'pdf')]
  [string]$Format = 'xlsx',

  [string]$SignatureImagePath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Format-DisplayDate {
  param([AllowNull()][string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ''
  }

  $parsedDate = [datetime]::MinValue
  if ([datetime]::TryParse($Value, [ref]$parsedDate)) {
    return $parsedDate.ToString('dd-MMM-yy')
  }

  return [string]$Value
}

function Get-ColumnIndex {
  param([string]$Column)

  $value = 0
  foreach ($char in $Column.ToCharArray()) {
    $value = ($value * 26) + ([int][char]::ToUpperInvariant($char) - [int][char]'A' + 1)
  }
  return $value
}

function Parse-CellReference {
  param([string]$Reference)

  if ($Reference -notmatch '^([A-Z]+)(\d+)$') {
    throw "Invalid cell reference: $Reference"
  }

  return @{
    Column = $Matches[1]
    Row = [int]$Matches[2]
    ColumnIndex = Get-ColumnIndex $Matches[1]
  }
}

function Get-OrCreate-Row {
  param(
    [xml]$Document,
    [System.Xml.XmlElement]$SheetData,
    [System.Xml.XmlNamespaceManager]$NamespaceManager,
    [string]$NamespaceUri,
    [int]$RowIndex
  )

  $existing = $SheetData.SelectSingleNode("x:row[@r='$RowIndex']", $NamespaceManager)
  if ($existing) {
    return [System.Xml.XmlElement]$existing
  }

  $row = $Document.CreateElement('row', $NamespaceUri)
  $row.SetAttribute('r', $RowIndex.ToString())

  $inserted = $false
  foreach ($candidate in $SheetData.SelectNodes('x:row', $NamespaceManager)) {
    if ([int]$candidate.GetAttribute('r') -gt $RowIndex) {
      [void]$SheetData.InsertBefore($row, $candidate)
      $inserted = $true
      break
    }
  }

  if (-not $inserted) {
    [void]$SheetData.AppendChild($row)
  }

  return $row
}

function Get-OrCreate-Cell {
  param(
    [xml]$Document,
    [System.Xml.XmlElement]$Row,
    [System.Xml.XmlNamespaceManager]$NamespaceManager,
    [string]$NamespaceUri,
    [string]$CellReference
  )

  $existing = $Row.SelectSingleNode("x:c[@r='$CellReference']", $NamespaceManager)
  if ($existing) {
    return [System.Xml.XmlElement]$existing
  }

  $parsed = Parse-CellReference $CellReference
  $cell = $Document.CreateElement('c', $NamespaceUri)
  $cell.SetAttribute('r', $CellReference)

  $inserted = $false
  foreach ($candidate in $Row.SelectNodes('x:c', $NamespaceManager)) {
    $candidateRef = $candidate.GetAttribute('r')
    $candidateParsed = Parse-CellReference $candidateRef
    if ($candidateParsed.ColumnIndex -gt $parsed.ColumnIndex) {
      [void]$Row.InsertBefore($cell, $candidate)
      $inserted = $true
      break
    }
  }

  if (-not $inserted) {
    [void]$Row.AppendChild($cell)
  }

  return $cell
}

function Set-InlineStringCell {
  param(
    [xml]$Document,
    [System.Xml.XmlElement]$SheetData,
    [System.Xml.XmlNamespaceManager]$NamespaceManager,
    [string]$NamespaceUri,
    [string]$CellReference,
    [AllowNull()][string]$Value
  )

  $parsed = Parse-CellReference $CellReference
  $row = Get-OrCreate-Row -Document $Document -SheetData $SheetData -NamespaceManager $NamespaceManager -NamespaceUri $NamespaceUri -RowIndex $parsed.Row
  $cell = Get-OrCreate-Cell -Document $Document -Row $row -NamespaceManager $NamespaceManager -NamespaceUri $NamespaceUri -CellReference $CellReference

  while ($cell.HasChildNodes) {
    [void]$cell.RemoveChild($cell.FirstChild)
  }

  $cell.SetAttribute('t', 'inlineStr')
  $inlineString = $Document.CreateElement('is', $NamespaceUri)
  $textNode = $Document.CreateElement('t', $NamespaceUri)

  $safeValue = if ($null -eq $Value) { '' } else { [string]$Value }
  if ($safeValue -match '^\s' -or $safeValue -match '\s$') {
    [void]$textNode.SetAttribute('space', 'http://www.w3.org/XML/1998/namespace', 'preserve')
  }
  $textNode.InnerText = $safeValue

  [void]$inlineString.AppendChild($textNode)
  [void]$cell.AppendChild($inlineString)
}

function Get-CellStyleIndex {
  param(
    [System.Xml.XmlElement]$SheetData,
    [System.Xml.XmlNamespaceManager]$NamespaceManager,
    [string]$CellReference
  )

  $parsed = Parse-CellReference $CellReference
  $row = $SheetData.SelectSingleNode("x:row[@r='$($parsed.Row)']", $NamespaceManager)
  if (-not $row) {
    return 0
  }

  $cell = $row.SelectSingleNode("x:c[@r='$CellReference']", $NamespaceManager)
  if ($cell -and $cell.HasAttribute('s')) {
    return [int]$cell.GetAttribute('s')
  }

  return 0
}

function Set-CellStyle {
  param(
    [xml]$Document,
    [System.Xml.XmlElement]$SheetData,
    [System.Xml.XmlNamespaceManager]$NamespaceManager,
    [string]$NamespaceUri,
    [string]$CellReference,
    [int]$StyleIndex
  )

  $parsed = Parse-CellReference $CellReference
  $row = Get-OrCreate-Row -Document $Document -SheetData $SheetData -NamespaceManager $NamespaceManager -NamespaceUri $NamespaceUri -RowIndex $parsed.Row
  $cell = Get-OrCreate-Cell -Document $Document -Row $row -NamespaceManager $NamespaceManager -NamespaceUri $NamespaceUri -CellReference $CellReference
  $cell.SetAttribute('s', $StyleIndex.ToString())
}

function Ensure-WrappedCellStyle {
  param(
    [xml]$StylesDocument,
    [System.Xml.XmlNamespaceManager]$NamespaceManager,
    [string]$NamespaceUri,
    [int]$BaseStyleIndex
  )

  $cellXfs = [System.Xml.XmlElement]$StylesDocument.SelectSingleNode('/x:styleSheet/x:cellXfs', $NamespaceManager)
  if (-not $cellXfs) {
    return $BaseStyleIndex
  }

  $baseStyle = $cellXfs.SelectSingleNode("x:xf[position()=$($BaseStyleIndex + 1)]", $NamespaceManager)
  if (-not $baseStyle) {
    $baseStyle = $cellXfs.SelectSingleNode('x:xf[1]', $NamespaceManager)
  }
  if (-not $baseStyle) {
    return $BaseStyleIndex
  }

  $wrappedStyle = [System.Xml.XmlElement]$baseStyle.CloneNode($true)
  $wrappedStyle.SetAttribute('applyAlignment', '1')
  $alignment = [System.Xml.XmlElement]$wrappedStyle.SelectSingleNode('x:alignment', $NamespaceManager)
  if (-not $alignment) {
    $alignment = $StylesDocument.CreateElement('alignment', $NamespaceUri)
    [void]$wrappedStyle.AppendChild($alignment)
  }
  $alignment.SetAttribute('wrapText', '1')

  $styleCountAttribute = $cellXfs.GetAttribute('count')
  $newStyleIndex = if ([string]::IsNullOrWhiteSpace($styleCountAttribute)) {
    $cellXfs.SelectNodes('x:xf', $NamespaceManager).Count
  } else {
    [int]$styleCountAttribute
  }
  [void]$cellXfs.AppendChild($wrappedStyle)
  $cellXfs.SetAttribute('count', ($newStyleIndex + 1).ToString())
  return $newStyleIndex
}

function Get-EstimatedWrappedLineCount {
  param(
    [AllowNull()][string]$Value,
    [int]$MaxCharactersPerLine = 31
  )

  $text = if ($null -eq $Value) { '' } else { ([string]$Value).Trim() }
  if ([string]::IsNullOrWhiteSpace($text)) {
    return 1
  }

  $lineCount = 1
  $currentLength = 0
  foreach ($word in ($text -split '\s+')) {
    $wordLength = $word.Length
    if ($currentLength -eq 0) {
      $currentLength = $wordLength
    } elseif (($currentLength + 1 + $wordLength) -le $MaxCharactersPerLine) {
      $currentLength += 1 + $wordLength
    } else {
      $lineCount += 1
      $currentLength = $wordLength
    }

    while ($currentLength -gt $MaxCharactersPerLine) {
      $lineCount += 1
      $currentLength -= $MaxCharactersPerLine
    }
  }

  return [Math]::Max(1, $lineCount)
}

function Set-WorksheetRowHeightForWrappedText {
  param(
    [xml]$Document,
    [System.Xml.XmlElement]$SheetData,
    [System.Xml.XmlNamespaceManager]$NamespaceManager,
    [string]$NamespaceUri,
    [int]$RowIndex,
    [int]$LineCount
  )

  if ($LineCount -le 1) {
    return
  }

  $row = Get-OrCreate-Row -Document $Document -SheetData $SheetData -NamespaceManager $NamespaceManager -NamespaceUri $NamespaceUri -RowIndex $RowIndex
  $baseHeight = 13.8
  if ($row.HasAttribute('ht')) {
    $parsedHeight = 0.0
    if ([double]::TryParse($row.GetAttribute('ht'), [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$parsedHeight) -and $parsedHeight -gt 0) {
      $baseHeight = $parsedHeight
    }
  }

  $row.SetAttribute('ht', ($baseHeight * $LineCount).ToString('0.##', [System.Globalization.CultureInfo]::InvariantCulture))
  $row.SetAttribute('customHeight', '1')
}

function Convert-SignatureImageToTransparentPng {
  param(
    [Parameter(Mandatory = $true)][string]$ImagePath
  )

  if ([string]::IsNullOrWhiteSpace($ImagePath) -or -not (Test-Path -LiteralPath $ImagePath)) {
    return $ImagePath
  }

  try {
    Add-Type -AssemblyName System.Drawing
  } catch {
    return $ImagePath
  }

  $bitmap = $null
  $outputBitmap = $null

  try {
    $bitmap = New-Object System.Drawing.Bitmap -ArgumentList $ImagePath
    $outputBitmap = New-Object System.Drawing.Bitmap -ArgumentList @(
      $bitmap.Width,
      $bitmap.Height,
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )

    $samplePoints = @(
      @{ X = 0; Y = 0 },
      @{ X = [Math]::Floor(($bitmap.Width - 1) / 2); Y = 0 },
      @{ X = $bitmap.Width - 1; Y = 0 },
      @{ X = 0; Y = [Math]::Floor(($bitmap.Height - 1) / 2) },
      @{ X = $bitmap.Width - 1; Y = [Math]::Floor(($bitmap.Height - 1) / 2) },
      @{ X = 0; Y = $bitmap.Height - 1 },
      @{ X = [Math]::Floor(($bitmap.Width - 1) / 2); Y = $bitmap.Height - 1 },
      @{ X = $bitmap.Width - 1; Y = $bitmap.Height - 1 }
    )

    $backgroundR = 255.0
    $backgroundG = 255.0
    $backgroundB = 255.0
    $sampleCount = 0.0

    foreach ($samplePoint in $samplePoints) {
      $color = $bitmap.GetPixel([int]$samplePoint.X, [int]$samplePoint.Y)
      if ($color.A -eq 0) {
        continue
      }

      $backgroundR += [double]$color.R
      $backgroundG += [double]$color.G
      $backgroundB += [double]$color.B
      $sampleCount += 1.0
    }

    if ($sampleCount -gt 0) {
      $backgroundR = $backgroundR / ($sampleCount + 1.0)
      $backgroundG = $backgroundG / ($sampleCount + 1.0)
      $backgroundB = $backgroundB / ($sampleCount + 1.0)
    }

    for ($y = 0; $y -lt $bitmap.Height; $y++) {
      for ($x = 0; $x -lt $bitmap.Width; $x++) {
        $pixel = $bitmap.GetPixel($x, $y)
        if ($pixel.A -eq 0) {
          $outputBitmap.SetPixel($x, $y, $pixel)
          continue
        }

        $brightness = ([double]$pixel.R + [double]$pixel.G + [double]$pixel.B) / 3.0
        $distance =
          [Math]::Abs([double]$pixel.R - $backgroundR) +
          [Math]::Abs([double]$pixel.G - $backgroundG) +
          [Math]::Abs([double]$pixel.B - $backgroundB)
        $channelSpread =
          [Math]::Max([double]$pixel.R, [Math]::Max([double]$pixel.G, [double]$pixel.B)) -
          [Math]::Min([double]$pixel.R, [Math]::Min([double]$pixel.G, [double]$pixel.B))

        $newAlpha = [int]$pixel.A
        if ($brightness -ge 248 -or (($brightness -ge 212) -and ($distance -le 95) -and ($channelSpread -le 48))) {
          $newAlpha = 0
        } elseif (($brightness -ge 178) -and ($distance -le 155) -and ($channelSpread -le 64)) {
          $fade = [Math]::Max(0.0, [Math]::Min(1.0, ($distance - 28.0) / 120.0))
          $newAlpha = [int][Math]::Round([double]$pixel.A * $fade)
        }

        $outputBitmap.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($newAlpha, $pixel.R, $pixel.G, $pixel.B))
      }
    }

    $outputPath = Join-Path ([System.IO.Path]::GetDirectoryName($ImagePath)) ("signature-clean-" + [System.Guid]::NewGuid().ToString('N') + ".png")
    $outputBitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    return $outputPath
  } catch {
    return $ImagePath
  } finally {
    if ($outputBitmap) {
      $outputBitmap.Dispose()
    }
    if ($bitmap) {
      $bitmap.Dispose()
    }
  }
}

function Add-WorksheetSignature {
  param(
    [Parameter(Mandatory = $true)]$Worksheet,
    [Parameter(Mandatory = $true)][string]$ImagePath
  )

  if ([string]::IsNullOrWhiteSpace($ImagePath) -or -not (Test-Path -LiteralPath $ImagePath)) {
    return
  }

  $anchorRange = $Worksheet.Range('B42:F46')
  $printedNameRange = $Worksheet.Range('C47:F47')
  $preparedImagePath = Convert-SignatureImageToTransparentPng -ImagePath $ImagePath
  $shape = $Worksheet.Shapes.AddPicture($preparedImagePath, $false, $true, 0, 0, -1, -1)
  $shape.LockAspectRatio = -1

  $maxWidth = [double]$anchorRange.Width * 0.78
  $maxHeight = [double]$anchorRange.Height * 0.72
  $widthRatio = $maxWidth / [double]$shape.Width
  $heightRatio = $maxHeight / [double]$shape.Height
  $scale = [Math]::Min($widthRatio, $heightRatio)

  if ($scale -gt 0) {
    $shape.Width = [double]$shape.Width * $scale
  }

  $left = [double]$anchorRange.Left + (([double]$anchorRange.Width - [double]$shape.Width) / 2)
  $targetBottom = [double]$printedNameRange.Top - 1.5
  $top = $targetBottom - [double]$shape.Height
  $topFloor = [double]$anchorRange.Top + ([double]$anchorRange.Height * 0.04)
  $topCeiling = ([double]$anchorRange.Top + [double]$anchorRange.Height) - [double]$shape.Height
  $shape.Left = $left
  $shape.Top = [Math]::Max($topFloor, [Math]::Min($topCeiling, $top))
  $shape.ZOrder(0) | Out-Null
}

function Set-CenteredCellAlignment {
  param(
    [Parameter(Mandatory = $true)]$Worksheet,
    [Parameter(Mandatory = $true)][string[]]$Addresses
  )

  foreach ($address in $Addresses) {
    $range = $Worksheet.Range($address)
    $range.HorizontalAlignment = -4108
    $range.VerticalAlignment = -4108
  }
}

function Set-WorksheetPrintLayout {
  param(
    [Parameter(Mandatory = $true)]$Worksheet,
    [ValidateSet('xlsx', 'pdf')]
    [string]$Format = 'xlsx'
  )

  $ps = $Worksheet.PageSetup

  if ($Format -eq 'pdf') {
    $ps.LeftMargin   = 0.65
    $ps.RightMargin  = 0.65
    $ps.TopMargin    = 0.15
    $ps.BottomMargin = 0.35
  } else {
    # Keep the workbook export's existing print setup unless the output is PDF.
    $ps.LeftMargin   = 0.5
    $ps.RightMargin  = 0.5
    $ps.TopMargin    = 0.6
    $ps.BottomMargin = 0.6
  }
  $ps.HeaderMargin = 0.3
  $ps.FooterMargin = 0.3

  # Orientation, centering, paper size — set before scaling so Excel doesn't
  # recalculate fit-to-page state after we configure it.
  $ps.Orientation        = 1     # xlPortrait
  $ps.CenterHorizontally = $true
  $ps.CenterVertically   = $false
  $ps.PaperSize          = 1     # xlPaperLetter

  # Fit to exactly ONE page (both wide and tall) so the entire form — header,
  # table, acknowledgement, and signature block — always prints on a single sheet.
  #
  # Excel COM requires Zoom to be cleared (set to $false) before FitToPagesWide/
  # FitToPagesTall are accepted.  The three-step sequence below is reliable across
  # all Excel versions:
  #   1. Reset Zoom to a concrete value so PageSetup is in a known numeric state.
  #   2. Disable Zoom to activate FitToPages mode.
  #   3. Set FitToPagesWide = 1; FitToPagesTall = 1 (one page tall).
  try { $ps.Zoom = 100 } catch { }   # clear any stale fit-to-page state
  $ps.Zoom = $false                  # activate FitToPages mode
  $ps.FitToPagesWide = 1
  $ps.FitToPagesTall = 1             # force everything onto a single page
}

$payload = Get-Content -LiteralPath $PayloadPath -Raw | ConvertFrom-Json

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-form-" + [System.Guid]::NewGuid().ToString('N'))
$zipPath = Join-Path $tempRoot 'template.zip'
$extractPath = Join-Path $tempRoot 'unzipped'

New-Item -ItemType Directory -Path $extractPath -Force | Out-Null
Copy-Item -LiteralPath $TemplatePath -Destination $zipPath -Force

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $extractPath)

$sheetPath = Join-Path $extractPath 'xl\worksheets\sheet1.xml'
[xml]$worksheet = Get-Content -LiteralPath $sheetPath
$namespaceUri = $worksheet.DocumentElement.NamespaceURI
$namespaceManager = New-Object System.Xml.XmlNamespaceManager($worksheet.NameTable)
$namespaceManager.AddNamespace('x', $namespaceUri)
$sheetData = [System.Xml.XmlElement]$worksheet.SelectSingleNode('/x:worksheet/x:sheetData', $namespaceManager)

$stylesPath = Join-Path $extractPath 'xl\styles.xml'
$styles = $null
$stylesNamespaceManager = $null
$stylesNamespaceUri = ''
if (Test-Path -LiteralPath $stylesPath) {
  [xml]$styles = Get-Content -LiteralPath $stylesPath
  $stylesNamespaceUri = $styles.DocumentElement.NamespaceURI
  $stylesNamespaceManager = New-Object System.Xml.XmlNamespaceManager($styles.NameTable)
  $stylesNamespaceManager.AddNamespace('x', $stylesNamespaceUri)
}

$tableStartRow = 11
$tableEndRow = 34
$tableColumns = @('A', 'D', 'G', 'K', 'O')
$remarksWrappedStyle = if ($styles -and $stylesNamespaceManager) {
  $baseRemarksStyle = Get-CellStyleIndex -SheetData $sheetData -NamespaceManager $namespaceManager -CellReference "O$tableStartRow"
  Ensure-WrappedCellStyle -StylesDocument $styles -NamespaceManager $stylesNamespaceManager -NamespaceUri $stylesNamespaceUri -BaseStyleIndex $baseRemarksStyle
} else {
  -1
}
$remarksLineCounts = @{}

$cellValues = @{
  'C6' = [string]$payload.employeeName
  'I6' = [string]$payload.employeeId
  'N6' = ''
  'C7' = [string]$payload.designation
  'I7' = [string]$payload.department
  'N7' = [string]$payload.effectiveDate
  # FE/SFE names belong on the upper signature line, above "Signature over Printed Name".
  'C47' = [string]$payload.processedBy
  'H47' = [string]$payload.checkedBy
  # The lower line is reserved for the actual processed/checked dates.
  'C50' = Format-DisplayDate ([string]$payload.processedDate)
  'H50' = Format-DisplayDate ([string]$payload.checkedDate)
  'O47' = [string]$payload.verifiedBy
  'O48' = [string]$payload.verifiedTitle
  # Verified/Noted dates belong on the upper line, with the "Date" label beneath them.
  'O50' = Format-DisplayDate ([string]$payload.verifiedDate)
  'O55' = [string]$payload.notedBy
  'O56' = [string]$payload.notedTitle
  'O58' = Format-DisplayDate ([string]$payload.notedDate)
}

for ($row = $tableStartRow; $row -le $tableEndRow; $row++) {
  foreach ($column in $tableColumns) {
    $cellValues["$column$row"] = ''
  }
}

$items = @($payload.items)
$maxItems = $tableEndRow - $tableStartRow + 1
for ($index = 0; $index -lt [Math]::Min($items.Count, $maxItems); $index++) {
  $row = $tableStartRow + $index
  $item = $items[$index]
  $cellValues["A$row"] = [string]$item.components
  $cellValues["D$row"] = [string]$item.description
  $cellValues["G$row"] = [string]$item.hardwareId
  $cellValues["K$row"] = [string]$item.serial
  $cellValues["O$row"] = [string]$item.remarks
  $remarksLineCounts[$row] = Get-EstimatedWrappedLineCount -Value ([string]$item.remarks)
}

foreach ($entry in $cellValues.GetEnumerator()) {
  Set-InlineStringCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference $entry.Key -Value $entry.Value
}

for ($row = $tableStartRow; $row -le $tableEndRow; $row++) {
  if ($remarksWrappedStyle -ge 0) {
    Set-CellStyle -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference "O$row" -StyleIndex $remarksWrappedStyle
  }

  if ($remarksLineCounts.ContainsKey($row)) {
    Set-WorksheetRowHeightForWrappedText -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -RowIndex $row -LineCount ([int]$remarksLineCounts[$row])
  }
}

$worksheet.Save($sheetPath)
if ($styles) {
  $styles.Save($stylesPath)
}

$generatedWorkbookPath = if ($Format -eq 'xlsx' -and [string]::IsNullOrWhiteSpace($SignatureImagePath)) {
  $OutputPath
} else {
  Join-Path $tempRoot 'accountability-form.generated.xlsx'
}

if (Test-Path -LiteralPath $generatedWorkbookPath) {
  Remove-Item -LiteralPath $generatedWorkbookPath -Force
}

if ($generatedWorkbookPath -eq $OutputPath -and (Test-Path -LiteralPath $OutputPath)) {
  Remove-Item -LiteralPath $OutputPath -Force
}

[System.IO.Compression.ZipFile]::CreateFromDirectory($extractPath, $generatedWorkbookPath)

if ($Format -eq 'xlsx' -and [string]::IsNullOrWhiteSpace($SignatureImagePath)) {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force
  return
}

$excel = $null
$workbook = $null
$worksheetCom = $null

try {
  try {
    $excel = New-Object -ComObject Excel.Application
  } catch {
    throw 'Microsoft Excel is required to embed a signature image or export PDF files.'
  }

  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $workbook = $excel.Workbooks.Open($generatedWorkbookPath)
  $worksheetCom = $workbook.Worksheets.Item(1)

  Set-WorksheetPrintLayout -Worksheet $worksheetCom -Format $Format
  Set-CenteredCellAlignment -Worksheet $worksheetCom -Addresses @(
    'C6', 'I6', 'N6',
    'C7', 'I7', 'N7',
    'C47', 'H47', 'O47', 'O48', 'O55', 'O56',
    'C50', 'H50', 'O50', 'O58'
  )
  if (-not [string]::IsNullOrWhiteSpace($SignatureImagePath)) {
    Add-WorksheetSignature -Worksheet $worksheetCom -ImagePath $SignatureImagePath
  }

  if ($Format -eq 'pdf') {
    if (Test-Path -LiteralPath $OutputPath) {
      Remove-Item -LiteralPath $OutputPath -Force
    }

    $xlTypePdf = 0
    $workbook.ExportAsFixedFormat($xlTypePdf, $OutputPath)
    $workbook.Close($false)
  } else {
    if (Test-Path -LiteralPath $OutputPath) {
      Remove-Item -LiteralPath $OutputPath -Force
    }

    $xlOpenXmlWorkbook = 51
    $workbook.SaveAs($OutputPath, $xlOpenXmlWorkbook)
    $workbook.Close($false)
  }
} finally {
  if ($worksheetCom) {
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($worksheetCom)
  }
  if ($workbook) {
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($workbook)
  }
  if ($excel) {
    $excel.Quit()
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
  }

  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()

  Remove-Item -LiteralPath $tempRoot -Recurse -Force
}
