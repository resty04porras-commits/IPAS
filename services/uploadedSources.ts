import fs from "node:fs";
import * as XLSX from "xlsx";
import type { OcrSourceFile } from "../types/ocr.js";

// Shared upload preparation for accountability, comparison and receipt extraction.
export function buildSourceParts(
  label: string,
  files: OcrSourceFile[]
): Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> {
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

  files.forEach((file, index) => {
    parts.push({ text: `${label} file ${index + 1}: ${file.name} (${file.kind})` });

    if (file.contentType === "text") {
      parts.push({ text: `${label} extracted text ${index + 1}:\n${file.content}` });
      return;
    }

    parts.push({
      inlineData: {
        mimeType: file.mimeType,
        data: file.content,
      },
    });
  });

  return parts;
}

export function getUploadedCompareMimeType(file: Express.Multer.File): string {
  const normalizedMimeType = (file.mimetype || "").trim().toLowerCase();
  if (normalizedMimeType && normalizedMimeType !== "application/octet-stream") {
    return normalizedMimeType;
  }

  const lowerName = file.originalname.toLowerCase();
  if (lowerName.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (lowerName.endsWith(".png")) {
    return "image/png";
  }
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lowerName.endsWith(".webp")) {
    return "image/webp";
  }
  if (lowerName.endsWith(".bmp")) {
    return "image/bmp";
  }
  if (lowerName.endsWith(".gif")) {
    return "image/gif";
  }
  if (lowerName.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (lowerName.endsWith(".xls")) {
    return "application/vnd.ms-excel";
  }

  return "application/octet-stream";
}

export async function prepareUploadedFileForComparison(file: Express.Multer.File): Promise<OcrSourceFile> {
  const lowerName = file.originalname.toLowerCase();
  const mimeType = getUploadedCompareMimeType(file);
  const buffer = await fs.promises.readFile(file.path);

  if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const json = XLSX.utils.sheet_to_json(worksheet);

    return {
      name: file.originalname,
      kind: "excel",
      contentType: "text",
      content: JSON.stringify(json, null, 2),
      mimeType: "application/json",
    };
  }

  if (lowerName.endsWith(".pdf") || mimeType === "application/pdf") {
    return {
      name: file.originalname,
      kind: "pdf",
      contentType: "inlineData",
      content: buffer.toString("base64"),
      mimeType,
    };
  }

  if (mimeType.startsWith("image/")) {
    return {
      name: file.originalname,
      kind: "image",
      contentType: "inlineData",
      content: buffer.toString("base64"),
      mimeType,
    };
  }

  throw new Error(`Unsupported file type: ${file.originalname}. Please upload Excel, PDF, or image files.`);
}
