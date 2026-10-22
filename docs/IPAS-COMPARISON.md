# Comparison rules and results: editable source guide

## Change

`services/comparison.ts` now owns the existing pure comparison rules, comparison
record types, record normalization and batch result builder. `server.ts` imports
the same entry points and continues to own extraction and API orchestration.

`server.ts` decreases from 4,560 to 4,164 lines. All 15 moved function bodies
and four type definitions retain their original contents. Only source locations,
exports and imports change. The module has no runtime dependency or service.

## Daily editing

Use Ctrl+P in VS Code to open the relevant source:

| Task | Location |
| --- | --- |
| Component aliases, description matching, identifier formatting and mismatch explanations | `services/comparison.ts`, function `compareField` and its helpers |
| Match/mismatch/missing statuses, critical-field order and final notes | Same module, function `compareExtractedRecords` |
| Comparison record normalization and TypeScript types | Same module, `normalizeRecord`, `normalizeExtractedRecord` and exported types |
| Shared text/identifier normalization and ordered deduplication | Same module, `normalizeGeneral`, `normalizeIdentifier`, `dedupePreserveOrder` |
| AI/OCR extraction, reference alignment, record merging and API orchestration | `server.ts` |

The shared normalization helpers are also imported by the existing intake/OCR
code in the server. Changes to those helpers can affect those callers; validate
the relevant tests. Edit source, check, build and restart. The compiled
`dist-server/server.cjs` file is generated output.

## Preserved behavior

- The four critical fields remain components, description, hardwareId and serial.
- Identifier comparison ignores case and punctuation. Leading zeros are retained.
- Component aliases and description token-matching rules remain unchanged.
- OCR-confusable identifier characters remain mismatches with a manual-check note.
  The comparison does not silently correct those characters or save replacements.
- Similar values remain mismatches. Existing similarity thresholds and explanatory
  text are unchanged, including their current edge cases.
- Batch comparison uses the supplied index alignment. It does not itself reorder
  observations or add extra observations to the expected records.
- Empty evidence retains the current missing status; partial evidence retains
  the current mismatch behavior. Extraction/merging before this function remains
  in the server and can supply field values before comparison.
- Returned document/image values, mismatch order, field notes and final notes
  retain their existing contents. Caller records are not mutated.

This extraction changes no matching policy, OCR accuracy, AI model, routing,
database storage, export layout, camera sync, frontend, port or HTTPS setup.

## Files to copy

| Download | Destination |
| --- | --- |
| `comparison.ts` | `/srv/IPAS-PUBLISH/services/comparison.ts` |
| `comparison.test.ts` | `/srv/IPAS-PUBLISH/tests/comparison.test.ts` |
| `server.ts` | `/srv/IPAS-PUBLISH/server.ts` |
| `IPAS-COMPARISON.md` | `/srv/IPAS-PUBLISH/docs/IPAS-COMPARISON.md` |

The replacement server is based on owner commit `1711b7e`. Before replacing it,
verify the existing server SHA256:

```text
05f0396f09bcec018e01dfeb45be0195ae82f22508ecf5266e33e606a8f787ea
```

If the hash differs, merge into the newer source instead. Back up both the source
server and compiled server before replacing or building.

## Validation and saving

Run from `/srv/IPAS-PUBLISH` after copying the module, test and replacement server:

```bash
node --import tsx --test tests/comparison.test.ts tests/smartCaptureWorkbook.test.ts tests/smartCapturePdf.test.ts tests/liquidationPdf.test.ts tests/liquidationWorkbook.test.ts tests/officeXml.test.ts tests/zipArchive.test.ts tests/liquidationRecords.test.ts tests/liquidationText.test.ts tests/structuredAi.test.ts tests/uploadedSources.test.ts tests/barcodeWorker.test.ts tests/ocrWorkerPool.test.ts tests/ocrServiceLifecycle.test.ts tests/ocrHttpClient.test.ts tests/ocrRecognizer.test.ts tests/ocrRoutes.test.ts tests/documentRepositoryRoutes.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
```

The 26 new tests cover formatting, aliases, description/model differences,
missing values, OCR-confusable identifiers, similarity thresholds, batch status,
notes, index alignment and input integrity. Separate checks compare original
baseline declarations with the extracted module across 4,356 field pairs,
250 synthetic batches and 66 shared normalizations, including exact output notes.

Compiled Linux API checks run before/after `/api/compare` requests using a local
synthetic Gemini response server and a dummy key. They verify identical match,
mismatch and missing results, raw identifier values, notes and missing-source
validation. They do not contact external AI or exercise real-image OCR, Windows
automation, owner data or database writes. See `VERIFICATION.json` and the
individual reports for completed checks and scope.

Restart `ipas.service`, check `/api/health`, and run a small comparison fixture
on the owner VM. Normal image-based comparison still depends on the existing
OCR/AI services and the quality of the input evidence.
Commit only the four files listed above, then push `refactor/modular-server`
after verification. Keep unrelated staged `phase2b.py` and untracked
`ipas-ocr-label-check.mjs` outside this change.
