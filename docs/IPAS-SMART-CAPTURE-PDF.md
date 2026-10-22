# Smart Capture PDF: editable source guide

## Change

`services/smartCapturePdf.ts` owns the two existing Smart Capture PDF renderers
and the shared PDF text wrapping/drawing helpers. The existing Linux PDF path
continues to call `generateOfficialSmartCapturePdfExport(payload)`.
`types/accountability.ts` holds the existing asset record, form payload and
export-format types used by the server and PDF module.

`server.ts` decreases from 5,024 to 4,607 lines. All four moved function bodies
and all three type definitions retain their original contents. Only exports,
imports and source locations change. Existing dependencies are sufficient.

## Daily editing

Use Ctrl+P in VS Code and enter the relevant path:

| Task | File |
| --- | --- |
| Active Linux Smart Capture PDF layout, logo, table and signatures | `services/smartCapturePdf.ts`, function `generateOfficialSmartCapturePdfExport` |
| Existing alternate Smart Capture PDF layout | Same module, function `generateSmartCapturePdfExport` |
| Shared PDF text wrapping and line placement | Same module, functions `wrapPdfText` and `drawPdfText` |
| Asset record and accountability form TypeScript definitions | `types/accountability.ts` |
| Smart Capture Excel export, format/platform choice and Windows automation | `server.ts` |

The alternate renderer remains available without being selected by the current
Linux export route. The server still uses `drawPdfText` for its existing alternate
liquidation renderer. Edit source files, validate, build and restart;
`dist-server/server.cjs` is generated output.

## Preserved behavior

- The official PDF is a single Letter page, 612 by 792 points.
- The header logo is read from `xl/media/image1.png` in
  `public/forms/accountability-form-template.xlsx` under the working directory.
  Missing or invalid logos keep the existing vector/text fallback header.
- Employee fields, date formatting, exact asset text, acknowledgements and
  signatory names/titles retain their existing drawing and wrapping rules.
- PNG/JPEG/JPG signature data URLs keep the existing embedding and failure handling.
- The official table retains its existing 24 visible rows and remarks wrapping.
  The alternate renderer retains its 12-row limit and 595 by 842 page dimensions.
- Rendering does not modify the caller payload or original workbook bytes.

This extraction adds no pagination or font support and changes no API validation,
database storage, OCR engine, camera sync, frontend, HTTPS or Windows automation.
The existing row limits should be considered when exporting large asset lists.

## Files to copy

| Download | Destination |
| --- | --- |
| `accountability.ts` | `/srv/IPAS-PUBLISH/types/accountability.ts` |
| `smartCapturePdf.ts` | `/srv/IPAS-PUBLISH/services/smartCapturePdf.ts` |
| `smartCapturePdf.test.ts` | `/srv/IPAS-PUBLISH/tests/smartCapturePdf.test.ts` |
| `server.ts` | `/srv/IPAS-PUBLISH/server.ts` |
| `IPAS-SMART-CAPTURE-PDF.md` | `/srv/IPAS-PUBLISH/docs/IPAS-SMART-CAPTURE-PDF.md` |

The replacement server is based on owner commit `4fc0886`. Check the existing
server's SHA256 before replacing it:

```text
f73b12123865fb4eb03f62e49d45cd167746a08fbfcddb04a523e779ab2c0128
```

If the hash differs, merge into the newer source instead. Back up both
`server.ts` and `dist-server/server.cjs` before replacing or building.

## Validation and saving

After copying the source and test files, run from `/srv/IPAS-PUBLISH`:

```bash
node --import tsx --test tests/smartCapturePdf.test.ts tests/liquidationPdf.test.ts tests/liquidationWorkbook.test.ts tests/officeXml.test.ts tests/zipArchive.test.ts tests/liquidationRecords.test.ts tests/liquidationText.test.ts tests/structuredAi.test.ts tests/uploadedSources.test.ts tests/barcodeWorker.test.ts tests/ocrWorkerPool.test.ts tests/ocrServiceLifecycle.test.ts tests/ocrHttpClient.test.ts tests/ocrRecognizer.test.ts tests/ocrRoutes.test.ts tests/documentRepositoryRoutes.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
```

The 14 new tests inspect generated PDF drawing content and embedded images,
covering fields, exact identifiers, dates, signatories, wrapping, row limits,
missing/corrupt logo fallback, valid/invalid PNG signatures, template integrity
and payload integrity. Temporary fixtures require no downloaded template.

Separate compiled-app checks compare before/after Smart Capture PDF drawing and
embedded logo bytes using the existing public workbook. They also compare
liquidation Excel ZIP entries and liquidation PDF drawing content on a synthetic
reference PDF. Creation timestamps are excluded. See `VERIFICATION.json` and the
individual reports for completed checks and scope. These are not verification
of every application feature, external service, Windows export or database write.

Restart `ipas.service`, check `/api/health`, and export a sample Smart Capture PDF
on the owner VM. Confirm its fields, asset identifiers, logo and signature.
Commit only the five files listed above and push `refactor/modular-server` after
verification. Keep unrelated staged `phase2b.py` and untracked
`ipas-ocr-label-check.mjs` outside this change.
