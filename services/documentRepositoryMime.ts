import path from "node:path";

export function getRepoMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".pdf":  "application/pdf",
    ".jpg":  "image/jpeg", ".jpeg": "image/jpeg",
    ".png":  "image/png",  ".gif":  "image/gif",
    ".webp": "image/webp", ".bmp":  "image/bmp",
    ".heic": "image/heic", ".heif": "image/heif",
    ".svg":  "image/svg+xml",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls":  "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc":  "application/msword",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt":  "text/plain", ".csv": "text/csv",
    ".json": "application/json", ".xml": "application/xml",
    ".zip":  "application/zip",
  };
  return map[ext] || "application/octet-stream";
}
