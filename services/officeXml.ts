/** XML helpers for worksheet values, formatting, and drawing text in existing workbook exports. */
function escapeXmlText(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

function columnIndex(column: string): number {
  return column.split("").reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
}

function parseCellReference(cellReference: string): { column: string; row: number; columnIndex: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(cellReference);
  if (!match) throw new Error(`Invalid cell reference: ${cellReference}`);
  return { column: match[1], row: Number(match[2]), columnIndex: columnIndex(match[1]) };
}

function normalizeCellAttributes(attributes: string, cellReference: string, type?: "inlineStr" | "str"): string {
  const attrs = attributes
    .replace(/\s+r="[^"]*"/, "")
    .replace(/\s+t="[^"]*"/, "")
    .replace(/\/\s*$/, "")
    .trim();
  const typeAttribute = type ? ` t="${type}"` : "";
  return ` r="${cellReference}"${typeAttribute}${attrs ? ` ${attrs}` : ""}`;
}

function updateCellXml(sheetXml: string, cellReference: string, content: string, type?: "inlineStr" | "str"): string {
  const parsed = parseCellReference(cellReference);
  const rowPattern = new RegExp(`<row\\b([^>]*)\\br="${parsed.row}"([^>]*)>([\\s\\S]*?)<\\/row>`);
  const rowMatch = rowPattern.exec(sheetXml);
  if (!rowMatch) return sheetXml;

  const rowXml = rowMatch[0];
  const cellPattern = new RegExp(`<c\\b([^>]*)\\br="${cellReference}"([^>]*)>([\\s\\S]*?)<\\/c>|<c\\b([^>]*)\\br="${cellReference}"([^>]*)\\/>`);
  const cellMatch = cellPattern.exec(rowXml);
  const nextCellPattern = /<c\b([^>]*)\br="([A-Z]+)\d+"([^>]*)(?:>[\s\S]*?<\/c>|\/>)/g;

  if (cellMatch) {
    const rawAttrs = `${cellMatch[1] || cellMatch[4] || ""}${cellMatch[2] || cellMatch[5] || ""}`;
    const updatedCell = content
      ? `<c${normalizeCellAttributes(rawAttrs, cellReference, type)}>${content}</c>`
      : `<c${normalizeCellAttributes(rawAttrs, cellReference)}/>`;
    return sheetXml.replace(rowXml, rowXml.replace(cellMatch[0], updatedCell));
  }

  let insertAt = rowXml.lastIndexOf("</row>");
  let nextCell: RegExpExecArray | null;
  while ((nextCell = nextCellPattern.exec(rowXml)) !== null) {
    if (columnIndex(nextCell[2]) > parsed.columnIndex) {
      insertAt = nextCell.index;
      break;
    }
  }

  const newCell = content
    ? `<c r="${cellReference}"${type ? ` t="${type}"` : ""}>${content}</c>`
    : `<c r="${cellReference}"/>`;
  const updatedRow = `${rowXml.slice(0, insertAt)}${newCell}${rowXml.slice(insertAt)}`;
  return sheetXml.replace(rowXml, updatedRow);
}

export function setInlineStringInSheet(sheetXml: string, cellReference: string, value: string): string {
  const text = String(value || "");
  if (!text.trim()) return updateCellXml(sheetXml, cellReference, "");
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
  return updateCellXml(sheetXml, cellReference, `<is><t${preserve}>${escapeXmlText(text)}</t></is>`, "inlineStr");
}

export function setRichHeaderStringInSheet(sheetXml: string, cellReference: string, label: string, value: string): string {
  const safeLabel = `${label}: `;
  const safeValue = String(value || "");
  const valuePreserve = /^\s|\s$/.test(safeValue) ? ' xml:space="preserve"' : "";
  const richText = [
    `<r><t xml:space="preserve">${escapeXmlText(safeLabel)}</t></r>`,
    safeValue
      ? `<r><t${valuePreserve}>${escapeXmlText(safeValue)}</t></r>`
      : "",
  ].join("");
  return updateCellXml(sheetXml, cellReference, `<is>${richText}</is>`, "inlineStr");
}

export function setNumberInSheet(sheetXml: string, cellReference: string, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return updateCellXml(sheetXml, cellReference, "");
  return updateCellXml(sheetXml, cellReference, `<v>${value}</v>`);
}

export function setCellStyleInSheet(sheetXml: string, cellReference: string, styleIndex: number): string {
  const parsed = parseCellReference(cellReference);
  const rowPattern = new RegExp(`<row\\b([^>]*)\\br="${parsed.row}"([^>]*)>([\\s\\S]*?)<\\/row>`);
  const rowMatch = rowPattern.exec(sheetXml);
  if (!rowMatch) return sheetXml;
  const rowXml = rowMatch[0];
  const looseCellPattern = new RegExp(`<c\\b([^>]*)\\br="${cellReference}"([^>]*)(?:>([\\s\\S]*?)<\\/c>|\\/>)`);
  const cellMatch = looseCellPattern.exec(rowXml);
  if (!cellMatch) return sheetXml;
  const cellXml = cellMatch[0];
  const replacement = cellXml.includes(" s=\"")
    ? cellXml.replace(/\s+s="[^"]*"/, ` s="${styleIndex}"`)
    : cellXml.replace(/^<c\b/, `<c s="${styleIndex}"`);
  return sheetXml.replace(rowXml, rowXml.replace(cellXml, replacement));
}

export function setRowHeightInSheet(sheetXml: string, rowIndex: number, height: number): string {
  const rowPattern = new RegExp(`<row\\b([^>]*)\\br="${rowIndex}"([^>]*)>`);
  return sheetXml.replace(rowPattern, (match) => {
    const withoutHeight = match
      .replace(/\s+ht="[^"]*"/, "")
      .replace(/\s+customHeight="[^"]*"/, "");
    return withoutHeight.replace(/>$/, ` ht="${height.toFixed(2).replace(/\.?0+$/, "")}" customHeight="1">`);
  });
}

export function removeMergeRangesInSheet(sheetXml: string, ranges: string[]): string {
  if (!ranges.length || !sheetXml.includes("<mergeCells")) return sheetXml;
  const rangeSet = new Set(ranges);
  return sheetXml.replace(/<mergeCells\b([^>]*)>([\s\S]*?)<\/mergeCells>/, (match, attrs, body) => {
    const kept = (body.match(/<mergeCell\b[^>]*\/>/g) || []).filter((mergeCell) => {
      const ref = /ref="([^"]+)"/.exec(mergeCell)?.[1] || "";
      return !rangeSet.has(ref);
    });
    if (!kept.length) return "";
    const nextAttrs = String(attrs || "").includes("count=")
      ? String(attrs).replace(/count="[^"]*"/, `count="${kept.length}"`)
      : `${attrs || ""} count="${kept.length}"`;
    return `<mergeCells${nextAttrs}>${kept.join("")}</mergeCells>`;
  });
}

