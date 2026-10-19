import type { OcrBBox, OcrSnapshot } from "../../types/ocr.js";

export function sanitizeOcrValue(value: string): string {
  return value
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toOcrBbox(rawBbox: any): OcrBBox {
  return {
    x0: Number(rawBbox?.x0 || 0),
    y0: Number(rawBbox?.y0 || 0),
    x1: Number(rawBbox?.x1 || 0),
    y1: Number(rawBbox?.y1 || 0),
  };
}

export function buildPlainTextSnapshot(text: string): OcrSnapshot {
  const lines = (text || "")
    .split("\n")
    .map((line) => sanitizeOcrValue(line))
    .filter(Boolean)
    .map((line) => ({
      text: line,
      confidence: 0,
      bbox: { x0: 0, y0: 0, x1: 0, y1: 0 },
      words: line.split(" ").filter(Boolean).map((word) => ({
        text: word,
        confidence: 0,
        bbox: { x0: 0, y0: 0, x1: 0, y1: 0 },
      })),
    }));

  return {
    text: lines.map((line) => line.text).join("\n"),
    confidence: 0,
    lines,
    words: lines.flatMap((line) => line.words),
    width: 0,
    height: 0,
  };
}

export function toOcrSnapshot(rawSnapshot: any): OcrSnapshot {
  return {
    text: sanitizeOcrValue(String(rawSnapshot?.text || "")),
    confidence: Number(rawSnapshot?.confidence || 0),
    lines: Array.isArray(rawSnapshot?.lines)
      ? rawSnapshot.lines.map((line: any) => ({
          text: sanitizeOcrValue(String(line?.text || "")),
          confidence: Number(line?.confidence || 0),
          bbox: toOcrBbox(line?.bbox),
          words: Array.isArray(line?.words)
            ? line.words.map((word: any) => ({
                text: sanitizeOcrValue(String(word?.text || "")),
                confidence: Number(word?.confidence || 0),
                bbox: toOcrBbox(word?.bbox),
              }))
            : [],
        }))
      : [],
    words: Array.isArray(rawSnapshot?.words)
      ? rawSnapshot.words.map((word: any) => ({
          text: sanitizeOcrValue(String(word?.text || "")),
          confidence: Number(word?.confidence || 0),
          bbox: toOcrBbox(word?.bbox),
        }))
      : [],
    width: Number(rawSnapshot?.width || 0),
    height: Number(rawSnapshot?.height || 0),
  };
}
