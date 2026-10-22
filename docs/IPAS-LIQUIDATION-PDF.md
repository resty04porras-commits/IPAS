# Liquidation reference PDF export: editable source guide

## Change

`services/liquidationPdf.ts` now owns the reference-template PDF renderer used
by the existing Linux liquidation export. It loads the reference PDF and draws
the existing headers, receipt rows, expense totals, settlement box and signatory
names/titles over its first page. The server imports the same async entry point.

`server.ts` decreases from 5,553 to 5,024 lines, a reduction of 529 lines.
The renderer and its template-path function retain their exact original bodies.
The module uses existing `pdf-lib`, Node built-ins, record/totals helpers and
the shared workbook date/time formatters. No dependency or service is added.

## Daily source editing

Use **Ctrl+P** in VS Code and enter the relevant path:

| Task | File |
| --- | --- |
| Active Linux liquidation PDF field positions, fonts, fitting and drawing | `services/liquidationPdf.ts` |
| Liquidation Excel headers, row/column mapping, styles and signatory text | `services/liquidationWorkbook.ts` |
| Shared liquidation table date/time formatting | `services/liquidationWorkbook.ts` |
| Expense totals, cash advance/settlement and record/form preparation | `services/liquidationRecords.ts` |
| Export format/platform selection and Windows Excel automation | `server.ts` |

The module exports `generateLiquidationReferencePdfExport(payload)` and returns
a PDF buffer. The existing alternate programmatic PDF renderer remains in the
server; the current Linux route selects the reference-template renderer above.
Edit source, validate, build and restart. `dist-server/server.cjs` is generated.

## Preserved behavior

- Each export loads `reference_files/liquidation_form_reference.pdf` from the
  current working directory. Missing or invalid files keep their existing errors.
- The renderer keeps the template's page dimensions and background content.
  It draws on the first page; additional template pages retain their content.
- Field positions, fonts, fitted/wrapped text, masks and grid lines are unchanged.
- Date/time and numeric formatting, all expense contributions, cash advance,
  Return to CO/Reimbursement labels and absolute settlement amounts are unchanged.
- The existing table shows at most 43 items; totals still use all input items.
- Signatory names and titles retain their positions and fitting rules.
- Original template bytes and the caller payload are not modified by rendering.

Excel rendering, Windows automation, API routes, database persistence, frontend,
camera sync, OCR engines and HTTPS retain their existing implementations.
This extraction does not change font support, add pagination, or alter saved forms.

## Files to copy

| Download | Destination |
| --- | --- |
| `liquidationPdf.ts` | `/srv/IPAS-PUBLISH/services/liquidationPdf.ts` |
| `liquidationPdf.test.ts` | `/srv/IPAS-PUBLISH/tests/liquidationPdf.test.ts` |
| `server.ts` | `/srv/IPAS-PUBLISH/server.ts` |
| `IPAS-LIQUIDATION-PDF.md` | `/srv/IPAS-PUBLISH/docs/IPAS-LIQUIDATION-PDF.md` |

The replacement server is based on owner commit `473bf2d`. Verify the existing
server's SHA256 before replacing it:

```text
e7fc2a9ab748c5005be3a886ab9e04fa8fdd00c108dcc080bc441d796d105fd6
```

If it differs, merge the isolated change into the newer source instead.
Back up `server.ts` and `dist-server/server.cjs` before replacing or building.
Individual source hashes and the isolated review diff are supplied separately.

## Checks and test scope

Run in `/srv/IPAS-PUBLISH` after copying the module, test and replacement server:

```bash
node --import tsx --test tests/liquidationPdf.test.ts tests/liquidationWorkbook.test.ts tests/officeXml.test.ts tests/zipArchive.test.ts tests/liquidationRecords.test.ts tests/liquidationText.test.ts tests/structuredAi.test.ts tests/uploadedSources.test.ts tests/barcodeWorker.test.ts tests/ocrWorkerPool.test.ts tests/ocrServiceLifecycle.test.ts tests/ocrHttpClient.test.ts tests/ocrRecognizer.test.ts tests/ocrRoutes.test.ts tests/documentRepositoryRoutes.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
```

The 10 new tests create reference PDFs in temporary folders and load the rendered
output using the existing PDF library. They inspect decoded drawing content for
headers, rows, dates/times, money values and signatory text. They also check
settlement cases, long-text rendering, template/payload integrity, additional
page preservation, fresh template reads, the existing row limit and file errors.
The tests restore their working directory and remove their temporary folders.

Separate compiled Linux app checks compare the before/after PDF page dimensions
and decoded drawing bytes using a blank synthetic reference PDF, excluding
creation timestamps. Excel exports are also compared member by member using the
existing public workbook in an isolated reference folder. Smart Capture PDF
drawing and embedded logo bytes are compared separately. See `VERIFICATION.json`
and the individual reports for completed checks and their scope.

After validation, restart `ipas.service` and check `/api/health`. Test the PDF
export on the owner's VM with its actual reference template and sample data.
The isolated checks do not establish the visual correctness of every owner
template, Windows Excel automation, database writes, external AI availability
or every application feature.

Commit only these four files, then push `refactor/modular-server` to GitHub after
owner verification. Keep unrelated staged `phase2b.py` and the standalone
`ipas-ocr-label-check.mjs` diagnostic outside this change.
