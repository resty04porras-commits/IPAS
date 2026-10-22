import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { extractZipEntryBuffer } from "./zipArchive.js";
import type { AccountabilityFormPayload } from "../types/accountability.js";

export function wrapPdfText(text: string, font: any, size: number, maxWidth: number): string[] {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export function drawPdfText(page: any, text: string, x: number, y: number, options: {
  font: any;
  size: number;
  maxWidth?: number;
  color?: any;
  lineHeight?: number;
}) {
  const lines = options.maxWidth
    ? wrapPdfText(text, options.font, options.size, options.maxWidth)
    : [String(text || "")];
  const lineHeight = options.lineHeight || options.size + 3;

  lines.forEach((line, index) => {
    page.drawText(line, {
      x,
      y: y - index * lineHeight,
      size: options.size,
      font: options.font,
      color: options.color || rgb(0.12, 0.16, 0.23),
    });
  });

  return y - Math.max(0, lines.length - 1) * lineHeight;
}

export async function generateSmartCapturePdfExport(payload: AccountabilityFormPayload): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const sourcePageWidth = 842;
  const sourcePageHeight = 595;
  const portraitPageWidth = 595;
  const portraitPageHeight = 842;
  const page = pdf.addPage([portraitPageWidth, portraitPageHeight]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const dark = rgb(0.10, 0.14, 0.20);
  const muted = rgb(0.38, 0.45, 0.55);
  const border = rgb(0.68, 0.73, 0.80);
  const light = rgb(0.97, 0.98, 0.99);

  page.drawText("Smart Capture Workflow", { x: 32, y: 560, size: 13, font: bold, color: dark });

  const leftX = 32;
  const leftY = 526;
  const leftW = 456;
  const tableTop = leftY - 42;
  const rightX = 510;
  const rightY = 526;
  const rightW = 300;

  page.drawRectangle({ x: leftX, y: tableTop - 230, width: leftW, height: 272, borderColor: border, borderWidth: 1, color: rgb(1, 1, 1) });
  page.drawText("Equipment Details", { x: leftX + 12, y: leftY - 20, size: 10, font: bold, color: dark });

  const columns = [
    { label: "Components", key: "components", width: 88 },
    { label: "Description", key: "description", width: 112 },
    { label: "Hardware ID", key: "hardwareId", width: 86 },
    { label: "Serial", key: "serial", width: 82 },
    { label: "Remarks", key: "remarks", width: 88 },
  ];
  let x = leftX;
  page.drawRectangle({ x: leftX, y: tableTop, width: leftW, height: 18, color: light, borderColor: border, borderWidth: 1 });
  columns.forEach((column) => {
    page.drawRectangle({ x, y: tableTop, width: column.width, height: 18, borderColor: border, borderWidth: 0.7 });
    page.drawText(column.label, { x: x + 4, y: tableTop + 5, size: 7, font: bold, color: dark });
    x += column.width;
  });

  let rowY = tableTop - 20;
  payload.items.slice(0, 12).forEach((item) => {
    x = leftX;
    columns.forEach((column) => {
      page.drawRectangle({ x, y: rowY, width: column.width, height: 20, borderColor: border, borderWidth: 0.7 });
      drawPdfText(page, String((item as any)[column.key] || ""), x + 4, rowY + 12, {
        font: regular,
        size: 6.5,
        maxWidth: column.width - 8,
        lineHeight: 7,
      });
      x += column.width;
    });
    rowY -= 20;
  });

  page.drawRectangle({ x: rightX, y: rightY - 380, width: rightW, height: 390, borderColor: border, borderWidth: 1, color: rgb(1, 1, 1) });
  page.drawText("Form Details", { x: rightX + 12, y: rightY - 14, size: 10, font: bold, color: dark });
  page.drawText("Confirm the hierarchy and exported form information.", { x: rightX + 12, y: rightY - 28, size: 6.5, font: regular, color: muted });

  const detailRows = [
    ["Name", payload.employeeName, "ID No.", payload.employeeId],
    ["Designation", payload.designation, "Department", payload.department],
    ["Effective Date", payload.effectiveDate, "Processed By", payload.processedBy],
    ["Processed Date", payload.processedDate, "Checked By", payload.checkedBy],
    ["Checked Date", payload.checkedDate, "Verified By", payload.verifiedBy],
    ["Verified Title", payload.verifiedTitle, "Verified Date", payload.verifiedDate],
    ["Noted By", payload.notedBy, "Noted Title", payload.notedTitle],
    ["Noted Date", payload.notedDate, "", ""],
  ];

  let detailY = rightY - 56;
  detailRows.forEach(([labelA, valueA, labelB, valueB]) => {
    page.drawText(labelA, { x: rightX + 12, y: detailY + 14, size: 5.5, font: bold, color: muted });
    page.drawRectangle({ x: rightX + 12, y: detailY - 4, width: 132, height: 15, borderColor: border, borderWidth: 0.5, color: light });
    drawPdfText(page, valueA, rightX + 16, detailY + 1, { font: regular, size: 6.5, maxWidth: 124 });
    if (labelB) {
      page.drawText(labelB, { x: rightX + 156, y: detailY + 14, size: 5.5, font: bold, color: muted });
      page.drawRectangle({ x: rightX + 156, y: detailY - 4, width: 132, height: 15, borderColor: border, borderWidth: 0.5, color: light });
      drawPdfText(page, valueB, rightX + 160, detailY + 1, { font: regular, size: 6.5, maxWidth: 124 });
    }
    detailY -= 36;
  });

  page.drawText("Processed Signature", { x: rightX + 12, y: detailY + 18, size: 5.5, font: bold, color: muted });
  page.drawRectangle({ x: rightX + 12, y: detailY - 24, width: rightW - 24, height: 36, borderColor: border, borderWidth: 0.5, color: light });

  const signatureDataUrl = payload.signatureDataUrl || "";
  const signatureMatch = signatureDataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i);
  if (signatureMatch) {
    try {
      const signatureBytes = Buffer.from(signatureMatch[2], "base64");
      const signatureImage = signatureMatch[1].toLowerCase() === "png"
        ? await pdf.embedPng(signatureBytes)
        : await pdf.embedJpg(signatureBytes);
      const scale = Math.min(130 / signatureImage.width, 28 / signatureImage.height);
      page.drawImage(signatureImage, {
        x: rightX + 88,
        y: detailY - 20,
        width: signatureImage.width * scale,
        height: signatureImage.height * scale,
      });
    } catch {
      page.drawText(payload.signature || payload.processedBy || "", { x: rightX + 18, y: detailY - 6, size: 7, font: regular, color: dark });
    }
  } else {
    page.drawText(payload.signature || payload.processedBy || "", { x: rightX + 18, y: detailY - 6, size: 7, font: regular, color: dark });
  }

  const portraitScale = Math.min(
    portraitPageWidth / sourcePageWidth,
    portraitPageHeight / sourcePageHeight
  );
  page.scaleContent(portraitScale, portraitScale);
  page.translateContent(
    (portraitPageWidth - sourcePageWidth * portraitScale) / 2,
    (portraitPageHeight - sourcePageHeight * portraitScale) / 2
  );

  return Buffer.from(await pdf.save());
}

