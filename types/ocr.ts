export type OcrSourceFile = {
  name: string;
  kind: "excel" | "pdf" | "image";
  contentType: "text" | "inlineData";
  content: string;
  mimeType: string;
};

export type OcrBBox = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type OcrWordEntry = {
  text: string;
  confidence: number;
  bbox: OcrBBox;
};

export type OcrLineEntry = {
  text: string;
  confidence: number;
  bbox: OcrBBox;
  words: OcrWordEntry[];
};

export type OcrSnapshot = {
  text: string;
  confidence: number;
  lines: OcrLineEntry[];
  words: OcrWordEntry[];
  width: number;
  height: number;
};

export type OcrRecognizeOptions = {
  rectangle?: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  mode?: "full" | "probe";
};

export type OcrBatchProbe = {
  key: string;
  rectangle?: OcrRecognizeOptions["rectangle"];
};

export type OcrWorkerResult = {
  snapshot?: OcrSnapshot;
  snapshots?: Record<string, OcrSnapshot>;
};

export type OcrRecognition = {
  snapshot: OcrSnapshot;
  engine: "easyocr-service" | "legacy-worker" | "text";
  fallback: boolean;
  primaryError?: string;
};
