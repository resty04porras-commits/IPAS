/** Liquidation workbook rendering and the date/time formatting shared with its PDF caller. */
import fs from "node:fs";
import path from "node:path";
import { readZipEntries, writeZipEntries, updateZipEntry } from "./zipArchive.js";
import {
  setInlineStringInSheet, setRichHeaderStringInSheet, setNumberInSheet,
  setCellStyleInSheet, setRowHeightInSheet, removeMergeRangesInSheet,
  setXfAlignmentAttributes, setFormulaCachedValue, replaceDrawingTextBox,
} from "./officeXml.js";
import { parseCurrencyNumber, calculateLiquidationTotals, type LiquidationFormPayload } from "./liquidationRecords.js";

export function getLiquidationReferenceExcelPath(): string {
  return path.join(process.cwd(), "reference_files", "liquidation_form_reference.xlsx");
}

function applyLiquidationTableBodyStyles(sheetXml: string): string {
  let xml = sheetXml;
  const TABLE_FIRST_ROW = 13;
  const TABLE_TOTAL_ROW = 56;
  const TABLE_LAST_DATA_ROW = TABLE_TOTAL_ROW - 1;
  const tableColumns = [
    ["A", 89],
    ["B", 91],
    ["C", 91],
    ["D", 91],
    ["E", 91],
    ["F", 156],
    ["G", 92],
    ["H", 93],
    ["I", 93],
    ["J", 93],
    ["K", 93],
    ["L", 95],
  ] as const;

  for (let row = TABLE_FIRST_ROW; row <= TABLE_LAST_DATA_ROW; row += 1) {
    for (const [column, styleIndex] of tableColumns) {
      xml = setCellStyleInSheet(xml, `${column}${row}`, styleIndex);
    }
    xml = setRowHeightInSheet(xml, row, 13);
  }

  return xml;
}

function populateLiquidationStylesXml(stylesXml: string): string {
  let xml = stylesXml;

  // Main liquidation table body/header styles.
  // Force centered text and keep values inside borders for Excel-to-PDF export.
  xml = setXfAlignmentAttributes(xml, [89, 90, 91, 92, 93, 95, 111, 112, 113, 114, 116, 150, 156], {
    horizontal: "center",
    vertical: "center",
    shrinkToFit: "1",
    wrapText: "0",
  });

  // Totals label cells must remain right-aligned.
  xml = setXfAlignmentAttributes(xml, [159, 127, 130], {
    horizontal: "right",
    vertical: "center",
    shrinkToFit: "1",
    wrapText: "0",
  });

  // PHP label cells.
  xml = setXfAlignmentAttributes(xml, [160, 128, 131], {
    horizontal: "center",
    vertical: "center",
    shrinkToFit: "1",
    wrapText: "0",
  });

  // Totals amount cells.
  xml = setXfAlignmentAttributes(xml, [126, 129, 132], {
    horizontal: "right",
    vertical: "center",
    shrinkToFit: "1",
    wrapText: "0",
  });

  xml = xml
    .replace(
      '<border><left style="medium"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="medium"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>',
      '<border><left style="medium"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>'
    )
    .replace(
      '<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="medium"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>',
      '<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>'
    )
    .replace(
      '<border><left style="thin"><color auto="1"/></left><right style="medium"><color auto="1"/></right><top style="medium"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>',
      '<border><left style="thin"><color auto="1"/></left><right style="medium"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>'
    );

  return xml;
}

export function formatLiquidationTableDate(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  let date: Date | null = null;
  if (iso) {
    date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  } else {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      date = new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
    }
  }
  if (!date || Number.isNaN(date.getTime())) return raw;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = String(date.getUTCDate()).padStart(2, "0");
  const year = String(date.getUTCFullYear()).slice(-2);
  return `${day}-${months[date.getUTCMonth()]}-${year}`;
}

export function normalizeLiquidationTableTime(value: string): string {
  return String(value || "")
    .replace(/\s+to\s+/gi, " - ")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}

