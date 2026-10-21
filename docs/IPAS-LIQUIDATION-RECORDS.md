# Liquidation records and totals: editable source guide

## Change

`services/liquidationRecords.ts` now owns the existing liquidation record and
form-payload types, record normalization, manual-review record creation,
form-payload preparation, currency conversion, and expense/settlement totals.
The server imports these helpers for its existing extraction and export callers.

`server.ts` decreases from 6,349 to 6,201 lines, a reduction of 148 lines.
All six moved function bodies and both type definitions are unchanged.
The module adds no package, dependency, external service, or database migration.

## Daily source editing

Use **Ctrl+P** in VS Code and enter the path for the part you want to edit:

| Task | File |
| --- | --- |
| Record fields, blank/manual records, form headers, totals and cash settlement | `services/liquidationRecords.ts` |
| Reading amount, route, remarks and transport from OCR text | `services/liquidationText.ts` |
| Existing liquidation API controller and database operations | `controllers/terController.ts` |
| Export rendering, templates, OCR/AI workflow wiring | `server.ts` |
| Structured AI response parsing and retries | `services/structuredAi.ts` |

Build from source after editing and restart following validation.
`dist-server/server.cjs` is generated output.

## Preserved behavior

- Record normalization keeps the existing strings and replaces missing or
  non-string fields with blank strings. It does not trim, reformat or guess them.
- A manual-review record retains its source name, blank values, `Receipt/Ticket`
  remarks, and diagnostic note.
- Form preparation retains the same header fields, signature data-URL check,
  row order, and repeated rows. It creates normalized copies of each row.
- The existing standalone deduplication helper is preserved in the module.
  It uses source/date/amount/remarks as its key. This extraction does not begin
  calling it from form preparation or extraction.
- Currency conversion retains its existing handling of prefixes, separators,
  invalid values, negatives, and JavaScript decimal arithmetic.
- All six columns contribute to expenses: amount, per diem, breakfast, lunch,
  dinner, and others. Settlement remains cash advance minus total expenses.
- Export rendering and its existing settlement labels remain with their callers.
  The receipt-text amount fix from owner commit `fdb6e85` remains in place.

The API routes, database persistence, templates, frontend, camera sync and HTTPS
setup retain their existing implementations. This refactor does not recalculate
or modify saved records.

## Files to copy

| Download | Destination |
| --- | --- |
| `liquidationRecords.ts` | `/srv/IPAS-PUBLISH/services/liquidationRecords.ts` |
| `liquidationRecords.test.ts` | `/srv/IPAS-PUBLISH/tests/liquidationRecords.test.ts` |
| `server.ts` | `/srv/IPAS-PUBLISH/server.ts` |
| `IPAS-LIQUIDATION-RECORDS.md` | `/srv/IPAS-PUBLISH/docs/IPAS-LIQUIDATION-RECORDS.md` |

The replacement server is based on owner commit `fdb6e85`. Verify the existing
server's SHA256 before replacing it:

```text
c72e8e57f9def598fa3ad3c97ec91fb8882492ee029dcd071f698406d8131c48
```

If it differs, merge the isolated change into the newer source instead.
Back up both `server.ts` and `dist-server/server.cjs` before replacing or building.
Individual source hashes and the isolated review diff are supplied separately.

## Checks and test scope

Run in `/srv/IPAS-PUBLISH` after copying the module, test and replacement server:

```bash
node --import tsx --test tests/liquidationRecords.test.ts tests/liquidationText.test.ts tests/structuredAi.test.ts tests/uploadedSources.test.ts tests/barcodeWorker.test.ts tests/ocrWorkerPool.test.ts tests/ocrServiceLifecycle.test.ts tests/ocrHttpClient.test.ts tests/ocrRecognizer.test.ts tests/ocrRoutes.test.ts tests/documentRepositoryRoutes.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
```

The 17 new tests cover record/header handling, row preservation, manual fallback,
signature-field compatibility, all six expense columns, positive/negative/zero
settlements, decimal handling, and the existing standalone deduplication key.
An HTTP test exercises the actual export controller with a fixture export
callback, using dummy DB settings and making no database or external AI request.

Separate compiled-app checks compare receipt results before and after extraction.
Actual XLSX rendering uses the existing public Excel template copied into an
isolated temporary reference directory. Every exported ZIP entry's content is
compared, including expense/settlement cells, reimbursement labels and empty-row
validation. This does not establish PDF rendering or validate the owner's
specific reference files. See `VERIFICATION.json` for completed checks.

After validation, restart `ipas.service`, check `/api/health`, and compare the
monitor image's `/api/ocr-v2` response with the previous result. A sample Excel
export on the owner's VM can verify its actual template separately.
The isolated environment does not establish accuracy for every receipt,
external AI availability, database writes, or every application feature.

Stage and commit only these four files. Keep unrelated staged `phase2b.py` and
the standalone `ipas-ocr-label-check.mjs` diagnostic outside this change.