export async function generateOfficialSmartCapturePdfExport(payload: AccountabilityFormPayload): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const pageWidth = 612;
  const pageHeight = 792;
  const page = pdf.addPage([pageWidth, pageHeight]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const orange = rgb(0.95, 0.36, 0.10);
  const red = rgb(0.90, 0.08, 0.08);
  const blue = rgb(0.12, 0.31, 0.74);

  const line = (x1: number, y1: number, x2: number, y2: number, width = 0.55) => {
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: width, color: black });
  };
  const centerText = (text: string, y: number, size: number, font: any, color = black) => {
    page.drawText(text, { x: (pageWidth - font.widthOfTextAtSize(text, size)) / 2, y, size, font, color });
  };
  const centerSmall = (text: string, x: number, y: number, width: number) => {
    page.drawText(text, { x: x + (width - regular.widthOfTextAtSize(text, 4.8)) / 2, y, size: 4.8, font: regular, color: black });
  };
  const safeDate = (value: string) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime())
      ? raw
      : parsed.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  };
  const field = (label: string, value: string, x: number, y: number, lineEnd: number, labelWidth = 45) => {
    page.drawText(label, { x, y: y + 3, size: 5.7, font: bold, color: black });
    page.drawText(":", { x: x + labelWidth, y: y + 3, size: 5.7, font: bold, color: black });
    line(x + labelWidth + 7, y + 2, lineEnd, y + 2, 0.55);
    drawPdfText(page, value || "", x + labelWidth + 10, y + 4, {
      font: regular,
      size: 6,
      maxWidth: Math.max(20, lineEnd - (x + labelWidth + 12)),
      lineHeight: 6.5,
    });
  };
  const loadHeaderImage = async () => {
    try {
      const templatePath = path.join(process.cwd(), "public", "forms", "accountability-form-template.xlsx");
      const templateBytes = await fs.promises.readFile(templatePath);
      const embeddedLogoBytes = extractZipEntryBuffer(templateBytes, "xl/media/image1.png");
      if (embeddedLogoBytes?.length) {
        return await pdf.embedPng(embeddedLogoBytes);
      }

      const workbook = XLSX.read(templateBytes, { type: "buffer", bookFiles: true } as any) as any;
      const files = workbook.files || {};
      const logoFile = files["xl/media/image1.png"] || Object.entries(files).find(([name]) => name.endsWith("/media/image1.png"))?.[1] as any;
      const content = logoFile?.content;
      let logoBytes: Buffer | null = null;
      if (Buffer.isBuffer(content)) {
        logoBytes = content;
      } else if (content instanceof Uint8Array) {
        logoBytes = Buffer.from(content);
      } else if (content instanceof ArrayBuffer) {
        logoBytes = Buffer.from(new Uint8Array(content));
      } else if (content?.buffer instanceof ArrayBuffer) {
        logoBytes = Buffer.from(content.buffer, content.byteOffset || 0, content.byteLength || content.buffer.byteLength);
      } else if (Array.isArray(content)) {
        logoBytes = Buffer.from(content);
      } else if (typeof content === "string") {
        logoBytes = Buffer.from(content, "binary");
      }
      return logoBytes?.length ? await pdf.embedPng(logoBytes) : null;
    } catch {
      return null;
    }
  };
  const loadSignature = async (maxWidth: number, maxHeight: number) => {
    const signatureMatch = (payload.signatureDataUrl || "").match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i);
    if (!signatureMatch) return null;
    try {
      const bytes = Buffer.from(signatureMatch[2], "base64");
      const image = signatureMatch[1].toLowerCase() === "png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
      return { image, width: image.width * scale, height: image.height * scale };
    } catch {
      return null;
    }
  };

  const headerImage = await loadHeaderImage();
  const signature = await loadSignature(78, 18);

  if (headerImage) {
    const headerWidth = 238;
    const headerHeight = headerWidth * (headerImage.height / headerImage.width);
    page.drawImage(headerImage, {
      x: (pageWidth - headerWidth) / 2,
      y: 708,
      width: headerWidth,
      height: headerHeight,
    });
  } else {
    page.drawRectangle({ x: 263, y: 719, width: 7, height: 21, color: orange });
    page.drawCircle({ x: 278, y: 730, size: 5.8, color: rgb(0.97, 0.62, 0.18) });
    page.drawRectangle({ x: 272, y: 711, width: 11, height: 18, color: blue });
    page.drawText("LifeBank", { x: 291, y: 727, size: 11.5, font: bold, color: red });
    page.drawText("FOUNDATION", { x: 292, y: 720, size: 5.3, font: bold, color: red });
    centerText("INFRASTRUCTURE AND INFORMATION AND COMMUNICATIONS TECHNOLOGY", 704, 5.2, bold, orange);
  }
  centerText("EQUIPMENT ACCOUNTABILITY FORM", 674, 8, bold);
  line(229, 672, 383, 672, 0.5);

  field("Name", payload.employeeName, 46, 642, 210, 38);
  field("ID No.", payload.employeeId, 229, 642, 392, 50);
  field("Signature", "", 413, 642, 566, 54);
  field("Designation", payload.designation, 46, 625, 210, 38);
  field("Department", payload.department, 229, 625, 392, 50);
  field("Effective Date", safeDate(payload.effectiveDate), 413, 625, 566, 54);

  const tableX = 46;
  const tableTop = 613;
  const rowHeight = 13.8;
  const columns = [
    { label: "Components", key: "components", width: 92 },
    { label: "Description", key: "description", width: 126 },
    { label: "Hardware ID", key: "hardwareId", width: 111 },
    { label: "Serial", key: "serial", width: 99 },
    { label: "Remarks", key: "remarks", width: 92 },
  ];
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
  const tableRows = 24;
  const rowHeights = Array.from({ length: tableRows }, (_, row) => {
    const item = payload.items[row] as any;
    const remarksColumn = columns.find((column) => column.key === "remarks");
    if (!item || !remarksColumn) return rowHeight;
    const remarksLines = wrapPdfText(String(item.remarks || ""), regular, 5.2, remarksColumn.width - 7).length;
    return rowHeight + Math.max(0, remarksLines - 1) * 5.7;
  });
  let x = tableX;

  columns.forEach((column) => {
    page.drawRectangle({ x, y: tableTop - rowHeight, width: column.width, height: rowHeight, borderColor: black, borderWidth: 0.65 });
    const textWidth = bold.widthOfTextAtSize(column.label, 5.2);
    page.drawText(column.label, { x: x + (column.width - textWidth) / 2, y: tableTop - 9.2, size: 5.2, font: bold, color: black });
    x += column.width;
  });

  let rowBottom = tableTop - rowHeight;
  for (let row = 0; row < tableRows; row += 1) {
    const currentRowHeight = rowHeights[row];
    const y = rowBottom - currentRowHeight;
    x = tableX;
    columns.forEach((column) => {
      page.drawRectangle({ x, y, width: column.width, height: currentRowHeight, borderColor: black, borderWidth: 0.65 });
      const item = payload.items[row] as any;
      if (item) {
        drawPdfText(page, String(item[column.key] || ""), x + 3.5, y + currentRowHeight - 8.5, {
          font: regular,
          size: 5.2,
          maxWidth: column.width - 7,
          lineHeight: 5.7,
        });
      }
      x += column.width;
    });
    rowBottom = y;
  }

  const ackY = rowBottom - 2;
  page.drawText("ACKNOWLEDGEMENT", { x: tableX, y: ackY, size: 5, font: bold, color: black });
  const acknowledgement = "This is to acknowledge that I am accountable for the listed above. I understand that I will pay or replace the same unit in case of loss or damage due to my fault or negligence. In case of resignation or separation, I will turnover these items before issuance of my clearance. In case of transfer, I will turnover these items to the newly assigned staff with attached accountability form. For any additional software protected with license installed that do not appear on the list above, or do not have any supporting document/s coming from the IICTD Office, it is my responsibility to face any charges or liability coming from any software authority or organization. Also, I will follow the rules and regulations imposed by the Lifebank Foundation Inc. and I will be liable for any consequences that may arise for not complying with the set of rules and regulations.";
  drawPdfText(page, acknowledgement, tableX, ackY - 7, { font: regular, size: 4.25, maxWidth: tableWidth, lineHeight: 4.8 });

  const signatureBlock = (label: string, name: string, title: string, date: string, x0: number, y0: number, useSignature = false) => {
    const lineWidth = 102;
    const lineX = x0 + 77;
    const centerX = lineX + lineWidth / 2;
    const nameLineY = y0 - 6;
    const labelY = nameLineY - 10;
    const dateLineY = nameLineY - 25;
    const centerFit = (text: string, y: number, font: any, size: number, maxWidth: number) => {
      const value = String(text || "").trim();
      if (!value) return;
      let drawSize = size;
      while (drawSize > 3.9 && font.widthOfTextAtSize(value, drawSize) > maxWidth) {
        drawSize -= 0.2;
      }
      page.drawText(value, {
        x: centerX - font.widthOfTextAtSize(value, drawSize) / 2,
        y,
        size: drawSize,
        font,
        color: black,
      });
    };

    page.drawText(label, { x: x0, y: y0, size: 5.2, font: bold, color: black });
    if (useSignature && signature) {
      page.drawImage(signature.image, {
        x: centerX - signature.width / 2,
        y: nameLineY + 6,
        width: signature.width,
        height: signature.height,
      });
    }
    centerFit(name, nameLineY + 2, bold, 5, lineWidth - 4);
    line(lineX, nameLineY, lineX + lineWidth, nameLineY);
    centerFit(title || "Signature over Printed Name", labelY, regular, 4.8, lineWidth - 4);
    line(lineX, dateLineY, lineX + lineWidth, dateLineY);
    const dateText = safeDate(date);
    centerFit(dateText, dateLineY + 2, regular, 4.8, lineWidth - 4);
    centerSmall("Date", lineX, dateLineY - 11, lineWidth);
  };

  signatureBlock("Processed by:", payload.processedBy, "", payload.processedDate, 46, 178, true);
  signatureBlock("Checked by:", payload.checkedBy, "", payload.checkedDate, 225, 178);
  signatureBlock("Verified by:", payload.verifiedBy, payload.verifiedTitle, payload.verifiedDate, 410, 178);
  signatureBlock("Noted by:", payload.notedBy, payload.notedTitle, payload.notedDate, 410, 112);

  return Buffer.from(await pdf.save());
}