function populateLiquidationSheetXml(sheetXml: string, payload: LiquidationFormPayload): string {
  let xml = sheetXml;
  xml = setRichHeaderStringInSheet(xml, "A7", "Name", payload.employeeName);
  xml = setRichHeaderStringInSheet(xml, "G7", "Date", payload.reportDate);
  xml = setRichHeaderStringInSheet(xml, "A8", "Designation", payload.designation);
  xml = setRichHeaderStringInSheet(xml, "G8", "Base", payload.base);
  xml = setRichHeaderStringInSheet(xml, "A9", "Purpose", payload.purpose);

  for (let row = 13; row <= 56; row += 1) {
    for (const column of ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"]) {
      xml = setInlineStringInSheet(xml, `${column}${row}`, "");
    }
  }

  const TABLE_FIRST_ROW = 13;
  const TABLE_TOTAL_ROW = 56;
  const TABLE_LAST_DATA_ROW = TABLE_TOTAL_ROW - 1;
  const MAX_VISIBLE_ITEMS = TABLE_LAST_DATA_ROW - TABLE_FIRST_ROW + 1;

  xml = applyLiquidationTableBodyStyles(xml);

  const visibleItems = payload.items.slice(0, MAX_VISIBLE_ITEMS);
  visibleItems.forEach((item, index) => {
    const row = TABLE_FIRST_ROW + index;
    const displayDate = formatLiquidationTableDate(item.transactionDate);
    const displayTime = normalizeLiquidationTableTime(item.time);

    xml = setInlineStringInSheet(xml, `A${row}`, displayDate);
    xml = setInlineStringInSheet(xml, `B${row}`, displayTime);
    xml = setInlineStringInSheet(xml, `C${row}`, item.from);
    xml = setInlineStringInSheet(xml, `D${row}`, item.to);
    xml = setInlineStringInSheet(xml, `E${row}`, item.modeOfTransportation);
    xml = setNumberInSheet(xml, `F${row}`, parseCurrencyNumber(item.amount));
    xml = setNumberInSheet(xml, `G${row}`, parseCurrencyNumber(item.perDiem));
    xml = setNumberInSheet(xml, `H${row}`, parseCurrencyNumber(item.breakfast));
    xml = setNumberInSheet(xml, `I${row}`, parseCurrencyNumber(item.lunch));
    xml = setNumberInSheet(xml, `J${row}`, parseCurrencyNumber(item.dinner));
    xml = setInlineStringInSheet(xml, `K${row}`, item.others || "");
    xml = setInlineStringInSheet(xml, `L${row}`, item.remarks);

  });
  xml = applyLiquidationTableBodyStyles(xml);

  const totals = calculateLiquidationTotals(payload.items, payload.cashAdvance);
  const totalExpenses = totals.totalExpenses;
  const cashAdvance = totals.cashAdvance;
  const settlement = totals.settlement;

  xml = setFormulaCachedValue(xml, "F57", totals.amount);
  xml = setFormulaCachedValue(xml, "G57", totals.perDiem);
  xml = setFormulaCachedValue(xml, "H57", totals.breakfast);
  xml = setFormulaCachedValue(xml, "I57", totals.lunch);
  xml = setFormulaCachedValue(xml, "J57", totals.dinner);
  xml = setInlineStringInSheet(xml, "J59", "Total Expenses");
  xml = setInlineStringInSheet(xml, "K59", "PHP");
  xml = setFormulaCachedValue(xml, "L59", totalExpenses);
  xml = setInlineStringInSheet(xml, "J60", "Total CA");
  xml = setInlineStringInSheet(xml, "K60", "PHP");
  xml = setNumberInSheet(xml, "L60", cashAdvance);
  xml = setInlineStringInSheet(xml, "J61", settlement >= 0 ? "Return to CO" : "Reimbursement");
  xml = setInlineStringInSheet(xml, "K61", "PHP");
  xml = setFormulaCachedValue(xml, "L61", Math.abs(settlement));
  xml = setCellStyleInSheet(xml, "J59", 159);
  xml = setCellStyleInSheet(xml, "K59", 160);
  xml = setCellStyleInSheet(xml, "L59", 126);
  xml = setCellStyleInSheet(xml, "J60", 127);
  xml = setCellStyleInSheet(xml, "K60", 128);
  xml = setCellStyleInSheet(xml, "L60", 129);
  xml = setCellStyleInSheet(xml, "J61", 130);
  xml = setCellStyleInSheet(xml, "K61", 131);
  xml = setCellStyleInSheet(xml, "L61", 132);
  xml = removeMergeRangesInSheet(xml, ["J59:K59", "J60:K60", "J61:K61"]);

  return xml;
}

function populateLiquidationDrawingXml(drawingXml: string, payload: LiquidationFormPayload): string {
  let xml = drawingXml;
  xml = replaceDrawingTextBox(xml, "TextBox 14", [
    { text: "Prepared  By:", bold: true },
    { text: "" },
    { text: "    _____________________" },
    { text: `    ${payload.preparedByTitle || ""}` },
  ]);
  xml = replaceDrawingTextBox(xml, "TextBox 4", [{ text: payload.preparedByName || "", bold: true }]);
  xml = replaceDrawingTextBox(xml, "TextBox 6", [
    { text: "Checked  By:", bold: true },
    { text: "" },
    { text: "    _____________________" },
    { text: `    ${payload.checkedByTitle || ""}` },
  ]);
  xml = replaceDrawingTextBox(xml, "TextBox 7", [{ text: payload.checkedByName || "", bold: true }]);
  xml = replaceDrawingTextBox(xml, "TextBox 1", [
    { text: "Checked  By:", bold: true },
    { text: "" },
    { text: "    _____________________" },
    { text: `    ${payload.reviewedByTitle || ""}` },
  ]);
  xml = replaceDrawingTextBox(xml, "TextBox 8", [{ text: payload.reviewedByName || "", bold: true }]);
  xml = replaceDrawingTextBox(xml, "TextBox 13", [
    { text: "Noted  By:", bold: true },
    { text: "" },
    { text: `     ${payload.notedByName || ""}`, bold: true, underline: true },
    { text: `     ${payload.notedByTitle || ""}` },
  ]);
  xml = replaceDrawingTextBox(xml, "TextBox 16", [
    { text: "Approved  By:", bold: true },
    { text: "" },
    { text: payload.approvedByName || "", bold: true, underline: true },
    { text: `   ${payload.approvedByTitle || ""}` },
  ]);
  return xml;
}

function generateLiquidationReferenceWorkbook(payload: LiquidationFormPayload): Buffer {
  const templatePath = getLiquidationReferenceExcelPath();
  const entries = readZipEntries(fs.readFileSync(templatePath));
  const updatedEntries = updateZipEntry(
    updateZipEntry(
      updateZipEntry(
        updateZipEntry(entries, "xl/worksheets/sheet4.xml", (data) =>
          Buffer.from(populateLiquidationSheetXml(data.toString("utf8"), payload), "utf8")
        ),
        "xl/styles.xml",
        (data) => Buffer.from(populateLiquidationStylesXml(data.toString("utf8")), "utf8")
      ),
      "xl/drawings/drawing4.xml",
      (data) => Buffer.from(populateLiquidationDrawingXml(data.toString("utf8"), payload), "utf8")
    ),
    "xl/calcChain.xml",
    () => null
  );
  return writeZipEntries(updatedEntries);
}

export function generateLiquidationExcelExport(payload: LiquidationFormPayload): Buffer {
  return generateLiquidationReferenceWorkbook(payload);
}
