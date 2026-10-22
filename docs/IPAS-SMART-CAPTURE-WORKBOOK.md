# Smart Capture Excel workbook: editable source guide

## Change

`services/smartCaptureWorkbook.ts` now owns the existing Linux Smart Capture
Excel renderer and its row builder. `server.ts` imports
`generateSmartCaptureExcelExport(payload)` at its existing call site.
`buildSmartCaptureExportRows(payload)` is also exported for source reuse.

Both function bodies retain their original contents. `server.ts` decreases
from 4,607 to 4,560 lines. The module uses the installed `xlsx` library and the
existing types in `types/accountability.ts`; no dependency is added.

## Daily editing

Use Ctrl+P in VS Code to open the relevant source:

| Task | File |
| --- | --- |
| Linux Smart Capture Excel columns, row order, field labels and column widths | `services/smartCaptureWorkbook.ts` |
| Smart Capture PDF layout, logo, wrapping and signatures | `services/smartCapturePdf.ts` |
| Asset/form TypeScript definitions | `types/accountability.ts` |
| Format/platform selection, validation and Windows automation | `server.ts` |

Edit source, validate, build and restart. `dist-server/server.cjs` is generated.

## Preserved behavior

- The XLSX workbook has one sheet named `Smart Capture`.
- Equipment columns remain Components, Description, Hardware ID, Serial, Remarks.
  All supplied rows retain input order; this renderer has no PDF-style row cap.
- Asset identifiers remain strings, including leading zeros and long serials.
  String values beginning with `=` retain literal text rather than Excel formulas.
- Employee, date and signatory fields keep their existing labels and raw values.
- Signature images are represented by `Attached`; otherwise the printed signature
  or an empty string is used. This workbook does not embed the signature image.
- Source filenames and internal OCR notes are not included in exported rows.
- Column widths and input immutability remain unchanged.

API validation and normalization still occur in the existing controller/server.
The module does not add validation, deduplication, persistence or image embedding.
The PDF renderer, Windows Excel automation, database, OCR, camera, frontend and
HTTPS retain their existing implementations.

## Files to copy

| Download | Destination |
| --- | --- |
| `smartCaptureWorkbook.ts` | `/srv/IPAS-PUBLISH/services/smartCaptureWorkbook.ts` |
| `smartCaptureWorkbook.test.ts` | `/srv/IPAS-PUBLISH/tests/smartCaptureWorkbook.test.ts` |
| `server.ts` | `/srv/IPAS-PUBLISH/server.ts` |
| `IPAS-SMART-CAPTURE-WORKBOOK.md` | `/srv/IPAS-PUBLISH/docs/IPAS-SMART-CAPTURE-WORKBOOK.md` |

The replacement server is based on owner commit `076643b`. Before replacing it,
verify the current server SHA256:

```text
936f7c25756630febb1e418d0b59b50131cf22f75a7c50b83ff998029daaefbb
```

If the hash differs, merge into the newer source instead. Back up `server.ts`
and `dist-server/server.cjs` before replacing or building.

## Validation and saving

Run from `/srv/IPAS-PUBLISH` after copying the module, test and replacement server:

```bash
node --import tsx --test tests/smartCaptureWorkbook.test.ts tests/smartCapturePdf.test.ts tests/liquidationPdf.test.ts tests/liquidationWorkbook.test.ts tests/officeXml.test.ts tests/zipArchive.test.ts tests/liquidationRecords.test.ts tests/liquidationText.test.ts tests/structuredAi.test.ts tests/uploadedSources.test.ts tests/barcodeWorker.test.ts tests/ocrWorkerPool.test.ts tests/ocrServiceLifecycle.test.ts tests/ocrHttpClient.test.ts tests/ocrRecognizer.test.ts tests/ocrRoutes.test.ts tests/documentRepositoryRoutes.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
```

The nine new tests load real generated XLSX buffers and inspect field values,
literal string types, metadata, empty fields, all-row export, signature markers,
column widths and input integrity. Separate compiled Linux app checks compare
all before/after Smart Capture XLSX ZIP member contents, retaining the exact
asset serial, employee name and date. Existing Smart Capture PDF drawing/logo,
liquidation Excel member and liquidation PDF drawing comparisons also run.
PDF creation timestamps are excluded; liquidation PDF uses a synthetic reference
page. See `VERIFICATION.json` and the individual reports for completed checks.

Restart `ipas.service`, check `/api/health`, then export and inspect a sample
Smart Capture XLSX on the owner VM. Cloud checks do not establish Windows
automation, database writes, external service behavior or every app feature.
Commit only the four files listed above, then push `refactor/modular-server`
after validation. Keep unrelated staged `phase2b.py` and untracked
`ipas-ocr-label-check.mjs` outside this change.