export function setXfAlignmentAttributes(stylesXml: string, styleIndices: number[], attributes: Record<string, string>): string {
  const indexSet = new Set(styleIndices);
  const cellXfsMatch = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (!cellXfsMatch) return stylesXml;

  let index = -1;
  const updatedBody = cellXfsMatch[1].replace(/<xf\b[\s\S]*?(?:<\/xf>|\/>)/g, (xf) => {
    index += 1;
    if (!indexSet.has(index)) return xf;

    let nextXf = xf.includes("applyAlignment=")
      ? xf.replace(/applyAlignment="[^"]*"/, 'applyAlignment="1"')
      : xf.replace(/^<xf\b/, '<xf applyAlignment="1"');

    const upsertAttributes = (alignment: string) => {
      let nextAlignment = alignment;
      for (const [name, value] of Object.entries(attributes)) {
        nextAlignment = nextAlignment.includes(`${name}=`)
          ? nextAlignment.replace(new RegExp(`${name}="[^"]*"`), `${name}="${value}"`)
          : nextAlignment.replace(/\/?>$/, ` ${name}="${value}"${nextAlignment.endsWith("/>") ? "/>" : ">"}`);
      }
      return nextAlignment;
    };

    if (/<alignment\b[^>]*\/>/.test(nextXf)) {
      return nextXf.replace(/<alignment\b[^>]*\/>/, upsertAttributes);
    }

    if (/<alignment\b[^>]*>/.test(nextXf)) {
      return nextXf.replace(/<alignment\b[^>]*>/, upsertAttributes);
    }

    const alignmentXml = upsertAttributes("<alignment/>");
    return nextXf.endsWith("/>")
      ? nextXf.replace(/\/>$/, `>${alignmentXml}</xf>`)
      : nextXf.replace(/<\/xf>$/, `${alignmentXml}</xf>`);
  });

  return stylesXml.replace(cellXfsMatch[1], updatedBody);
}

