export type BarcodeCandidate = {
  value: string;
  type?: string | null;
  points?: unknown;
};

export type BarcodeScanResult<TRecord = unknown> = {
  success: boolean;
  barcode: string | null;
  type?: string | null;
  matched: boolean;
  record: TRecord | null;
  message: string;
  barcodes?: BarcodeCandidate[];
  durationMs?: number;
  engine?: string;
};
