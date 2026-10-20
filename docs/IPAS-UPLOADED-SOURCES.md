# Uploaded source files: editable source guide

## Change

The shared upload-preparation functions now live in `services/uploadedSources.ts`:

- `getUploadedCompareMimeType`: existing MIME normalization and extension fallback.
- `prepareUploadedFileForComparison`: reads the uploaded file and prepares its
  existing spreadsheet, PDF, or image source representation.
- `buildSourceParts`: assembles labels, extracted spreadsheet text, and inline
  file data for the existing structured-extraction callers.

`server.ts` imports these functions and retains its current controllers, OCR
recognizer, extraction rules, and export logic. It decreases from 6,735 to 6,633
lines, a reduction of 102 lines. This is a normal editable source file, with no
new dependencies or automatic installer.

## Where to edit

In VS Code press **Ctrl+P**, then enter the relevant path:

| Task | Source file |
| --- | --- |
| Upload MIME handling, spreadsheet reading, binary-file preparation, source parts | `services/uploadedSources.ts` |
| Shared source-file representation | `types/ocr.ts` |
| Image OCR HTTP requests and barcode HTTP fallback | `services/ocr/httpClient.ts` |
| OCR engine selection and service/worker fallback | `services/ocr/recognizer.ts` |
| Python HTTP service startup and health | `services/ocr/serviceLifecycle.ts` |
| Legacy OCR worker pool | `services/ocr/workerPool.ts` |
| Local barcode process | `services/ocr/barcodeWorker.ts` |
| Current OCR model and image preprocessing | `ocr-service/ocr_api.py` |
| Field extraction, remaining business logic, exports | `server.ts` |

Edit the source files, build the backend, and restart after checks pass.
`dist-server/server.cjs` is generated output.

## Preserved file behavior

- Uploaded files are read from their existing disk path. Preparation does not
  overwrite or delete them; request cleanup remains with the existing controller.
- A supplied non-generic MIME type is trimmed and lowercased. Missing or generic
  `application/octet-stream` MIME falls back to the supported extension map.
- `.xlsx` and `.xls` filenames, including uppercase extensions, retain priority
  for spreadsheet parsing. The first worksheet is converted to the same JSON
  text using the existing XLSX library defaults. Later worksheets remain unused.
- Leading-zero identifiers already stored as text remain text. Numeric cells
  retain the existing XLSX conversion behavior.
- PDF files remain inline base64 with their original name, MIME, and complete
  bytes. This preparation step does not add PDF text extraction or PDF OCR.
- Image files retain their original bytes and base64 representation. No resizing,
  recompression, or new camera processing is introduced here.
- Unsupported types and filesystem or workbook parsing failures retain their
  existing errors. A failed read does not become empty successful content.
- Source parts retain file order, labels, text, MIME, and inline base64 data.
  Constructing parts does not call an AI service.
- Existing route restrictions remain in place: OCR v2 and barcode scan currently
  accept image sources only. Preparing a PDF or spreadsheet does not change
  which routes accept it.

## Files to copy

| Download | Destination |
| --- | --- |
| `uploadedSources.ts` | `/srv/IPAS-PUBLISH/services/uploadedSources.ts` |
| `uploadedSources.test.ts` | `/srv/IPAS-PUBLISH/tests/uploadedSources.test.ts` |
| `server.ts` | `/srv/IPAS-PUBLISH/server.ts` |
| `IPAS-UPLOADED-SOURCES.md` | `/srv/IPAS-PUBLISH/docs/IPAS-UPLOADED-SOURCES.md` |

The full replacement `server.ts` is based on owner commit `961a69c`. Before
replacing it, verify the current server's SHA256:

```text
f36a686cc3373e6e270951868eabf11e6337f0d25a0f871d8bc66dc60bfddc4c
```

If it differs, merge this isolated change into the newer source. Back up the
current `server.ts` and `dist-server/server.cjs` first. Individual source hashes
and the review diff are supplied separately.

## Verification and deployment

Run in `/srv/IPAS-PUBLISH` after copying:

```bash
node --import tsx --test tests/uploadedSources.test.ts tests/barcodeWorker.test.ts tests/ocrWorkerPool.test.ts tests/ocrServiceLifecycle.test.ts tests/ocrHttpClient.test.ts tests/ocrRecognizer.test.ts tests/ocrRoutes.test.ts tests/documentRepositoryRoutes.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
```

The new tests use real XLSX and BIFF XLS workbooks, a real two-page PDF, PNG
bytes, disk files, and disk-backed multipart uploads. They verify rows and
identifiers, first-sheet selection, exact inline bytes, MIME/extension behavior,
error propagation, and mixed source-part ordering.

Separate compiled-application checks exercise OCR v2, asset extraction, receipt
extraction, generic-MIME image uploads, and existing PDF/spreadsheet image-only
restrictions. The normal EasyOCR/ZXing path is also checked with the owner's
original monitor image. See `VERIFICATION.json` for completed isolated checks;
the owner's VM still requires its own build and live verification.

After checks pass, restart `ipas.service`, check `/api/health`, and send the
monitor photo to `/api/ocr-v2`. Compare OCR text/confidence and the two barcode
values to the previous response. Keep unrelated staged files out of the commit.

This structural change does not add offline operation, change the database,
install a new model, or alter the working camera/HTTPS setup. Other server
modules remain available for later extraction.