export function setFormulaCachedValue(sheetXml: string, cellReference: string, value: number | string): string {
  const parsed = parseCellReference(cellReference);
  const rowPattern = new RegExp(`<row\\b([^>]*)\\br="${parsed.row}"([^>]*)>([\\s\\S]*?)<\\/row>`);
  const rowMatch = rowPattern.exec(sheetXml);
  if (!rowMatch) return sheetXml;
  const rowXml = rowMatch[0];
  const cellPattern = new RegExp(`<c\\b([^>]*)\\br="${cellReference}"([^>]*)>([\\s\\S]*?)<\\/c>`);
  const cellMatch = cellPattern.exec(rowXml);
  if (!cellMatch) return typeof value === "number"
    ? setNumberInSheet(sheetXml, cellReference, value)
    : setInlineStringInSheet(sheetXml, cellReference, String(value));

  const rawAttrs = `${cellMatch[1]}${cellMatch[2]}`;
  const body = cellMatch[3];
  const formulaMatch = /<f\b[^>]*>[\s\S]*?<\/f>/.exec(body);
  const formula = formulaMatch ? formulaMatch[0] : "";
  const type = typeof value === "number" ? undefined : "str";
  const cachedValue = typeof value === "number" ? String(value) : escapeXmlText(String(value));
  const updatedCell = `<c${normalizeCellAttributes(rawAttrs, cellReference, type)}>${formula}<v>${cachedValue}</v></c>`;
  return sheetXml.replace(rowXml, rowXml.replace(cellMatch[0], updatedCell));
}

export function replaceDrawingTextBox(drawingXml: string, shapeName: string, paragraphs: Array<{ text: string; bold?: boolean; underline?: boolean }>): string {
  const anchorPattern = /<xdr:oneCellAnchor>[\s\S]*?<\/xdr:oneCellAnchor>/g;
  return drawingXml.replace(anchorPattern, (anchor) => {
    if (!anchor.includes(`name="${escapeXmlAttribute(shapeName)}"`)) return anchor;
    const bodyMatch = /<xdr:txBody>([\s\S]*?)<\/xdr:txBody>/.exec(anchor);
    if (!bodyMatch) return anchor;
    const bodyPr = /<a:bodyPr\b[\s\S]*?<\/a:bodyPr>|<a:bodyPr\b[^>]*\/>/.exec(bodyMatch[1])?.[0] || '<a:bodyPr vertOverflow="clip" horzOverflow="clip" wrap="square" rtlCol="0" anchor="t"><a:noAutofit/></a:bodyPr>';
    const lstStyle = /<a:lstStyle\b[\s\S]*?<\/a:lstStyle>|<a:lstStyle\b[^>]*\/>/.exec(bodyMatch[1])?.[0] || "<a:lstStyle/>";
    const paragraphXml = paragraphs.map((paragraph) => {
      const rPr = `<a:rPr lang="en-US" sz="1100"${paragraph.bold ? ' b="1"' : ""}${paragraph.underline ? ' u="sng"' : ""}/>`;
      return `<a:p><a:pPr><a:defRPr/></a:pPr><a:r>${rPr}<a:t>${escapeXmlText(paragraph.text || " ")}</a:t></a:r><a:endParaRPr lang="en-US" sz="1100"${paragraph.bold ? ' b="1"' : ""}/></a:p>`;
    }).join("");
    return anchor.replace(bodyMatch[0], `<xdr:txBody>${bodyPr}${lstStyle}${paragraphXml}</xdr:txBody>`);
  });
}
