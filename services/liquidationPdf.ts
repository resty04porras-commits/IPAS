/** The reference-template PDF renderer used by the existing Linux liquidation export. */
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { parseCurrencyNumber, calculateLiquidationTotals, type LiquidationFormPayload } from "./liquidationRecords.js";
import { formatLiquidationTableDate, normalizeLiquidationTableTime } from "./liquidationWorkbook.js";

function getLiquidationReferencePdfPath(): string {
  return path.join(process.cwd(), "reference_files", "liquidation_form_reference.pdf");
}

export async function generateLiquidationReferencePdfExport(payload: LiquidationFormPayload): Promise<Buffer> {
  const pdf = await PDFDocument.load(await fs.promises.readFile(getLiquidationReferencePdfPath()));
  const page = pdf.getPage(0);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const white = rgb(1, 1, 1);
  const black = rgb(0, 0, 0);

  const clear = (x: number, y: number, width: number, height: number) => {
    page.drawRectangle({ x, y, width, height, color: white, borderWidth: 0 });
  };
  const fitText = (text: string, width: number, size: number, font = regular, minSize = 2.8): { text: string; size: number } => {
    let fitted = String(text || "");
    let fittedSize = size;
    while (fittedSize > minSize && font.widthOfTextAtSize(fitted, fittedSize) > width) {
      fittedSize -= 0.2;
    }
    return { text: fitted, size: fittedSize };
  };
  const writeFitted = (
    text: string,
    x: number,
    y: number,
    width: number,
    size = 6.8,
    font = regular,
    align: "left" | "center" | "right" = "left"
  ) => {
    const fitted = fitText(text, width, size, font);
    const textWidth = font.widthOfTextAtSize(fitted.text, fitted.size);
    const drawX = align === "right"
      ? x + width - textWidth
      : align === "center"
        ? x + Math.max(0, (width - textWidth) / 2)
        : x;
    page.drawText(fitted.text, {
      x: drawX,
      y,
      size: fitted.size,
      font,
      color: black,
    });
  };
  const fitHeaderValue = (text: string, width: number, size = 6.8, minSize = 4.8): { text: string; size: number } => {
    let fitted = String(text || "").replace(/\s+/g, " ").trim();
    let fittedSize = size;

    while (fittedSize > minSize && regular.widthOfTextAtSize(fitted, fittedSize) > width) {
      fittedSize = Math.max(minSize, fittedSize - 0.2);
    }

    if (regular.widthOfTextAtSize(fitted, fittedSize) <= width) {
      return { text: fitted, size: fittedSize };
    }

    const ellipsis = "...";
    const ellipsisWidth = regular.widthOfTextAtSize(ellipsis, fittedSize);
    while (
      fitted.length > 0 &&
      regular.widthOfTextAtSize(fitted, fittedSize) + ellipsisWidth > width
    ) {
      fitted = fitted.slice(0, -1);
    }

    return { text: fitted ? `${fitted}${ellipsis}` : "", size: fittedSize };
  };
  const writePlainValue = (text: string, x: number, y: number, width: number) => {
    clear(x - 1, y - 1.5, width + 2, 8.8);
    const fitted = fitHeaderValue(text, width);
    if (!fitted.text) return;
    page.drawText(fitted.text, { x, y, size: fitted.size, font: regular, color: black });
  };
  const wrapFittedLines = (text: string, width: number, size: number, font = regular): string[] => {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    if (!words.length) return [""];
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (!line || font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines;
  };
  const writeCellFitted = (
    text: string,
    x: number,
    y: number,
    width: number,
    height: number,
    size = 5.6,
    font = regular,
    align: "left" | "center" | "right" = "center",
    maxLines = 2
  ) => {
    const maxWidth = Math.max(1, width - 2);
    let fittedSize = size;
    let lines = wrapFittedLines(text, maxWidth, fittedSize, font);
    while (
      fittedSize > 2.8 &&
      (lines.length > maxLines || lines.some(line => font.widthOfTextAtSize(line, fittedSize) > maxWidth))
    ) {
      fittedSize -= 0.2;
      lines = wrapFittedLines(text, maxWidth, fittedSize, font);
    }
    const lineHeight = Math.min(fittedSize + 0.7, Math.max(fittedSize, (height - 1) / Math.max(1, lines.length)));
    const textHeight = lines.length * lineHeight;
    const firstBaseline = y + Math.max(0.5, (height - textHeight) / 2) + textHeight - fittedSize;
    lines.forEach((line, index) => {
      const textWidth = font.widthOfTextAtSize(line, fittedSize);
      const drawX = align === "right"
        ? x + width - textWidth - 1
        : align === "left"
          ? x + 1
          : x + Math.max(0, (width - textWidth) / 2);
      page.drawText(line, {
        x: drawX,
        y: firstBaseline - index * lineHeight,
        size: fittedSize,
        font,
        color: black,
      });
    });
  };
  function writeBodyCellFitted(
    text: string,
    x: number,
    y: number,
    width: number,
    height: number,
    options: {
      size?: number;
      minSize?: number;
      align?: "left" | "center" | "right";
      maxLines?: number;
    } = {}
  ) {
    const paddingX = 2;
    const paddingY = 0.8;
    const maxWidth = Math.max(1, width - paddingX * 2);

    const align = options.align || "center";
    const maxLines = options.maxLines || 1;

    let fittedSize = options.size || 4.8;
    const minSize = options.minSize || 3.0;

    const safeText = String(text || "")
      .replace(/\s+/g, " ")
      .trim();

    if (!safeText) {
      return;
    }

    let lines = wrapFittedLines(safeText, maxWidth, fittedSize, regular);

    while (
      fittedSize > minSize &&
      (
        lines.length > maxLines ||
        lines.some((line) => regular.widthOfTextAtSize(line, fittedSize) > maxWidth)
      )
    ) {
      fittedSize = Math.max(minSize, fittedSize - 0.2);
      lines = wrapFittedLines(safeText, maxWidth, fittedSize, regular);
    }

    let visibleLines = lines.slice(0, maxLines);

    // If one-line text is still too long, trim with ellipsis.
    if (
      visibleLines.length === 1 &&
      regular.widthOfTextAtSize(visibleLines[0], fittedSize) > maxWidth
    ) {
      let trimmed = visibleLines[0];
      const ellipsis = "...";

      while (
        trimmed.length > 0 &&
        regular.widthOfTextAtSize(`${trimmed}${ellipsis}`, fittedSize) > maxWidth
      ) {
        trimmed = trimmed.slice(0, -1);
      }

      visibleLines = [trimmed ? `${trimmed}${ellipsis}` : ""];
    }

    if (!visibleLines.length || !visibleLines[0]) {
      return;
    }

    const fontHeight = regular.heightAtSize(fittedSize);
    const ascenderHeight = regular.heightAtSize(fittedSize, { descender: false });
    const descenderHeight = Math.max(0, fontHeight - ascenderHeight);
    const lineHeight = Math.min(
      fittedSize + 0.5,
      Math.max(fontHeight, (height - paddingY * 2) / Math.max(1, visibleLines.length))
    );
    const textBlockHeight =
      fontHeight + Math.max(0, visibleLines.length - 1) * lineHeight;

    const firstBaseline =
      y +
      (height + textBlockHeight) / 2 -
      ascenderHeight;

    visibleLines.forEach((line, index) => {
      const textWidth = regular.widthOfTextAtSize(line, fittedSize);

      const rawX =
        align === "right"
          ? x + width - paddingX - textWidth
          : align === "left"
            ? x + paddingX
            : x + ((width - textWidth) / 2);

      // Safety clamp: keep text inside the cell horizontally.
      const safeX = Math.max(
        x + paddingX,
        Math.min(rawX, x + width - paddingX - textWidth)
      );

      const minimumBaselineY = y + paddingY + descenderHeight;
      const maximumBaselineY = y + height - paddingY - ascenderHeight;
      const rawY = firstBaseline - index * lineHeight;
      const safeY = Math.max(
        minimumBaselineY,
        Math.min(rawY, maximumBaselineY)
      );

      page.drawText(line, {
        x: safeX,
        y: safeY,
        size: fittedSize,
        font: regular,
        color: black,
      });
    });
  }
  const writeWrappedFitted = (text: string, x: number, y: number, width: number, size = 6.8, font = regular, maxLines = 2) => {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
      if (lines.length >= maxLines) break;
    }
    if (line && lines.length < maxLines) lines.push(line);
    lines.slice(0, maxLines).forEach((lineText, index) => {
      writeFitted(lineText, x, y - index * (size + 1.5), width, size, font);
    });
  };
  const money = (value: number) =>
    value === 0 ? "-" : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  writePlainValue(payload.employeeName, 70.8, 686.6, 240);
  writePlainValue(payload.reportDate, 343.7, 686.6, 185);
  writePlainValue(payload.designation, 87.4, 677.4, 220);
  writePlainValue(payload.base, 343.7, 677.4, 185);
  writePlainValue(payload.purpose, 77, 668.8, 405);

  const TABLE_FIRST_ROW = 13;
  const TABLE_TOTAL_ROW = 56;
  const TABLE_LAST_DATA_ROW = TABLE_TOTAL_ROW - 1;
  const MAX_VISIBLE_ITEMS = TABLE_LAST_DATA_ROW - TABLE_FIRST_ROW + 1;

  const visibleItems = payload.items.slice(0, MAX_VISIBLE_ITEMS);

  // Body table row positioning.
  // firstRowTopY is the top border of the first data row in the reference PDF grid.
  // writeBodyCellFitted needs the bottom-left Y of each cell, not the text baseline.
  const rowHeight = 8.2;
  const firstRowTopY = 638.8;
  const totalsRowHeight = 8.4;
  const totalsRowBottomY = 238.4;

  const columns = [
    { key: "transactionDate", x: 49.6, width: 33.025, numeric: false },
    { key: "time", x: 82.625, width: 61.825, numeric: false },
    { key: "from", x: 144.45, width: 53.6, numeric: false },
    { key: "to", x: 198.05, width: 55.63, numeric: false },
    { key: "modeOfTransportation", x: 257, width: 37, numeric: false },
    { key: "amount", x: 294, width: 32, numeric: true },
    { key: "perDiem", x: 328, width: 32, numeric: true },
    { key: "breakfast", x: 370, width: 28, numeric: true },
    { key: "lunch", x: 407, width: 28, numeric: true },
    { key: "dinner", x: 447, width: 28, numeric: true },
    { key: "remarks", x: 489, width: 67, numeric: false },
  ] as const;

  visibleItems.forEach((item, index) => {
    const cellBottomY = firstRowTopY - ((index + 1) * rowHeight);

    columns.forEach((column) => {
      const raw = (item as any)[column.key];

      const text = column.numeric
        ? (parseCurrencyNumber(raw)
            ? parseCurrencyNumber(raw).toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })
            : "")
        : column.key === "transactionDate"
          ? formatLiquidationTableDate(String(raw || ""))
          : column.key === "time"
            ? normalizeLiquidationTableTime(String(raw || ""))
            : String(raw || "");

      if (!text) {
        return;
      }

      const options = column.key === "remarks"
        ? {
            align: "center" as const,
            maxLines: 1,
            size: 4.6,
            minSize: 3.0,
          }
        : {
            align: "center" as const,
            maxLines: 1,
            size: 4.8,
            minSize: 3.2,
          };

      writeBodyCellFitted(
        text,
        column.x,
        cellBottomY,
        column.width,
        rowHeight,
        options
      );
    });
  });

  const totals = calculateLiquidationTotals(payload.items, payload.cashAdvance);
  const totalExpenses = totals.totalExpenses;
  const cashAdvance = totals.cashAdvance;
  const settlement = totals.settlement;

  const writeTotalsCellFitted = (
  value: number,
  x: number,
  y: number,
  width: number,
  height: number
) => {
  const paddingX = 2;
  const paddingY = 1;

  const text = value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const maxWidth = Math.max(1, width - paddingX * 2);
  const maxHeight = Math.max(1, height - paddingY * 2);

  let size = 5.2;
  const minSize = 3.2;

  while (
    size > minSize &&
    (
      regular.widthOfTextAtSize(text, size) > maxWidth ||
      regular.heightAtSize(size) > maxHeight
    )
  ) {
    size = Math.max(minSize, size - 0.2);
  }

  const textWidth = regular.widthOfTextAtSize(text, size);
  const textHeight = regular.heightAtSize(size);
  const ascenderHeight = regular.heightAtSize(size, {
    descender: false,
  });
  const descenderHeight = Math.max(0, textHeight - ascenderHeight);

  const centeredX = x + (width - textWidth) / 2;
  const centeredY =
    y + (height - textHeight) / 2 + descenderHeight;

  const safeX = Math.max(
    x + paddingX,
    Math.min(centeredX, x + width - paddingX - textWidth)
  );

  const minimumBaselineY = y + paddingY + descenderHeight;
  const maximumBaselineY =
    y + height - paddingY - ascenderHeight;

  const safeY = Math.max(
    minimumBaselineY,
    Math.min(centeredY, maximumBaselineY)
  );

  page.drawText(text, {
    x: safeX,
    y: safeY,
    size,
    font: regular,
    color: black,
  });
};

  // The reference PDF contains stale 0.00 values directly above the generated
  // totals row. Mask only the original glyph boxes so the table grid remains
  // untouched.
  [
    303.3,
    336.9,
    372.33,
    409.52,
    450.35,
  ].forEach((x) => {
    clear(x - 0.8, 247.7, 12.8, 6.8);
  });
  page.drawLine({
    start: { x: 49.6, y: 254.47 },
    end: { x: 555.4, y: 254.47 },
    thickness: 0.6,
    color: black,
  });
  page.drawLine({
    start: { x: 49.6, y: 237.85 },
    end: { x: 556.6, y: 237.85 },
    thickness: 1.2,
    color: black,
  });

  const totalsColumns = [
    {
      value: totals.amount,
      x: 294,
      width: 32,
    },
    {
      value: totals.perDiem,
      x: 328,
      width: 32,
    },
    {
      value: totals.breakfast,
      x: 370,
      width: 28,
    },
    {
      value: totals.lunch,
      x: 407,
      width: 28,
    },
    {
      value: totals.dinner,
      x: 447,
      width: 28,
    },
  ];

  totalsColumns.forEach(({ value, x, width }) => {
    writeTotalsCellFitted(
      value,
      x,
      totalsRowBottomY,
      width,
      totalsRowHeight
    );
  });

  const totalsBox = { x: 432, y: 211, labelW: 70, phpW: 23, amountW: 32, rowH: 9 };
  [
    ["Total Expenses", money(totalExpenses), 229],
    ["Total CA", money(cashAdvance), 220],
    [settlement >= 0 ? "Return to CO" : "Reimbursement", money(Math.abs(settlement)), 211],
  ].forEach(([label, amount, bottomY]) => {
    const y = Number(bottomY);
    page.drawRectangle({ x: totalsBox.x, y, width: totalsBox.labelW, height: totalsBox.rowH, color: white, borderColor: black, borderWidth: 0.35 });
    page.drawRectangle({ x: totalsBox.x + totalsBox.labelW, y, width: totalsBox.phpW, height: totalsBox.rowH, color: white, borderColor: black, borderWidth: 0.35 });
    page.drawRectangle({ x: totalsBox.x + totalsBox.labelW + totalsBox.phpW, y, width: totalsBox.amountW, height: totalsBox.rowH, color: white, borderColor: black, borderWidth: 0.35 });
    writeCellFitted(String(label), totalsBox.x, y, totalsBox.labelW, totalsBox.rowH, 5, bold, "right", 1);
    writeCellFitted("PHP", totalsBox.x + totalsBox.labelW, y, totalsBox.phpW, totalsBox.rowH, 4.8, bold, "center", 1);
    writeCellFitted(String(amount), totalsBox.x + totalsBox.labelW + totalsBox.phpW, y, totalsBox.amountW, totalsBox.rowH, 5.8, regular, "right", 1);
  });
  page.drawRectangle({
    x: totalsBox.x,
    y: totalsBox.y,
    width: totalsBox.labelW + totalsBox.phpW + totalsBox.amountW,
    height: totalsBox.rowH * 3,
    borderColor: black,
    borderWidth: 1.0,
  });

  clear(62, 160, 82, 20);
  writeFitted(payload.preparedByName, 68, 171, 70, 6.8, bold);
  writeWrappedFitted(payload.preparedByTitle, 68, 162.3, 80, 6.6, regular, 2);
  clear(166, 160, 88, 20);
  writeFitted(payload.checkedByName, 172, 171, 70, 6.8, bold);
  writeWrappedFitted(payload.checkedByTitle, 172, 162.4, 86, 6.6, regular, 2);
  clear(282, 151, 92, 29);
  writeFitted(payload.reviewedByName, 285, 171.5, 86, 6.8, bold);
  writeWrappedFitted(payload.reviewedByTitle, 296, 162.3, 78, 6.6, regular, 2);
  clear(388, 160, 74, 20);
  writeFitted(payload.notedByName, 389, 171.2, 72, 6.8, bold);
  writeWrappedFitted(payload.notedByTitle, 389, 162.9, 72, 6.6, regular, 2);
  clear(481, 160, 78, 20);
  writeFitted(payload.approvedByName, 482, 171.2, 76, 6.8, bold);
  writeWrappedFitted(payload.approvedByTitle, 486, 162.9, 72, 6.6, regular, 2);

  return Buffer.from(await pdf.save());
}
