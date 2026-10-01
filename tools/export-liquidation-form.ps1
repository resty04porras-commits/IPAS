param(
  [Parameter(Mandatory = $true)]
  [string]$TemplatePath,

  [Parameter(Mandatory = $true)]
  [string]$PayloadPath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [ValidateSet('xlsx', 'pdf')]
  [string]$Format = 'xlsx',

  [string]$SignaturePath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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
    $candidateParsed = Parse-CellReference $candidate.GetAttribute('r')
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

function Clear-CellValue {
  param(
    [xml]$Document,
    [System.Xml.XmlElement]$SheetData,
    [System.Xml.XmlNamespaceManager]$NamespaceManager,
    [string]$NamespaceUri,
    [string]$CellReference
  )

  $parsed = Parse-CellReference $CellReference
  $row = Get-OrCreate-Row -Document $Document -SheetData $SheetData -NamespaceManager $NamespaceManager -NamespaceUri $NamespaceUri -RowIndex $parsed.Row
  $cell = Get-OrCreate-Cell -Document $Document -Row $row -NamespaceManager $NamespaceManager -NamespaceUri $NamespaceUri -CellReference $CellReference

  while ($cell.HasChildNodes) {
    [void]$cell.RemoveChild($cell.FirstChild)
  }

  if ($cell.HasAttribute('t')) {
    [void]$cell.RemoveAttribute('t')
  }
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

  if ([string]::IsNullOrWhiteSpace($Value)) {
    Clear-CellValue -Document $Document -SheetData $SheetData -NamespaceManager $NamespaceManager -NamespaceUri $NamespaceUri -CellReference $CellReference
    return
  }

  $parsed = Parse-CellReference $CellReference
  $row = Get-OrCreate-Row -Document $Document -SheetData $SheetData -NamespaceManager $NamespaceManager -NamespaceUri $NamespaceUri -RowIndex $parsed.Row
  $cell = Get-OrCreate-Cell -Document $Document -Row $row -NamespaceManager $NamespaceManager -NamespaceUri $NamespaceUri -CellReference $CellReference

  while ($cell.HasChildNodes) {
    [void]$cell.RemoveChild($cell.FirstChild)
  }

  $cell.SetAttribute('t', 'inlineStr')
  $inlineString = $Document.CreateElement('is', $NamespaceUri)
  $textNode = $Document.CreateElement('t', $NamespaceUri)

  if ($Value -match '^\s' -or $Value -match '\s$') {
    [void]$textNode.SetAttribute('space', 'http://www.w3.org/XML/1998/namespace', 'preserve')
  }
  $textNode.InnerText = [string]$Value

  [void]$inlineString.AppendChild($textNode)
  [void]$cell.AppendChild($inlineString)
}

function Set-RichHeaderCell {
  param(
    [xml]$Document,
    [System.Xml.XmlElement]$SheetData,
    [System.Xml.XmlNamespaceManager]$NamespaceManager,
    [string]$NamespaceUri,
    [string]$CellReference,
    [string]$Label,
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

  $labelRun = $Document.CreateElement('r', $NamespaceUri)
  $labelText = $Document.CreateElement('t', $NamespaceUri)
  $labelText.SetAttribute('space', 'http://www.w3.org/XML/1998/namespace', 'preserve')
  $labelText.InnerText = ('{0}: ' -f $Label)
  [void]$labelRun.AppendChild($labelText)
  [void]$inlineString.AppendChild($labelRun)

  if (-not [string]::IsNullOrWhiteSpace($Value)) {
    $valueRun = $Document.CreateElement('r', $NamespaceUri)
    $valueText = $Document.CreateElement('t', $NamespaceUri)
    if ($Value -match '^\s' -or $Value -match '\s$') {
      $valueText.SetAttribute('space', 'http://www.w3.org/XML/1998/namespace', 'preserve')
    }
    $valueText.InnerText = [string]$Value
    [void]$valueRun.AppendChild($valueText)
    [void]$inlineString.AppendChild($valueRun)
  }

  [void]$cell.AppendChild($inlineString)
}

function Set-NumberCell {
  param(
    [xml]$Document,
    [System.Xml.XmlElement]$SheetData,
    [System.Xml.XmlNamespaceManager]$NamespaceManager,
    [string]$NamespaceUri,
    [string]$CellReference,
    [AllowNull()]$Value
  )

  if ($null -eq $Value -or ([string]$Value).Trim().Length -eq 0) {
    Clear-CellValue -Document $Document -SheetData $SheetData -NamespaceManager $NamespaceManager -NamespaceUri $NamespaceUri -CellReference $CellReference
    return
  }

  $parsed = Parse-CellReference $CellReference
  $row = Get-OrCreate-Row -Document $Document -SheetData $SheetData -NamespaceManager $NamespaceManager -NamespaceUri $NamespaceUri -RowIndex $parsed.Row
  $cell = Get-OrCreate-Cell -Document $Document -Row $row -NamespaceManager $NamespaceManager -NamespaceUri $NamespaceUri -CellReference $CellReference

  while ($cell.HasChildNodes) {
    [void]$cell.RemoveChild($cell.FirstChild)
  }

  if ($cell.HasAttribute('t')) {
    [void]$cell.RemoveAttribute('t')
  }

  $valueNode = $Document.CreateElement('v', $NamespaceUri)
  $valueNode.InnerText = [string]$Value
  [void]$cell.AppendChild($valueNode)
}

function Set-CachedFormulaValue {
  param(
    [xml]$Document,
    [System.Xml.XmlElement]$SheetData,
    [System.Xml.XmlNamespaceManager]$NamespaceManager,
    [string]$NamespaceUri,
    [string]$CellReference,
    [AllowNull()]$Value,
    [switch]$StringValue
  )

  $parsed = Parse-CellReference $CellReference
  $row = Get-OrCreate-Row -Document $Document -SheetData $SheetData -NamespaceManager $NamespaceManager -NamespaceUri $NamespaceUri -RowIndex $parsed.Row
  $cell = Get-OrCreate-Cell -Document $Document -Row $row -NamespaceManager $NamespaceManager -NamespaceUri $NamespaceUri -CellReference $CellReference
  $formula = $cell.SelectSingleNode('x:f', $NamespaceManager)

  while ($cell.HasChildNodes) {
    [void]$cell.RemoveChild($cell.FirstChild)
  }

  if ($StringValue) {
    $cell.SetAttribute('t', 'str')
  } elseif ($cell.HasAttribute('t')) {
    [void]$cell.RemoveAttribute('t')
  }

  if ($formula) {
    [void]$cell.AppendChild($formula)
  }

  $valueNode = $Document.CreateElement('v', $NamespaceUri)
  $valueNode.InnerText = [string]$Value
  [void]$cell.AppendChild($valueNode)
}

function New-DrawingParagraph {
  param(
    [xml]$Document,
    [string]$DrawingNamespace,
    [string]$TextNamespace,
    [AllowNull()][string]$Text,
    [bool]$Bold = $false,
    [bool]$Underline = $false
  )

  $paragraph = $Document.CreateElement('a', 'p', $TextNamespace)
  $paragraphProperties = $Document.CreateElement('a', 'pPr', $TextNamespace)
  $defaultProperties = $Document.CreateElement('a', 'defRPr', $TextNamespace)
  [void]$paragraphProperties.AppendChild($defaultProperties)
  [void]$paragraph.AppendChild($paragraphProperties)

  $run = $Document.CreateElement('a', 'r', $TextNamespace)
  $runProperties = $Document.CreateElement('a', 'rPr', $TextNamespace)
  $runProperties.SetAttribute('lang', 'en-US')
  $runProperties.SetAttribute('sz', '1100')
  if ($Bold) { $runProperties.SetAttribute('b', '1') }
  if ($Underline) { $runProperties.SetAttribute('u', 'sng') }
  [void]$run.AppendChild($runProperties)

  $textNode = $Document.CreateElement('a', 't', $TextNamespace)
  $textNode.InnerText = if ([string]::IsNullOrWhiteSpace($Text)) { ' ' } else { [string]$Text }
  [void]$run.AppendChild($textNode)
  [void]$paragraph.AppendChild($run)

  $endProperties = $Document.CreateElement('a', 'endParaRPr', $TextNamespace)
  $endProperties.SetAttribute('lang', 'en-US')
  $endProperties.SetAttribute('sz', '1100')
  if ($Bold) { $endProperties.SetAttribute('b', '1') }
  [void]$paragraph.AppendChild($endProperties)

  return $paragraph
}

function Set-DrawingTextBox {
  param(
    [xml]$Drawing,
    [string]$ShapeName,
    [object[]]$Paragraphs
  )

  $xdrNs = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
  $textNs = 'http://schemas.openxmlformats.org/drawingml/2006/main'
  $nm = New-Object System.Xml.XmlNamespaceManager($Drawing.NameTable)
  $nm.AddNamespace('xdr', $xdrNs)
  $nm.AddNamespace('a', $textNs)

  $shape = $Drawing.SelectSingleNode("//xdr:cNvPr[@name='$ShapeName']/ancestor::xdr:sp", $nm)
  if (-not $shape) { return }

  $body = [System.Xml.XmlElement]$shape.SelectSingleNode('xdr:txBody', $nm)
  if (-not $body) { return }

  foreach ($node in @($body.SelectNodes('a:p', $nm))) {
    [void]$body.RemoveChild($node)
  }

  foreach ($paragraph in $Paragraphs) {
    $text = if ($paragraph.ContainsKey('Text')) { [string]$paragraph.Text } else { '' }
    $bold = if ($paragraph.ContainsKey('Bold')) { [bool]$paragraph.Bold } else { $false }
    $underline = if ($paragraph.ContainsKey('Underline')) { [bool]$paragraph.Underline } else { $false }
    $newParagraph = New-DrawingParagraph -Document $Drawing -DrawingNamespace $xdrNs -TextNamespace $textNs -Text $text -Bold $bold -Underline $underline
    [void]$body.AppendChild($newParagraph)
  }
}

function Ensure-MergeRange {
  param(
    [xml]$Document,
    [System.Xml.XmlNamespaceManager]$NamespaceManager,
    [string]$NamespaceUri,
    [string]$Range
  )

  $mergeCells = [System.Xml.XmlElement]$Document.SelectSingleNode('/x:worksheet/x:mergeCells', $NamespaceManager)
  if (-not $mergeCells) {
    $mergeCells = $Document.CreateElement('mergeCells', $NamespaceUri)
    $sheetData = $Document.SelectSingleNode('/x:worksheet/x:sheetData', $NamespaceManager)
    [void]$sheetData.ParentNode.InsertAfter($mergeCells, $sheetData)
    $mergeCells.SetAttribute('count', '0')
  }

  $existing = $mergeCells.SelectSingleNode("x:mergeCell[@ref='$Range']", $NamespaceManager)
  if ($existing) {
    return
  }

  $mergeCell = $Document.CreateElement('mergeCell', $NamespaceUri)
  $mergeCell.SetAttribute('ref', $Range)
  [void]$mergeCells.AppendChild($mergeCell)
  $mergeCells.SetAttribute('count', ([int]$mergeCells.GetAttribute('count') + 1).ToString())
}

function Remove-MergeRange {
  param(
    [xml]$Document,
    [System.Xml.XmlNamespaceManager]$NamespaceManager,
    [string]$Range
  )

  $mergeCells = [System.Xml.XmlElement]$Document.SelectSingleNode('/x:worksheet/x:mergeCells', $NamespaceManager)
  if (-not $mergeCells) { return }

  $node = $mergeCells.SelectSingleNode("x:mergeCell[@ref='$Range']", $NamespaceManager)
  if ($node) {
    [void]$mergeCells.RemoveChild($node)
    $current = [int]$mergeCells.GetAttribute('count')
    if ($current -gt 0) {
      $mergeCells.SetAttribute('count', ($current - 1).ToString())
    }
  }
}

function Set-RowHeight {
  param(
    [xml]$Document,
    [System.Xml.XmlElement]$SheetData,
    [System.Xml.XmlNamespaceManager]$NamespaceManager,
    [string]$NamespaceUri,
    [int]$RowIndex,
    [double]$Height
  )

  $row = Get-OrCreate-Row -Document $Document -SheetData $SheetData -NamespaceManager $NamespaceManager -NamespaceUri $NamespaceUri -RowIndex $RowIndex
  $row.SetAttribute('ht', $Height.ToString([System.Globalization.CultureInfo]::InvariantCulture))
  $row.SetAttribute('customHeight', '1')
}

function Set-ColumnWidth {
  param(
    [xml]$Document,
    [System.Xml.XmlNamespaceManager]$NamespaceManager,
    [string]$NamespaceUri,
    [int]$ColIndex,
    [double]$Width
  )

  $cols = $Document.SelectSingleNode('/x:worksheet/x:cols', $NamespaceManager)
  if (-not $cols) {
    $cols = $Document.CreateElement('cols', $NamespaceUri)
    $sheetDataNode = $Document.SelectSingleNode('/x:worksheet/x:sheetData', $NamespaceManager)
    [void]$Document.DocumentElement.InsertBefore($cols, $sheetDataNode)
  }

  # Collect and remove any existing col entries that cover this column index,
  # re-inserting the surrounding ranges with their original attributes.
  $existing = @($cols.SelectNodes('x:col', $NamespaceManager) | Where-Object {
    [int]$_.GetAttribute('min') -le $ColIndex -and [int]$_.GetAttribute('max') -ge $ColIndex
  })
  $sourceCol = if ($existing.Count -gt 0) { $existing[0] } else { $null }

  foreach ($oldCol in $existing) {
    $oldMin = [int]$oldCol.GetAttribute('min')
    $oldMax = [int]$oldCol.GetAttribute('max')
    [void]$cols.RemoveChild($oldCol)

    if ($oldMin -lt $ColIndex) {
      $before = $Document.CreateElement('col', $NamespaceUri)
      foreach ($attr in $oldCol.Attributes) { $before.SetAttribute($attr.Name, $attr.Value) }
      $before.SetAttribute('min', $oldMin.ToString())
      $before.SetAttribute('max', ($ColIndex - 1).ToString())
      [void]$cols.AppendChild($before)
    }
    if ($oldMax -gt $ColIndex) {
      $after = $Document.CreateElement('col', $NamespaceUri)
      foreach ($attr in $oldCol.Attributes) { $after.SetAttribute($attr.Name, $attr.Value) }
      $after.SetAttribute('min', ($ColIndex + 1).ToString())
      $after.SetAttribute('max', $oldMax.ToString())
      [void]$cols.AppendChild($after)
    }
  }

  $newCol = $Document.CreateElement('col', $NamespaceUri)
  if ($sourceCol) {
    foreach ($attr in $sourceCol.Attributes) {
      $newCol.SetAttribute($attr.Name, $attr.Value)
    }
  }
  $newCol.SetAttribute('min', $ColIndex.ToString())
  $newCol.SetAttribute('max', $ColIndex.ToString())
  $newCol.SetAttribute('width', $Width.ToString('F2', [System.Globalization.CultureInfo]::InvariantCulture))
  $newCol.SetAttribute('customWidth', '1')
  [void]$cols.AppendChild($newCol)
}

function Get-WrappedLineCount {
  param(
    [AllowNull()][string]$Value,
    [double]$ColumnWidth
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return 1
  }

  $capacity = [Math]::Max(4, [int][Math]::Floor($ColumnWidth * 1.12))
  $paragraphs = ([string]$Value).Replace("`r", '').Split("`n")
  $lineCount = 0

  foreach ($paragraph in $paragraphs) {
    $words = @([System.Text.RegularExpressions.Regex]::Split($paragraph.Trim(), '\s+') | Where-Object { $_.Length -gt 0 })
    if ($words.Count -eq 0) {
      $lineCount += 1
      continue
    }

    $currentLength = 0
    foreach ($word in $words) {
      if ($word.Length -gt $capacity) {
        if ($currentLength -gt 0) {
          $lineCount += 1
          $currentLength = 0
        }
        $lineCount += [Math]::Ceiling($word.Length / $capacity)
        continue
      }

      $nextLength = if ($currentLength -eq 0) { $word.Length } else { $currentLength + 1 + $word.Length }
      if ($nextLength -gt $capacity) {
        $lineCount += 1
        $currentLength = $word.Length
      } else {
        $currentLength = $nextLength
      }
    }

    if ($currentLength -gt 0) {
      $lineCount += 1
    }
  }

  return [Math]::Max(1, $lineCount)
}

function Get-LiquidationDataRowHeight {
  param([AllowNull()]$Item)

  if ($null -eq $Item) {
    return 13.0
  }

  $lineCount = 1
  $lineCount = [Math]::Max($lineCount, (Get-WrappedLineCount (Normalize-LiquidationTimeText ([string]$Item.time)) 17.81640625))
  $lineCount = [Math]::Max($lineCount, (Get-WrappedLineCount ([string]$Item.from) 15.453125))
  $lineCount = [Math]::Max($lineCount, (Get-WrappedLineCount ([string]$Item.to) 16.0))
  $lineCount = [Math]::Max($lineCount, (Get-WrappedLineCount ([string]$Item.modeOfTransportation) 11.0))
  $lineCount = [Math]::Max($lineCount, (Get-WrappedLineCount ([string]$Item.remarks) 22.54296875))

  $height = 13.0 + (($lineCount - 1) * 7.2)
  return [Math]::Min(34.0, [Math]::Max(13.0, $height))
}

function Get-TotalPrintHeight {
  param(
    [xml]$Document,
    [System.Xml.XmlNamespaceManager]$NamespaceManager,
    [int]$StartRow,
    [int]$EndRow
  )

  $sheetFormat = $Document.SelectSingleNode('/x:worksheet/x:sheetFormatPr', $NamespaceManager)
  $defaultHeight = 12.5
  if ($sheetFormat -and $sheetFormat.HasAttribute('defaultRowHeight')) {
    $defaultHeight = [double]::Parse($sheetFormat.GetAttribute('defaultRowHeight'), [System.Globalization.CultureInfo]::InvariantCulture)
  }

  $total = 0.0
  for ($rowIndex = $StartRow; $rowIndex -le $EndRow; $rowIndex++) {
    $row = $Document.SelectSingleNode("/x:worksheet/x:sheetData/x:row[@r='$rowIndex']", $NamespaceManager)
    if ($row -and $row.HasAttribute('ht')) {
      $total += [double]::Parse($row.GetAttribute('ht'), [System.Globalization.CultureInfo]::InvariantCulture)
    } else {
      $total += $defaultHeight
    }
  }

  return $total
}

function Convert-ToExcelSerialDate {
  param([AllowNull()][string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  $parsed = [datetime]::MinValue
  if ([datetime]::TryParse($Value, [ref]$parsed)) {
    return $parsed.ToOADate().ToString([System.Globalization.CultureInfo]::InvariantCulture)
  }

  return $null
}

function Format-LiquidationDateText {
  param([AllowNull()][string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }

  $parsed = [datetime]::MinValue
  if ([datetime]::TryParse($Value, [ref]$parsed)) {
    return $parsed.ToString('dd-MMM-yy', [System.Globalization.CultureInfo]::InvariantCulture)
  }

  return [string]$Value
}

function Normalize-LiquidationTimeText {
  param([AllowNull()][string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  $text = [string]$Value
  $text = [System.Text.RegularExpressions.Regex]::Replace($text, '\s+to\s+', ' - ', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  $text = [System.Text.RegularExpressions.Regex]::Replace($text, '\s*-\s*', ' - ')
  $text = [System.Text.RegularExpressions.Regex]::Replace($text, '\s+', ' ')
  return $text.Trim()
}

function Convert-ToExcelNumber {
  param([AllowNull()][string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  $cleaned = [string]$Value
  $cleaned = $cleaned.Replace('PHP', '')
  $cleaned = $cleaned.Replace('php', '')
  $cleaned = $cleaned.Replace('P', '')
  $cleaned = $cleaned.Replace(',', '')
  $cleaned = [System.Text.RegularExpressions.Regex]::Replace($cleaned, '[^0-9.\-]', '')
  $cleaned = $cleaned.Trim()

  $parsed = 0.0
  if ([double]::TryParse($cleaned, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
    return $parsed.ToString([System.Globalization.CultureInfo]::InvariantCulture)
  }

  return $null
}

$payload = Get-Content -LiteralPath $PayloadPath -Raw | ConvertFrom-Json

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("liq-form-" + [System.Guid]::NewGuid().ToString('N'))
$zipPath = Join-Path $tempRoot 'template.zip'
$extractPath = Join-Path $tempRoot 'unzipped'

New-Item -ItemType Directory -Path $extractPath -Force | Out-Null
Copy-Item -LiteralPath $TemplatePath -Destination $zipPath -Force

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $extractPath)

# Remove the cached calculation chain.  Excel validates this cache against the
# actual cell graph on Open().  Writing new values directly into the XML makes
# the cache stale; with DisplayAlerts=false Excel silently fails the COM Open()
# call instead of prompting to repair.  Deleting it forces a safe recalculation.
$calcChainPath = Join-Path $extractPath 'xl\calcChain.xml'
if (Test-Path -LiteralPath $calcChainPath -ErrorAction Ignore) {
  Remove-Item -LiteralPath $calcChainPath -Force -ErrorAction Ignore
}

# Keep the reference template's print area explicit.  Leaving this undefined lets
# renderers infer the used range from drawing anchors and edited cells, which can
# pull the footer anchor into the height calculation or send Remarks to a
# separate horizontal page.  The attached master uses A1:L74 on sheet 4.
$wbXmlPath = Join-Path $extractPath 'xl\workbook.xml'
if (Test-Path -LiteralPath $wbXmlPath -ErrorAction Ignore) {
  try {
    [xml]$wbXml  = Get-Content -LiteralPath $wbXmlPath -Encoding UTF8
    $wbNsUri     = $wbXml.DocumentElement.NamespaceURI
    $wbNm        = New-Object System.Xml.XmlNamespaceManager($wbXml.NameTable)
    $wbNm.AddNamespace('w', $wbNsUri)
    $dnContainer = [System.Xml.XmlElement]$wbXml.SelectSingleNode('/w:workbook/w:definedNames', $wbNm)
    if (-not $dnContainer) {
      $dnContainer = $wbXml.CreateElement('definedNames', $wbNsUri)
      [void]$wbXml.DocumentElement.AppendChild($dnContainer)
    }

    foreach ($pn in @($dnContainer.SelectNodes('w:definedName[@name="_xlnm.Print_Area"]', $wbNm))) {
      [void]$dnContainer.RemoveChild($pn)
    }

    $printArea = $wbXml.CreateElement('definedName', $wbNsUri)
    $printArea.SetAttribute('name', '_xlnm.Print_Area')
    $printArea.SetAttribute('localSheetId', '3')
    $printArea.InnerText = "'Liquidation TAR '!`$A`$1:`$L`$74"
    [void]$dnContainer.AppendChild($printArea)
    $wbXml.Save($wbXmlPath)
  } catch {
    # Non-fatal: template print area may remain, but scale fix still applies.
  }
}

# Strip hardcoded signatory text boxes from drawing4.xml.
#
# The template was originally built from a filled-in form and contains floating
# text boxes anchored over the signatory rows (drawing rows 58-72 ≈ sheet rows
# 59-73) that hard-code old names/titles (e.g. "FE Name", "Jolly S. Meres",
# "Maricon B. Jaropillo", etc.) and labels.  These overlap the cell data the
# script writes dynamically, causing both to appear in the PDF simultaneously.
#
# Fix: remove every text-box anchor in that band; keep image anchors (logos)
# so the form header and footer remain intact.
$drawingPath = Join-Path $extractPath 'xl\drawings\drawing4.xml'
if ($false -and (Test-Path -LiteralPath $drawingPath -ErrorAction Ignore)) {
  try {
    [xml]$drawing = Get-Content -LiteralPath $drawingPath
    $xdrNs = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
    $xdrNm = New-Object System.Xml.XmlNamespaceManager($drawing.NameTable)
    $xdrNm.AddNamespace('xdr', $xdrNs)

    $toRemove = [System.Collections.Generic.List[System.Xml.XmlNode]]::new()
    foreach ($anchor in $drawing.DocumentElement.SelectNodes(
        'xdr:oneCellAnchor|xdr:twoCellAnchor', $xdrNm)) {
      # Only target text boxes (txBox="1"), never images (<xdr:pic>)
      $txBox = $anchor.SelectSingleNode('.//xdr:cNvSpPr[@txBox="1"]', $xdrNm)
      if (-not $txBox) { continue }
      $fromRow = $anchor.SelectSingleNode('xdr:from/xdr:row', $xdrNm)
      if ($fromRow -and [int]$fromRow.InnerText -ge 55 -and [int]$fromRow.InnerText -le 75) {
        $toRemove.Add($anchor)
      }
    }
    foreach ($node in $toRemove) {
      [void]$drawing.DocumentElement.RemoveChild($node)
    }
    $drawing.Save($drawingPath)
  } catch {
    # Non-fatal: worst case the old text boxes remain; cell data still populates.
  }
}

# ── E-signature: embed Prepared By signature image in drawing ─────────────────
# Placed in row 64 (0-indexed = 63) which is the physical signature space for
# the Prepared By signatory (between the label row 63 and the name row 65).
# The image spans columns A:B (the Prepared By merged cell range).
if ($SignaturePath -and (Test-Path -LiteralPath $SignaturePath -ErrorAction Ignore)) {
  try {
    $__sigExt = [System.IO.Path]::GetExtension($SignaturePath).TrimStart('.').ToLower()
    if ($__sigExt -eq 'jpeg') { $__sigExt = 'jpg' }
    $__sigMediaName = "esignature.$__sigExt"

    # 1. Copy image file into xl/media/
    $__mediaDir = Join-Path $extractPath 'xl\media'
    if (-not (Test-Path -LiteralPath $__mediaDir -ErrorAction Ignore)) {
      New-Item -ItemType Directory -Path $__mediaDir -Force | Out-Null
    }
    Copy-Item -LiteralPath $SignaturePath -Destination (Join-Path $__mediaDir $__sigMediaName) -Force

    # 2. Add image relationship to drawing4.xml.rels
    $__relsFile = Join-Path $extractPath 'xl\drawings\_rels\drawing4.xml.rels'
    [xml]$__rels = Get-Content -LiteralPath $__relsFile -Encoding UTF8
    $__pkgNs = 'http://schemas.openxmlformats.org/package/2006/relationships'
    $__relsNm = New-Object System.Xml.XmlNamespaceManager($__rels.NameTable)
    $__relsNm.AddNamespace('r', $__pkgNs)

    # Remove any previous esignature relationship so re-exports stay clean
    foreach ($__old in @($__rels.DocumentElement.SelectNodes(
        "r:Relationship[contains(@Target,'esignature')]", $__relsNm))) {
      [void]$__rels.DocumentElement.RemoveChild($__old)
    }

    # Pick a relationship ID that doesn't collide with existing ones
    $__usedIds = @($__rels.DocumentElement.SelectNodes('r:Relationship', $__relsNm) |
      ForEach-Object { $_.GetAttribute('Id') })
    $__sigRid = 'rId99'
    $__ridN   = 99
    while ($__usedIds -contains $__sigRid) { $__ridN++; $__sigRid = "rId$__ridN" }

    $__relEl = $__rels.CreateElement('Relationship', $__pkgNs)
    $__relEl.SetAttribute('Id',     $__sigRid)
    $__relEl.SetAttribute('Type',   'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image')
    $__relEl.SetAttribute('Target', "../media/$__sigMediaName")
    [void]$__rels.DocumentElement.AppendChild($__relEl)
    $__rels.Save($__relsFile)

    # 3. Add oneCellAnchor picture element to drawing4.xml
    #    Build as a separate XML doc so namespaces (xdr:, a:, r:) are declared
    #    correctly; ImportNode brings it into the drawing document intact.
    [xml]$__drawing2 = Get-Content -LiteralPath $drawingPath -Encoding UTF8
    $__nsXdr = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
    $__nsA   = 'http://schemas.openxmlformats.org/drawingml/2006/main'
    $__nsR   = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

    # twoCellAnchor: top-left = start of row 64 (signature space, 0-indexed row 63);
    # bottom-right = 6 pt into row 65 (name row, 0-indexed row 64).
    # This makes the image span the full 50 pt signature row plus 6 pt into the
    # name row — matching the natural overlap seen in Image 2 where the bottom of
    # the handwritten signature crosses the printed name line.
    # Total image height ≈ 56 pt = 711200 EMU.
    # Width covers columns A+B (Prepared By merged range) ≈ 1,695,450 EMU.
    $__anchorXml  = "<?xml version='1.0' encoding='UTF-8'?>"
    $__anchorXml += "<xdr:twoCellAnchor editAs='oneCell'"
    $__anchorXml +=   " xmlns:xdr='$__nsXdr'"
    $__anchorXml +=   " xmlns:a='$__nsA'"
    $__anchorXml +=   " xmlns:r='$__nsR'>"
    $__anchorXml +=   "<xdr:from>"
    $__anchorXml +=     "<xdr:col>0</xdr:col><xdr:colOff>57150</xdr:colOff>"
    $__anchorXml +=     "<xdr:row>63</xdr:row><xdr:rowOff>0</xdr:rowOff>"
    $__anchorXml +=   "</xdr:from>"
    $__anchorXml +=   "<xdr:to>"
    $__anchorXml +=     "<xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff>"
    $__anchorXml +=     "<xdr:row>64</xdr:row><xdr:rowOff>76200</xdr:rowOff>"
    $__anchorXml +=   "</xdr:to>"
    $__anchorXml +=   "<xdr:pic>"
    $__anchorXml +=     "<xdr:nvPicPr>"
    $__anchorXml +=       "<xdr:cNvPr id='200' name='PreparedBySignature'/>"
    $__anchorXml +=       "<xdr:cNvPicPr><a:picLocks noChangeAspect='1'/></xdr:cNvPicPr>"
    $__anchorXml +=     "</xdr:nvPicPr>"
    $__anchorXml +=     "<xdr:blipFill>"
    $__anchorXml +=       "<a:blip r:embed='$__sigRid'/>"
    $__anchorXml +=       "<a:stretch><a:fillRect/></a:stretch>"
    $__anchorXml +=     "</xdr:blipFill>"
    $__anchorXml +=     "<xdr:spPr>"
    $__anchorXml +=       "<a:xfrm><a:off x='57150' y='0'/><a:ext cx='1695450' cy='711200'/></a:xfrm>"
    $__anchorXml +=       "<a:prstGeom prst='rect'><a:avLst/></a:prstGeom>"
    $__anchorXml +=     "</xdr:spPr>"
    $__anchorXml +=   "</xdr:pic>"
    $__anchorXml +=   "<xdr:clientData/>"
    $__anchorXml += "</xdr:twoCellAnchor>"

    $__anchorDoc = New-Object System.Xml.XmlDocument
    $__anchorDoc.LoadXml($__anchorXml)
    $__imported = $__drawing2.ImportNode($__anchorDoc.DocumentElement, $true)
    [void]$__drawing2.DocumentElement.AppendChild($__imported)
    $__drawing2.Save($drawingPath)

  } catch {
    Write-Warning "[e-signature] Could not embed signature image: $_"
    # Non-fatal — export continues and generates PDF without the signature
  }
}

$sheetPath = Join-Path $extractPath 'xl\worksheets\sheet4.xml'
[xml]$worksheet = Get-Content -LiteralPath $sheetPath
$namespaceUri = $worksheet.DocumentElement.NamespaceURI
$namespaceManager = New-Object System.Xml.XmlNamespaceManager($worksheet.NameTable)
$namespaceManager.AddNamespace('x', $namespaceUri)
$sheetData = [System.Xml.XmlElement]$worksheet.SelectSingleNode('/x:worksheet/x:sheetData', $namespaceManager)

# ── Remove manual page breaks ─────────────────────────────────────────────────
# The original template was saved with <colBreaks> and/or <rowBreaks> elements
# that hard-wire page breaks between specific columns/rows.  These XML elements
# take priority over scale and fitToWidth/fitToHeight settings, so the PDF
# renderer always produces multiple pages even when scale is set correctly.
# Specifically: a column break between column J and L forces "Remarks" onto a
# separate horizontal page (page 3 in the broken export), and a row break in the
# data area forces the signatory/totals section onto page 2.
# Removing both elements lets scale and fit-to-page control page layout instead.
foreach ($__brk in @('colBreaks', 'rowBreaks')) {
  $__bn = $worksheet.SelectSingleNode("/x:worksheet/x:$__brk", $namespaceManager)
  if ($__bn) { [void]$worksheet.DocumentElement.RemoveChild($__bn) }
}

# ── Enable fit-to-one-page mode in sheetPr ───────────────────────────────────
# The print area is locked to A1:L74 above, so fit-to-page now uses the intended
# form bounds instead of inferring a larger used range from drawing anchors.
if ($false) { try {
  $__sheetPr = $worksheet.SelectSingleNode('/x:worksheet/x:sheetPr', $namespaceManager)
  if (-not $__sheetPr) {
    $__sheetPr = $worksheet.CreateElement('sheetPr', $namespaceUri)
    $__firstChild = $worksheet.DocumentElement.FirstChild
    if ($__firstChild) {
      [void]$worksheet.DocumentElement.InsertBefore($__sheetPr, $__firstChild)
    } else {
      [void]$worksheet.DocumentElement.AppendChild($__sheetPr)
    }
  }
  $__psup = $__sheetPr.SelectSingleNode('x:pageSetUpPr', $namespaceManager)
  if (-not $__psup) {
    $__psup = $worksheet.CreateElement('pageSetUpPr', $namespaceUri)
    [void]$__sheetPr.AppendChild($__psup)
  }
  $__psup.SetAttribute('fitToPage', '1')  # fitToWidth=1 in pageSetup forces all columns onto one horizontal page
} catch { } }

# Preserve the master template's compact default row height.  Data rows that need
# more room are expanded individually below; shrinking the sheet default makes
# text look compressed and diverges from the attached form.
try {
  $sfp = $worksheet.SelectSingleNode('/x:worksheet/x:sheetFormatPr', $namespaceManager)
  if ($sfp) {
    $sfp.SetAttribute('defaultRowHeight', '12.5')
    if ($sfp.HasAttribute('customHeight')) {
      [void]$sfp.RemoveAttribute('customHeight')
    }
  }
} catch { }

# ── Column widths ─────────────────────────────────────────────────────────────
# Preserve the master template's original column proportions and column-level
# style metadata.  The bounded print scale below handles the wider 0.5" margins
# without distorting the table or pushing Remarks onto a second horizontal page.
#
# Column breakdown (original template widths):
#   A  (Date)        9.73  — "1-May-26" / date values ✓
#   B  (Time)       17.82  — "8:00 AM - 5:00 PM" (18 chars) ✓
#   C  (From)       15.45  — "ILOILO DIVISION" (15 chars) ✓
#   D  (To)         16.00  — destination names ✓
#   E  (Mode)       11.00  — "TRICYCLE" ✓
#   F  (Amount)      9.54  — "3,555.00" / "99,999.99" ✓
#   G  (Per Diem)    9.73  — "9,999.00" ✓
#   H  (B/Breakfast)10.73  — "50.00" numeric ✓
#   I  (L/Lunch)    10.73  — same ✓
#   J  (D/Dinner)   12.73  — "500.00" ✓
#   K  (Others)     11.54  — hidden in the reference template
#   L  (Remarks)    22.54  — wide; wrapText enabled ✓
#
# Signatory merges (for reference):
#   Prepared By  A65:B65  = 27.55 u  (A+B)
#   Checked By   C65:D65  = 31.45 u  (C+D)
#   Checked By   E65:G65  = 30.27 u  (E+F+G)
#   Noted By     H65:I65  = 21.46 u  (H+I)
#   Approved By  J65:L65  = 34.10 u  (J+K_hidden+L)
@(
  @{ Idx = 1;  Width = 9.7265625  },   # A  Date
  @{ Idx = 2;  Width = 17.81640625 },  # B  Time              — "8:00 AM - 5:00 PM" ✓
  @{ Idx = 3;  Width = 15.453125 },    # C  From              — "ILOILO DIVISION" ✓
  @{ Idx = 4;  Width = 16.0  },   # D  To
  @{ Idx = 5;  Width = 11.0  },   # E  Mode of Transportation
  @{ Idx = 6;  Width = 9.54296875  },  # F  Amount
  @{ Idx = 7;  Width = 9.7265625  },   # G  Per Diem
  @{ Idx = 8;  Width = 10.7265625 },   # H  Breakfast (B)
  @{ Idx = 9;  Width = 10.7265625 },   # I  Lunch (L)
  @{ Idx = 10; Width = 12.7265625  },  # J  Dinner (D)
  @{ Idx = 11; Width = 11.54296875 },  # K  Others            — hidden; see block below
  @{ Idx = 12; Width = 22.54296875  }  # L  Remarks           — wrapText enabled ✓
) | ForEach-Object {
  Set-ColumnWidth -Document $worksheet -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -ColIndex $_.Idx -Width $_.Width
}

# Hide column K ("Others") — the field has been removed from this form.
# Setting hidden="1" on the <col> element makes Excel omit the column entirely
# from both screen display and PDF/print output.
$__colsEl = $worksheet.SelectSingleNode('/x:worksheet/x:cols', $namespaceManager)
if ($__colsEl) {
  foreach ($__colEl in @($__colsEl.SelectNodes('x:col', $namespaceManager))) {
    if ([int]$__colEl.GetAttribute('min') -le 11 -and [int]$__colEl.GetAttribute('max') -ge 11) {
      $__colEl.SetAttribute('hidden', '1')
      break
    }
  }
}

# ── Wrap-text style for Remarks column (L) ────────────────────────────────────
# Patch styles.xml: clone the data-cell style that the template assigns to L13
# (the first remarks cell) and enable wrapText + vertical-top alignment on it.
# The resulting style index ($remarksStyleIndex) is applied to every L data cell
# so that long remarks auto-expand the row height instead of overflowing.
$remarksStyleIndex   = 0
$titleWrapStyleIndex = 0
$routeWrapStyleIndex = 0
$tableFitStyleByColumn = @{}
$totalsFitStyleByCell = @{}
$stylesXmlPath = Join-Path $extractPath 'xl\styles.xml'
try {
  [xml]$styles = Get-Content -LiteralPath $stylesXmlPath -Encoding UTF8
  $stylesNsUri  = $styles.DocumentElement.NamespaceURI
  $stylesNm     = New-Object System.Xml.XmlNamespaceManager($styles.NameTable)
  $stylesNm.AddNamespace('x', $stylesNsUri)

  $cellXfs = $styles.SelectSingleNode('/x:styleSheet/x:cellXfs', $stylesNm)

  function Get-WorksheetCellStyleIndex {
    param([string]$CellReference)

    $cellNode = $worksheet.SelectSingleNode("/x:worksheet/x:sheetData/x:row/x:c[@r='$CellReference']", $namespaceManager)
    if ($cellNode -and $cellNode.HasAttribute('s')) {
      return [int]$cellNode.GetAttribute('s')
    }
    return 0
  }

  function New-LiquidationAlignedStyle {
    param(
      [int]$BaseStyleIndex,
      [string]$Horizontal = 'center',
      [string]$Vertical = 'center',
      [bool]$WrapText = $true,
      [bool]$ShrinkToFit = $true
    )

    $currentXfs = @($cellXfs.SelectNodes('x:xf', $stylesNm))
    $baseXf = if ($BaseStyleIndex -ge 0 -and $BaseStyleIndex -lt $currentXfs.Count) { $currentXfs[$BaseStyleIndex] } else { $currentXfs[0] }
    $newXf = $styles.CreateElement('xf', $stylesNsUri)
    foreach ($attr in $baseXf.Attributes) { $newXf.SetAttribute($attr.Name, $attr.Value) }
    $newXf.SetAttribute('applyAlignment', '1')
    foreach ($child in $baseXf.ChildNodes) {
      if ($child.LocalName -ne 'alignment') { [void]$newXf.AppendChild($child.CloneNode($true)) }
    }
    $alignment = $styles.CreateElement('alignment', $stylesNsUri)
    if (-not [string]::IsNullOrWhiteSpace($Horizontal)) { $alignment.SetAttribute('horizontal', $Horizontal) }
    if (-not [string]::IsNullOrWhiteSpace($Vertical)) { $alignment.SetAttribute('vertical', $Vertical) }
    if ($WrapText) { $alignment.SetAttribute('wrapText', '1') }
    if ($ShrinkToFit) { $alignment.SetAttribute('shrinkToFit', '1') }
    [void]$newXf.AppendChild($alignment)
    [void]$cellXfs.AppendChild($newXf)
    $newIndex = $currentXfs.Count
    $countString = $cellXfs.GetAttribute('count')
    $countValue = if ($countString -ne '') { [int]$countString } else { $currentXfs.Count }
    $cellXfs.SetAttribute('count', ($countValue + 1).ToString())
    return $newIndex
  }

  # Detect the base style assigned to the template's L13 cell
  $baseStyleIdx = 0
  $l13 = $worksheet.SelectSingleNode("/x:worksheet/x:sheetData/x:row[@r='13']/x:c[@r='L13']", $namespaceManager)
  if ($l13 -and $l13.HasAttribute('s')) { $baseStyleIdx = [int]$l13.GetAttribute('s') }

  $xfList = @($cellXfs.SelectNodes('x:xf', $stylesNm))

  # Re-use an existing wrapText style if it shares the same border as the base
  $wrapIdx = -1
  $baseBorder = if ($xfList.Count -gt $baseStyleIdx) { $xfList[$baseStyleIdx].GetAttribute('borderId') } else { '0' }
  for ($xi = 0; $xi -lt $xfList.Count; $xi++) {
    $aln = $xfList[$xi].SelectSingleNode('x:alignment', $stylesNm)
    if ($aln -and $aln.GetAttribute('wrapText') -eq '1' -and
        $xfList[$xi].GetAttribute('borderId') -eq $baseBorder) {
      $wrapIdx = $xi; break
    }
  }

  if ($wrapIdx -lt 0) {
    $baseXf = if ($xfList.Count -gt $baseStyleIdx) { $xfList[$baseStyleIdx] } else { $xfList[0] }
    $newXf  = $styles.CreateElement('xf', $stylesNsUri)
    foreach ($attr in $baseXf.Attributes) { $newXf.SetAttribute($attr.Name, $attr.Value) }
    $newXf.SetAttribute('applyAlignment', '1')
    foreach ($child in $baseXf.ChildNodes) {
      if ($child.LocalName -ne 'alignment') { [void]$newXf.AppendChild($child.CloneNode($true)) }
    }
    $aln = $styles.CreateElement('alignment', $stylesNsUri)
    $aln.SetAttribute('wrapText', '1')
    $aln.SetAttribute('vertical', 'top')
    [void]$newXf.AppendChild($aln)
    [void]$cellXfs.AppendChild($newXf)
    $wrapIdx = $xfList.Count
    $cntStr = $cellXfs.GetAttribute('count')
    $cnt = if ($cntStr -ne '') { [int]$cntStr } else { 0 }
    $cellXfs.SetAttribute('count', ($cnt + 1).ToString())
  }

  $remarksStyleIndex = $wrapIdx

  # Re-read xfList (may have grown if remarksStyleIndex was newly added)
  $xfList = @($cellXfs.SelectNodes('x:xf', $stylesNm))

  # Route/time wrap style: clone the centered data-cell style used by B/C data
  # cells and enable wrapText.  D/E already use a matching wrapped style in the
  # master template, but B/C need it for values like "Division Office 8".
  $routeBaseIdx = 0
  $b13 = $worksheet.SelectSingleNode("/x:worksheet/x:sheetData/x:row[@r='13']/x:c[@r='B13']", $namespaceManager)
  if ($b13 -and $b13.HasAttribute('s')) { $routeBaseIdx = [int]$b13.GetAttribute('s') }
  $routeWrapIdx = -1
  $routeBorder = if ($xfList.Count -gt $routeBaseIdx) { $xfList[$routeBaseIdx].GetAttribute('borderId') } else { '0' }
  for ($xi = 0; $xi -lt $xfList.Count; $xi++) {
    $aln = $xfList[$xi].SelectSingleNode('x:alignment', $stylesNm)
    if ($aln -and $aln.GetAttribute('wrapText') -eq '1' -and
        $xfList[$xi].GetAttribute('borderId') -eq $routeBorder -and
        $aln.GetAttribute('horizontal') -eq 'center') {
      $routeWrapIdx = $xi; break
    }
  }
  if ($routeWrapIdx -lt 0) {
    $baseRouteXf = if ($xfList.Count -gt $routeBaseIdx) { $xfList[$routeBaseIdx] } else { $xfList[0] }
    $newRouteXf  = $styles.CreateElement('xf', $stylesNsUri)
    foreach ($attr in $baseRouteXf.Attributes) { $newRouteXf.SetAttribute($attr.Name, $attr.Value) }
    $newRouteXf.SetAttribute('applyAlignment', '1')
    foreach ($child in $baseRouteXf.ChildNodes) {
      if ($child.LocalName -ne 'alignment') { [void]$newRouteXf.AppendChild($child.CloneNode($true)) }
    }
    $routeAln = $styles.CreateElement('alignment', $stylesNsUri)
    $routeAln.SetAttribute('wrapText', '1')
    $routeAln.SetAttribute('vertical', 'center')
    $routeAln.SetAttribute('horizontal', 'center')
    [void]$newRouteXf.AppendChild($routeAln)
    [void]$cellXfs.AppendChild($newRouteXf)
    $routeWrapIdx = $xfList.Count
    $cntRouteStr = $cellXfs.GetAttribute('count')
    $cntRoute = if ($cntRouteStr -ne '') { [int]$cntRouteStr } else { 0 }
    $cellXfs.SetAttribute('count', ($cntRoute + 1).ToString())
  }
  $routeWrapStyleIndex = $routeWrapIdx

  # Re-read again before title style work.
  $xfList = @($cellXfs.SelectNodes('x:xf', $stylesNm))

  # Title wrap style: clone style 157 (teal-center) + wrapText for row-67 title cells
  $titleBaseIdx = if ($xfList.Count -gt 157) { 157 } else { 0 }
  $titleWrapIdx = -1
  $titleBorder  = $xfList[$titleBaseIdx].GetAttribute('borderId')
  for ($xi = 0; $xi -lt $xfList.Count; $xi++) {
    $aln = $xfList[$xi].SelectSingleNode('x:alignment', $stylesNm)
    if ($aln -and $aln.GetAttribute('wrapText') -eq '1' -and
        $xfList[$xi].GetAttribute('borderId') -eq $titleBorder -and
        $aln.GetAttribute('horizontal') -eq 'center') {
      $titleWrapIdx = $xi; break
    }
  }
  if ($titleWrapIdx -lt 0) {
    $baseTXf = $xfList[$titleBaseIdx]
    $newTXf  = $styles.CreateElement('xf', $stylesNsUri)
    foreach ($attr in $baseTXf.Attributes) { $newTXf.SetAttribute($attr.Name, $attr.Value) }
    $newTXf.SetAttribute('applyAlignment', '1')
    foreach ($child in $baseTXf.ChildNodes) {
      if ($child.LocalName -ne 'alignment') { [void]$newTXf.AppendChild($child.CloneNode($true)) }
    }
    $tAln = $styles.CreateElement('alignment', $stylesNsUri)
    $tAln.SetAttribute('wrapText', '1')
    $tAln.SetAttribute('vertical', 'center')
    $tAln.SetAttribute('horizontal', 'center')
    [void]$newTXf.AppendChild($tAln)
    [void]$cellXfs.AppendChild($newTXf)
    $titleWrapIdx = $xfList.Count
    $cntStr2 = $cellXfs.GetAttribute('count')
    $cnt2 = if ($cntStr2 -ne '') { [int]$cntStr2 } else { 0 }
    $cellXfs.SetAttribute('count', ($cnt2 + 1).ToString())
  }
  $titleWrapStyleIndex = $titleWrapIdx

  foreach ($tableColumn in @('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'L')) {
    $tableFitStyleByColumn[$tableColumn] = New-LiquidationAlignedStyle `
      -BaseStyleIndex (Get-WorksheetCellStyleIndex ("$($tableColumn)13")) `
      -Horizontal 'center' `
      -Vertical 'center' `
      -WrapText $true `
      -ShrinkToFit $true
  }

  foreach ($cellReference in @('J59', 'J60', 'J61')) {
    $totalsFitStyleByCell[$cellReference] = New-LiquidationAlignedStyle `
      -BaseStyleIndex (Get-WorksheetCellStyleIndex $cellReference) `
      -Horizontal 'right' `
      -Vertical 'center' `
      -WrapText $true `
      -ShrinkToFit $true
  }
  foreach ($cellReference in @('K59', 'K60', 'K61')) {
    $totalsFitStyleByCell[$cellReference] = New-LiquidationAlignedStyle `
      -BaseStyleIndex (Get-WorksheetCellStyleIndex $cellReference) `
      -Horizontal 'center' `
      -Vertical 'center' `
      -WrapText $true `
      -ShrinkToFit $true
  }
  foreach ($cellReference in @('L59', 'L60', 'L61')) {
    $totalsFitStyleByCell[$cellReference] = New-LiquidationAlignedStyle `
      -BaseStyleIndex (Get-WorksheetCellStyleIndex $cellReference) `
      -Horizontal 'right' `
      -Vertical 'center' `
      -WrapText $true `
      -ShrinkToFit $true
  }

  # ── Fix first-data-row top border: medium → thin ────────────────────────────
  # The template gives every cell in row 13 (the first data row) a MEDIUM (thick)
  # TOP border, which renders as a bold horizontal line between the column headers
  # and the table body.  Thick weight must be reserved for the table's outer
  # perimeter only, so downgrade just the TOP edge of those borders to thin.
  # Left/right MEDIUM edges (the outer table sides) are preserved untouched.
  try {
    $__bordersEl = $styles.SelectSingleNode('/x:styleSheet/x:borders', $stylesNm)
    $__allXf     = @($cellXfs.SelectNodes('x:xf', $stylesNm))
    $__borderList = @($__bordersEl.SelectNodes('x:border', $stylesNm))

    # Collect the unique borderIds referenced by row 13's cells
    $__row13 = $worksheet.SelectSingleNode("/x:worksheet/x:sheetData/x:row[@r='13']", $namespaceManager)
    $__row13Borders = @{}
    if ($__row13) {
      foreach ($__c13 in $__row13.SelectNodes('x:c', $namespaceManager)) {
        $__sIdx = if ($__c13.HasAttribute('s')) { [int]$__c13.GetAttribute('s') } else { 0 }
        if ($__sIdx -ge 0 -and $__sIdx -lt $__allXf.Count) {
          $__bId = $__allXf[$__sIdx].GetAttribute('borderId')
          if ($__bId -ne '') { $__row13Borders[$__bId] = $true }
        }
      }
    }

    # For each such border, change a medium TOP edge to thin
    foreach ($__bKey in $__row13Borders.Keys) {
      $__bi = [int]$__bKey
      if ($__bi -ge 0 -and $__bi -lt $__borderList.Count) {
        $__topEl = $__borderList[$__bi].SelectSingleNode('x:top', $stylesNm)
        if ($__topEl -and $__topEl.GetAttribute('style') -eq 'medium') {
          $__topEl.SetAttribute('style', 'thin')
        }
      }
    }
  } catch {
    # Non-fatal: worst case the first data row keeps its thick top border.
  }

  $styles.Save($stylesXmlPath)
} catch {
  # Non-fatal: Remarks cells keep their template style if styles.xml is unreadable.
}

$tableStartRow = 13
$tableEndRow = 56
$tableColumns = @('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L')

Set-RichHeaderCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'A7' -Label 'Name' -Value ([string]$payload.employeeName)
Set-RichHeaderCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'G7' -Label 'Date' -Value ([string]$payload.reportDate)
Set-RichHeaderCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'A8' -Label 'Designation' -Value ([string]$payload.designation)
Set-RichHeaderCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'G8' -Label 'Base' -Value ([string]$payload.base)
Set-RichHeaderCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'A9' -Label 'Purpose' -Value ([string]$payload.purpose)

for ($row = $tableStartRow; $row -le $tableEndRow; $row++) {
  foreach ($column in $tableColumns) {
    Clear-CellValue -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference ("$column$row")
  }
}

$items = @($payload.items)
$maxItems = $tableEndRow - $tableStartRow + 1
for ($index = 0; $index -lt [Math]::Min($items.Count, $maxItems); $index++) {
  $row = $tableStartRow + $index
  $item = $items[$index]

  $transactionDateText = Format-LiquidationDateText ([string]$item.transactionDate)
  $transactionTimeText = Normalize-LiquidationTimeText ([string]$item.time)
  Set-InlineStringCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference ("A$row") -Value $transactionDateText
  Set-InlineStringCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference ("B$row") -Value $transactionTimeText
  Set-InlineStringCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference ("C$row") -Value ([string]$item.from)
  Set-InlineStringCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference ("D$row") -Value ([string]$item.to)
  Set-InlineStringCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference ("E$row") -Value ([string]$item.modeOfTransportation)
  Set-NumberCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference ("F$row") -Value (Convert-ToExcelNumber ([string]$item.amount))
  Set-NumberCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference ("G$row") -Value (Convert-ToExcelNumber ([string]$item.perDiem))
  Set-NumberCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference ("H$row") -Value (Convert-ToExcelNumber ([string]$item.breakfast))
  Set-NumberCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference ("I$row") -Value (Convert-ToExcelNumber ([string]$item.lunch))
  Set-NumberCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference ("J$row") -Value (Convert-ToExcelNumber ([string]$item.dinner))
  Set-InlineStringCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference ("L$row") -Value ([string]$item.remarks)

  # Expand only the rows that need wrapping.  This keeps the reference form
  # compact while preventing remarks, route names, and time ranges from being
  # clipped or spilling outside their borders.
  $lRowEl = Get-OrCreate-Row -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -RowIndex $row
  $rowHeight = Get-LiquidationDataRowHeight $item
  $lRowEl.SetAttribute('ht', $rowHeight.ToString('0.##', [System.Globalization.CultureInfo]::InvariantCulture))
  $lRowEl.SetAttribute('customHeight', '1')

  if ($routeWrapStyleIndex -gt 0) {
    foreach ($routeColumn in @('B', 'C')) {
      $routeCell = Get-OrCreate-Cell -Document $worksheet -Row $lRowEl -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference ("$routeColumn$row")
      $routeCell.SetAttribute('s', $routeWrapStyleIndex.ToString())
    }
  }

  # Apply wrap-text style to the Remarks cell (L column) so long remarks wrap within
  # the calculated row height rather than overflowing into adjacent cells.
  if ($remarksStyleIndex -gt 0) {
    $lCell = Get-OrCreate-Cell -Document $worksheet -Row $lRowEl -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference ("L$row")
    $lCell.SetAttribute('s', $remarksStyleIndex.ToString())
  }

  if ($tableFitStyleByColumn.Count -gt 0) {
    foreach ($fitColumn in @('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'L')) {
      if ($tableFitStyleByColumn.ContainsKey($fitColumn)) {
        $fitCell = Get-OrCreate-Cell -Document $worksheet -Row $lRowEl -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference ("$fitColumn$row")
        $fitCell.SetAttribute('s', ([string]$tableFitStyleByColumn[$fitColumn]))
      }
    }
  }
}

# ── Settlement totals: computed and written as cached formula values ──────────
# Refresh the formula caches so the generated workbook opens with the submitted
# totals even before Excel recalculates the sheet.
[double]$__sumAmount    = 0
[double]$__sumPerDiem   = 0
[double]$__sumBreakfast = 0
[double]$__sumLunch     = 0
[double]$__sumDinner    = 0
foreach ($__it in $items) {
  $__v = Convert-ToExcelNumber ([string]$__it.amount);    if ($null -ne $__v) { $__sumAmount    += [double]$__v }
  $__v = Convert-ToExcelNumber ([string]$__it.perDiem);   if ($null -ne $__v) { $__sumPerDiem   += [double]$__v }
  $__v = Convert-ToExcelNumber ([string]$__it.breakfast); if ($null -ne $__v) { $__sumBreakfast += [double]$__v }
  $__v = Convert-ToExcelNumber ([string]$__it.lunch);     if ($null -ne $__v) { $__sumLunch     += [double]$__v }
  $__v = Convert-ToExcelNumber ([string]$__it.dinner);    if ($null -ne $__v) { $__sumDinner    += [double]$__v }
}
[double]$__totalExpenses = $__sumAmount + $__sumPerDiem + $__sumBreakfast + $__sumLunch + $__sumDinner
$__ic = [System.Globalization.CultureInfo]::InvariantCulture

# Row 57 and totals cells keep the reference formulas; only cached values are refreshed.
Set-CachedFormulaValue -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'F57' -Value $__sumAmount.ToString($__ic)
Set-CachedFormulaValue -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'G57' -Value $__sumPerDiem.ToString($__ic)
Set-CachedFormulaValue -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'H57' -Value $__sumBreakfast.ToString($__ic)
Set-CachedFormulaValue -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'I57' -Value $__sumLunch.ToString($__ic)
Set-CachedFormulaValue -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'J57' -Value $__sumDinner.ToString($__ic)

foreach ($__totalMerge in @('J59:K59', 'J60:K60', 'J61:K61')) {
  Remove-MergeRange -Document $worksheet -NamespaceManager $namespaceManager -Range $__totalMerge
}

Set-InlineStringCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'J59' -Value 'Total Expenses'
Set-InlineStringCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'K59' -Value 'PHP'
Set-CachedFormulaValue -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'L59' -Value $__totalExpenses.ToString($__ic)

# L60 Total CA (cashAdvance)
Set-InlineStringCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'J60' -Value 'Total CA'
Set-InlineStringCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'K60' -Value 'PHP'
Set-NumberCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'L60' -Value (Convert-ToExcelNumber ([string]$payload.cashAdvance))

# L61 Return to CO = cashAdvance minus totalExpenses.
$__caVal = Convert-ToExcelNumber ([string]$payload.cashAdvance)
[double]$__caNum      = if ($null -ne $__caVal) { [double]$__caVal } else { 0.0 }
[double]$__returnToCO = $__caNum - $__totalExpenses
Set-CachedFormulaValue -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'L61' -Value ([Math]::Abs($__returnToCO)).ToString($__ic)
# J61 label: "Return to CO" when positive, "Reimbursement" when negative
$__returnLabel = if ($__returnToCO -ge 0) { 'Return to CO' } else { 'Reimbursement' }
Set-InlineStringCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'J61' -Value $__returnLabel
Set-InlineStringCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference 'K61' -Value 'PHP'

if ($totalsFitStyleByCell.Count -gt 0) {
  foreach ($totalCellReference in @('J59', 'K59', 'L59', 'J60', 'K60', 'L60', 'J61', 'K61', 'L61')) {
    if ($totalsFitStyleByCell.ContainsKey($totalCellReference)) {
      $__totalRef = Parse-CellReference $totalCellReference
      $__totalRow = Get-OrCreate-Row -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -RowIndex $__totalRef.Row
      $__totalCell = Get-OrCreate-Cell -Document $worksheet -Row $__totalRow -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference $totalCellReference
      $__totalCell.SetAttribute('s', ([string]$totalsFitStyleByCell[$totalCellReference]))
    }
  }
}

if (Test-Path -LiteralPath $drawingPath -ErrorAction Ignore) {
  try {
    [xml]$__sigDrawing = Get-Content -LiteralPath $drawingPath -Encoding UTF8
    Set-DrawingTextBox -Drawing $__sigDrawing -ShapeName 'TextBox 14' -Paragraphs @(
      @{ Text = 'Prepared  By:'; Bold = $true },
      @{ Text = '' },
      @{ Text = '    _____________________' },
      @{ Text = ('    ' + [string]$payload.preparedByTitle) }
    )
    Set-DrawingTextBox -Drawing $__sigDrawing -ShapeName 'TextBox 4' -Paragraphs @(
      @{ Text = [string]$payload.preparedByName; Bold = $true }
    )
    Set-DrawingTextBox -Drawing $__sigDrawing -ShapeName 'TextBox 6' -Paragraphs @(
      @{ Text = 'Checked  By:'; Bold = $true },
      @{ Text = '' },
      @{ Text = '    _____________________' },
      @{ Text = ('    ' + [string]$payload.checkedByTitle) }
    )
    Set-DrawingTextBox -Drawing $__sigDrawing -ShapeName 'TextBox 7' -Paragraphs @(
      @{ Text = [string]$payload.checkedByName; Bold = $true }
    )
    Set-DrawingTextBox -Drawing $__sigDrawing -ShapeName 'TextBox 1' -Paragraphs @(
      @{ Text = 'Checked  By:'; Bold = $true },
      @{ Text = '' },
      @{ Text = '    _____________________' },
      @{ Text = ('    ' + [string]$payload.reviewedByTitle) }
    )
    Set-DrawingTextBox -Drawing $__sigDrawing -ShapeName 'TextBox 8' -Paragraphs @(
      @{ Text = [string]$payload.reviewedByName; Bold = $true }
    )
    Set-DrawingTextBox -Drawing $__sigDrawing -ShapeName 'TextBox 13' -Paragraphs @(
      @{ Text = 'Noted  By:'; Bold = $true },
      @{ Text = '' },
      @{ Text = ('     ' + [string]$payload.notedByName); Bold = $true; Underline = $true },
      @{ Text = ('     ' + [string]$payload.notedByTitle) }
    )
    Set-DrawingTextBox -Drawing $__sigDrawing -ShapeName 'TextBox 16' -Paragraphs @(
      @{ Text = 'Approved  By:'; Bold = $true },
      @{ Text = '' },
      @{ Text = [string]$payload.approvedByName; Bold = $true; Underline = $true },
      @{ Text = ('   ' + [string]$payload.approvedByTitle) }
    )
    $__sigDrawing.Save($drawingPath)
  } catch {
    Write-Warning "[liquidation-signatories] Could not update reference drawing text boxes: $_"
  }
}

if ($false) {
# Clear all signatory rows to start with a clean slate
$signatoryRows = 63..70
foreach ($row in $signatoryRows) {
  foreach ($column in $tableColumns) {
    Clear-CellValue -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference ("$column$row")
  }
}

# Row heights for the signatory block — kept as compact as practical so the entire
# form fits on one page.  All values are chosen to stay legible while minimising
# the vertical footprint of the footer area.
#
#   63 – label row ("Prepared By:", etc.)       12 pt
#   64 – signature space (physical signature)   16 pt  — ~5.6 mm; enough for initials/short sig
#   65 – name row (bold underlined names)       14 pt
#   66 – thin gap between name and title         3 pt
#   67 – title row (wrap-text, fixed height)    13 pt  — pinned to prevent auto-expansion
Set-RowHeight -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -RowIndex 63 -Height 12
# Row 64 = physical signature space. Expand to 50 pt when a signature image is provided
# so the embedded picture (44 pt) has room to render clearly above the printed name.
$__sigRow64Height = if ($SignaturePath -and (Test-Path -LiteralPath $SignaturePath -ErrorAction Ignore)) { 50 } else { 16 }
Set-RowHeight -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -RowIndex 64 -Height $__sigRow64Height
Set-RowHeight -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -RowIndex 65 -Height 14
Set-RowHeight -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -RowIndex 66 -Height 3
Set-RowHeight -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -RowIndex 67 -Height 13

# Remove all template merge cells in signatory area to prevent conflicts
@('A68:B68', 'F68:I68', 'A70:B70', 'F70:I70') | ForEach-Object {
  Remove-MergeRange -Document $worksheet -NamespaceManager $namespaceManager -Range $_
}

# Add column merges for label row (63), name row (65), and title row (67).
# Signatory order matches the reference form:
#   Prepared By (A:B) | Checked By (C:D) | Checked By (E:G) | Noted By (H:I) | Approved By (J:L)
@(
  'A63:B63', 'C63:D63', 'E63:G63', 'H63:I63', 'J63:L63',
  'A65:B65', 'C65:D65', 'E65:G65', 'H65:I65', 'J65:L65',
  'A67:B67', 'C67:D67', 'E67:G67', 'H67:I67', 'J67:L67'
) | ForEach-Object {
  Ensure-MergeRange -Document $worksheet -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -Range $_
}

# Force bold-black style (163) on name cells so they render black, not teal
foreach ($nameCol in @('A', 'C', 'E', 'H', 'J')) {
  $__pRef = Parse-CellReference "${nameCol}65"
  $__nRow = Get-OrCreate-Row -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -RowIndex $__pRef.Row
  $__nc   = Get-OrCreate-Cell -Document $worksheet -Row $__nRow -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference "${nameCol}65"
  $__nc.SetAttribute('s', '163')
}

$signatories = @(
  @{ Label = 'Prepared By:'; NameCell = 'A65'; TitleCell = 'A67'; Name = [string]$payload.preparedByName; Title = [string]$payload.preparedByTitle },
  @{ Label = 'Checked By:'; NameCell = 'C65'; TitleCell = 'C67'; Name = [string]$payload.checkedByName; Title = [string]$payload.checkedByTitle },
  @{ Label = 'Checked By:'; NameCell = 'E65'; TitleCell = 'E67'; Name = [string]$payload.reviewedByName; Title = [string]$payload.reviewedByTitle },
  @{ Label = 'Noted By:'; NameCell = 'H65'; TitleCell = 'H67'; Name = [string]$payload.notedByName; Title = [string]$payload.notedByTitle },
  @{ Label = 'Approved By:'; NameCell = 'J65'; TitleCell = 'J67'; Name = [string]$payload.approvedByName; Title = [string]$payload.approvedByTitle }
)

$labelCells = @('A63', 'C63', 'E63', 'H63', 'J63')
for ($index = 0; $index -lt $signatories.Count; $index++) {
  $entry = $signatories[$index]
  Set-InlineStringCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference $labelCells[$index] -Value $entry.Label
  Set-InlineStringCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference $entry.NameCell -Value $entry.Name
  Set-InlineStringCell -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference $entry.TitleCell -Value $entry.Title
  # Apply wrap-text style to title cell so long titles (e.g. "FA Supervisor, CD (Central Office)") wrap within the merged range
  if ($titleWrapStyleIndex -gt 0) {
    $__tRef  = Parse-CellReference $entry.TitleCell
    $__tRow  = Get-OrCreate-Row  -Document $worksheet -SheetData $sheetData -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -RowIndex $__tRef.Row
    $__tCell = Get-OrCreate-Cell -Document $worksheet -Row $__tRow -NamespaceManager $namespaceManager -NamespaceUri $namespaceUri -CellReference $entry.TitleCell
    $__tCell.SetAttribute('s', $titleWrapStyleIndex.ToString())
  }
}
}

$pageHorizontalMargin = 0.5   # 0.5" left/right — equal margins keep the table centered
$pageVerticalMargin   = 0.5   # 0.5" top/bottom

# ── Horizontal centering: equal left and right margins ────────────────────────
if ($false) { try {
  $printOpts = $worksheet.SelectSingleNode('/x:worksheet/x:printOptions', $namespaceManager)
  if (-not $printOpts) {
    $printOpts = $worksheet.CreateElement('printOptions', $namespaceUri)
    $pgMargRef = $worksheet.SelectSingleNode('/x:worksheet/x:pageMargins', $namespaceManager)
    if ($pgMargRef) {
      [void]$worksheet.DocumentElement.InsertBefore($printOpts, $pgMargRef)
    } else {
      [void]$worksheet.DocumentElement.AppendChild($printOpts)
    }
  }
  $printOpts.SetAttribute('horizontalCentered', '1')
} catch { } }

# ── Page margins ──────────────────────────────────────────────────────────────
if ($false) { try {
  $pgMarg = $worksheet.SelectSingleNode('/x:worksheet/x:pageMargins', $namespaceManager)
  if (-not $pgMarg) {
    $pgMarg = $worksheet.CreateElement('pageMargins', $namespaceUri)
    [void]$worksheet.DocumentElement.AppendChild($pgMarg)
  }
  $pgMarg.SetAttribute('left',   $pageHorizontalMargin.ToString('0.###', [System.Globalization.CultureInfo]::InvariantCulture))
  $pgMarg.SetAttribute('right',  $pageHorizontalMargin.ToString('0.###', [System.Globalization.CultureInfo]::InvariantCulture))
  $pgMarg.SetAttribute('top',    $pageVerticalMargin.ToString('0.###', [System.Globalization.CultureInfo]::InvariantCulture))
  $pgMarg.SetAttribute('bottom', $pageVerticalMargin.ToString('0.###', [System.Globalization.CultureInfo]::InvariantCulture))
  if (-not $pgMarg.HasAttribute('header')) { $pgMarg.SetAttribute('header', '0.3') }
  if (-not $pgMarg.HasAttribute('footer')) { $pgMarg.SetAttribute('footer', '0.3') }
} catch { } }

# ── Page setup: fitToWidth=1 keeps all columns (A–L) on one horizontal page ──
# Excel honors fitToWidth when fitToPage=1 (set in sheetPr above).  Rows that
# exceed the page height flow naturally to the next page(s) because fitToHeight=0
# means "unlimited pages tall".
# An explicit scale attribute is removed — it has no effect when fitToPage=1.
if ($false) { try {
  $pgSetup = $worksheet.SelectSingleNode('/x:worksheet/x:pageSetup', $namespaceManager)
  if (-not $pgSetup) {
    $pgSetup = $worksheet.CreateElement('pageSetup', $namespaceUri)
    $pgRef = $worksheet.SelectSingleNode('/x:worksheet/x:pageMargins', $namespaceManager)
    if ($pgRef) {
      [void]$worksheet.DocumentElement.InsertBefore($pgSetup, $pgRef)
    } else {
      [void]$worksheet.DocumentElement.AppendChild($pgSetup)
    }
  }
  if ($pgSetup.HasAttribute('scale')) { $pgSetup.RemoveAttribute('scale') }   # unused with fitToPage=1
  $pgSetup.SetAttribute('fitToWidth',  '1')   # 1 page wide — Remarks stays on same page
  $pgSetup.SetAttribute('fitToHeight', '0')   # 0 = unlimited pages tall; rows flow to next pages
  $pgSetup.SetAttribute('paperSize', '9')                    # 9 = A4
  if (-not $pgSetup.HasAttribute('orientation')) { $pgSetup.SetAttribute('orientation', 'portrait') }
} catch {
  # Non-fatal
} }

$worksheet.Save($sheetPath)

$generatedWorkbookPath = if ($Format -eq 'xlsx') {
  $OutputPath
} else {
  Join-Path $tempRoot 'liquidation-form.generated.xlsx'
}

if (Test-Path -LiteralPath $generatedWorkbookPath) {
  Remove-Item -LiteralPath $generatedWorkbookPath -Force
}

if ($generatedWorkbookPath -eq $OutputPath -and (Test-Path -LiteralPath $OutputPath)) {
  Remove-Item -LiteralPath $OutputPath -Force
}

[System.IO.Compression.ZipFile]::CreateFromDirectory($extractPath, $generatedWorkbookPath)

if ($Format -eq 'xlsx') {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force
  return
}

# ── Pre-flight ─────────────────────────────────────────────────────────────────

if (-not (Test-Path -LiteralPath $generatedWorkbookPath -ErrorAction Ignore)) {
  throw "PDF export failed: generated workbook not found at '$generatedWorkbookPath'."
}

try {
  $__vz = [System.IO.Compression.ZipFile]::OpenRead($generatedWorkbookPath)
  $__vz.Dispose()
} catch {
  throw "PDF export failed: generated workbook is not a valid XLSX (ZIP) file. Detail: $_"
}

# ── PDF export: inline Excel COM (no child process) ────────────────────────────
#
# ROOT CAUSE of "Unable to get the Open property of the Workbooks class":
#   The previous design spawned Excel COM inside a Start-Process grandchild.
#   That grandchild process inherits the restricted window station of the
#   Node.js parent (a pseudo-console / non-interactive session), which prevents
#   Excel's COM server from servicing Workbooks.Open() even when the
#   Excel.Application object appears to be created successfully.
#
# FIX: Run all COM automation INLINE in the same PowerShell process that
#   Node.js already launched.  That process has the correct interactive window
#   station and COM access rights.  No helper script, no Start-Process.
#
# Additional fixes applied here:
#   - Unblock-File + Zone.Identifier ADS removal  (Protected View trigger)
#   - 800 ms settle delay after Excel.Application creation
#   - $xl.EnableEvents = $false and $xl.Interactive = $false
#   - Fresh COM instance per retry (never reuse a bad instance)
#   - Unique session temp dir (no stale file-lock collisions)
#   - Kill orphaned EXCEL.EXE before starting

# 1. Kill orphaned Excel processes ─────────────────────────────────────────────
try {
  $__orphans = Get-Process -Name 'EXCEL' -ErrorAction Ignore
  if ($__orphans) {
    $__orphans | Stop-Process -Force -ErrorAction Ignore
    Start-Sleep -Milliseconds 2000
  }
} catch {}

# 2. Resolve %TEMP% to canonical long path ─────────────────────────────────────
# 8.3 short paths (C:\Users\SUPLAD~1\...) contain a tilde that triggers
# Excel Protected View even for files already inside %TEMP%.
$__longTemp = $null
try { $__longTemp = [System.Environment]::GetEnvironmentVariable('TEMP', [System.EnvironmentVariableTarget]::User) } catch {}
if (-not $__longTemp -or $__longTemp -like '*~*') {
  try { $__longTemp = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:TEMP).Path } catch {}
}
if (-not $__longTemp -or $__longTemp -like '*~*') {
  try {
    $__up = [System.Environment]::GetEnvironmentVariable('USERPROFILE', [System.EnvironmentVariableTarget]::User)
    if ($__up) { $__longTemp = Join-Path $__up 'AppData\Local\Temp' }
  } catch {}
}
if (-not $__longTemp) { $__longTemp = $env:TEMP }

# Unique session dir — no file-lock collision from a prior failed export.
$__sid      = [System.Guid]::NewGuid().ToString('N').Substring(0, 8)
$__safeDir  = Join-Path $__longTemp "liqhlp-$__sid"
$__safeXlsx = Join-Path $__safeDir  'liq.xlsx'
$__safePdf  = Join-Path $__safeDir  'liq.pdf'

# 3. Copy workbook to isolated session temp dir ────────────────────────────────
try {
  New-Item -ItemType Directory -Path $__safeDir -Force -ErrorAction Stop | Out-Null
  Copy-Item -LiteralPath $generatedWorkbookPath -Destination $__safeXlsx -Force -ErrorAction Stop
} catch {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction Ignore
  throw "PDF export failed: could not copy workbook to temp dir '$__safeDir'. Detail: $_"
}

# 4. Strip Zone.Identifier — #1 hidden cause of Protected View blocking Open() ─
# Files copied between locations can carry a :Zone.Identifier alternate data
# stream that marks them as coming from the internet zone.  With
# DisplayAlerts=false, Excel's Protected View silently throws
# "Unable to get the Open property of the Workbooks class" instead of prompting.
try { Unblock-File -LiteralPath $__safeXlsx -ErrorAction Ignore } catch {}
try {
  $__zoneFile = $__safeXlsx + ':Zone.Identifier'
  if (Test-Path -LiteralPath $__zoneFile -ErrorAction Ignore) {
    Remove-Item -LiteralPath $__zoneFile -Force -ErrorAction Ignore
  }
} catch {}

# 5. Registry: disable Protected View + mark %TEMP% as Trusted Location ────────
foreach ($__ver in @('16.0', '15.0', '14.0', '12.0')) {
  try {
    $__pvKey = "HKCU:\Software\Microsoft\Office\$__ver\Excel\Security\ProtectedView"
    if (-not (Test-Path -LiteralPath $__pvKey -ErrorAction Ignore)) {
      New-Item -Path $__pvKey -Force -ErrorAction Ignore | Out-Null
    }
    Set-ItemProperty -Path $__pvKey -Name 'DisableInternetFilesInPV'   -Value 1 -Type DWord -ErrorAction Ignore
    Set-ItemProperty -Path $__pvKey -Name 'DisableUnsafeLocationsInPV' -Value 1 -Type DWord -ErrorAction Ignore
    Set-ItemProperty -Path $__pvKey -Name 'DisableAttachmentsInPV'     -Value 1 -Type DWord -ErrorAction Ignore
  } catch {}
  try {
    $__tlKey = "HKCU:\Software\Microsoft\Office\$__ver\Excel\Security\Trusted Locations\LiqAutomation"
    if (-not (Test-Path -LiteralPath $__tlKey -ErrorAction Ignore)) {
      New-Item -Path $__tlKey -Force -ErrorAction Ignore | Out-Null
    }
    Set-ItemProperty -Path $__tlKey -Name 'Path'            -Value $__longTemp -ErrorAction Ignore
    Set-ItemProperty -Path $__tlKey -Name 'AllowSubfolders' -Value 1 -Type DWord -ErrorAction Ignore
    Set-ItemProperty -Path $__tlKey -Name 'Description'     -Value 'Liquidation automation' -ErrorAction Ignore
  } catch {}
}

# 6. Ensure COM desktop paths exist ────────────────────────────────────────────
foreach ($__desk in @(
  'C:\Windows\System32\config\systemprofile\Desktop',
  'C:\Windows\SysWOW64\config\systemprofile\Desktop'
)) {
  try {
    if (-not (Test-Path -LiteralPath $__desk -ErrorAction Ignore)) {
      New-Item -ItemType Directory -Path $__desk -Force -ErrorAction Ignore | Out-Null
    }
  } catch {}
}

# 7. Excel COM — inline, fresh instance per retry ──────────────────────────────
$__pdfDone = $false

function __Release-Com($__obj) {
  if ($__obj) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($__obj) } catch {} }
}

function __Close-Excel($__wb, $__xl) {
  if ($__wb) { try { $__wb.Close($false) } catch {}; __Release-Com $__wb }
  if ($__xl) { try { $__xl.Quit()       } catch {}; __Release-Com $__xl }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  [GC]::Collect()
}

$__lastErr = 'no attempt made'
$__delays  = @(0, 2000, 4000, 8000)   # ms wait before each attempt

for ($__i = 0; $__i -lt $__delays.Count; $__i++) {
  if ($__pdfDone) { break }
  if ($__delays[$__i] -gt 0) { Start-Sleep -Milliseconds $__delays[$__i] }

  $__xl = $null
  $__wb = $null
  try {
    # Always start a brand-new instance — never share state with a prior attempt.
    try {
      $__xl = New-Object -ComObject Excel.Application
    } catch {
      $__lastErr = "Attempt $($__i+1)-CREATE: $_"
      continue
    }
    if (-not $__xl) {
      $__lastErr = "Attempt $($__i+1)-CREATE: New-Object returned null"
      continue
    }

    $__xl.Visible       = $false
    $__xl.DisplayAlerts = $false
    $__xl.EnableEvents  = $false
    $__xl.Interactive   = $false
    try { $__xl.Application.AutomationSecurity = 1 } catch {}

    # Wait for Excel to finish internal startup before touching Workbooks.
    # COM objects can exist before Excel's message pump is ready; calling
    # Workbooks.Open() too early produces the "unable to get Open property" error.
    Start-Sleep -Milliseconds 800

    # Health check: confirm COM is actually serviceable before Open().
    try {
      $null = $__xl.Workbooks.Count
    } catch {
      $__lastErr = "Attempt $($__i+1)-HEALTH: COM not serviceable: $_"
      __Close-Excel $null $__xl
      $__xl = $null
      continue
    }

    # Open the workbook.
    # UpdateLinks=0   — skip external-link resolution (avoids network timeouts)
    # CorruptLoad=2   — silently repair without prompting (xlRepairFile)
    try {
      $__wb = $__xl.Workbooks.Open(
        $__safeXlsx,  # Filename
        0,            # UpdateLinks
        $false,       # ReadOnly
        5,            # Format (ignored for XLSX)
        '',           # Password
        '',           # WriteResPassword
        $true,        # IgnoreReadOnlyRecommended
        2,            # Origin (xlWindows)
        '',           # Delimiter
        $false,       # Editable
        $false,       # Notify
        0,            # Converter
        $false        # AddToMru
      )
    } catch {
      $__lastErr = "Attempt $($__i+1)-OPEN: $_"
      __Close-Excel $null $__xl
      $__xl = $null
      continue
    }

    if (-not $__wb) {
      $__lastErr = "Attempt $($__i+1)-OPEN: Workbooks.Open returned null"
      __Close-Excel $null $__xl
      $__xl = $null
      continue
    }

    # Export: try named sheet → active sheet → whole workbook.
    $__exportErr = ''
    $__didExport = $false

    # Keep the official reference workbook's page setup; only restate the print area.
    function Set-ReferencePrintArea($__sheet) {
      try {
        $__ps = $__sheet.PageSetup
        $__ps.PrintArea = '$A$1:$L$74'
      } catch {}
    }

    try {
      $__ws = $__wb.Worksheets.Item('Liquidation TAR ')
      Set-ReferencePrintArea $__ws
      $__ws.ExportAsFixedFormat(0, $__safePdf)
      $__didExport = $true
    } catch { $__exportErr = "$_" }

    if (-not $__didExport) {
      try {
        $__ws2 = $__wb.ActiveSheet
        Set-ReferencePrintArea $__ws2
        $__ws2.ExportAsFixedFormat(0, $__safePdf)
        $__didExport = $true
      } catch { $__exportErr = "$_" }
    }

    if (-not $__didExport) {
      try {
        foreach ($__s in $__wb.Worksheets) { Set-ReferencePrintArea $__s }
        $__wb.ExportAsFixedFormat(0, $__safePdf)
        $__didExport = $true
      } catch { $__exportErr = "$_" }
    }

    if ($__didExport -and (Test-Path -LiteralPath $__safePdf -ErrorAction Ignore)) {
      Copy-Item -LiteralPath $__safePdf -Destination $OutputPath -Force
      $__pdfDone = $true
    } else {
      $__lastErr = "Attempt $($__i+1)-EXPORT: $__exportErr"
    }

    __Close-Excel $__wb $__xl
    $__xl = $null
    $__wb = $null

  } catch {
    $__lastErr = "Attempt $($__i+1)-UNEXPECTED: $_"
    __Close-Excel $__wb $__xl
    $__xl = $null
    $__wb = $null
  }
}

if (-not $__pdfDone) {
  try { Remove-Item -LiteralPath $__safeDir -Recurse -Force -ErrorAction Ignore } catch {}
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction Ignore
  throw "PDF conversion failed: $__lastErr"
}

# ── Cleanup ────────────────────────────────────────────────────────────────────
try { Remove-Item -LiteralPath $__safeDir -Recurse -Force -ErrorAction Ignore } catch {}

if (-not (Test-Path -LiteralPath $OutputPath -ErrorAction Ignore)) {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction Ignore
  throw "PDF conversion appeared to succeed but output file not found at '$OutputPath'."
}

Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction Ignore
