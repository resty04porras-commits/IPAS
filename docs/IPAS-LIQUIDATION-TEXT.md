# Receipt text interpretation: editable source guide

## Change

Receipt amount normalization and selection, route interpretation, remarks, and
transport-mode interpretation now live in `services/liquidationText.ts`.
The server creates one parser with its existing shared `getMeaningfulOcrLines`
function. That shared function remains available to the asset extraction code.

`server.ts` decreases from 6,473 to 6,349 lines, a reduction of 124 lines.
The extracted module uses TypeScript and adds no dependency or external service.

## Corrected amount parsing

The previous amount-matching expression accepted a three-digit group without
requiring a comma. It consequently split an ungrouped amount into smaller
matches before the normalizer received it:

| OCR text | Previous result | Corrected result |
| --- | --- | --- |
| `TOTAL PHP 2500.00` | `250.00` | `2500.00` |
| `TOTAL PHP 12500.50` | `125.00` | `12500.50` |
| `TOTAL PHP 12,500.50` | `12500.50` | `12500.50` |

The grouped alternative now requires a comma. The plain-number alternative can
therefore consume the entire ungrouped amount. This one-character regex fix is
the only intentional change to the moved function bodies.

Existing amount scoring, keyword penalties, lower-line preference, higher-value
tie break, positive-value limit below one billion, and two-decimal output remain.
Route and transport/remarks keyword priorities remain as before. The parser
still works from the OCR text supplied by its caller: an incorrect OCR reading
or an ambiguous receipt can still produce an incorrect or empty field.

The OCR engines, barcode decoding, AI fallback, extraction prompts, API routes,
database, receipt persistence, frontend, camera sync, and HTTPS setup retain
their existing implementations. This change does not revise existing records.

## Daily source editing

Use **Ctrl+P** in VS Code and enter the relevant path:

| Task | File |
| --- | --- |
| Receipt amount, route, transport and remarks interpretation | `services/liquidationText.ts` |
| Shared OCR line cleanup, extraction prompts and workflow wiring | `server.ts` |
| Structured AI output parsing and retries | `services/structuredAi.ts` |
| Preparing uploaded images, PDF and spreadsheet sources | `services/uploadedSources.ts` |
| Selecting the OCR engine and fallback | `services/ocr/recognizer.ts` |

Edit source files, validate, build, and restart. `dist-server/server.cjs` is
generated output and should not be edited manually.

## Files to copy

| Download | Destination |
| --- | --- |
| `liquidationText.ts` | `/srv/IPAS-PUBLISH/services/liquidationText.ts` |
| `liquidationText.test.ts` | `/srv/IPAS-PUBLISH/tests/liquidationText.test.ts` |
| `server.ts` | `/srv/IPAS-PUBLISH/server.ts` |
| `IPAS-LIQUIDATION-TEXT.md` | `/srv/IPAS-PUBLISH/docs/IPAS-LIQUIDATION-TEXT.md` |

The replacement server is based on owner commit `060362e`. Before replacing it,
check the current server's SHA256:

```text
788c758aee10afa1095bd6088982d1f577a72e84b75578d6788ee3518c5ed3e1
```

If the hash differs, merge the isolated change into the newer source instead.
Back up both `server.ts` and `dist-server/server.cjs` before replacing or building.
The separate review diff and hashes describe the source files supplied here.

## Checks

Run in `/srv/IPAS-PUBLISH` after copying the module, tests, and replacement server:

```bash
node --import tsx --test tests/liquidationText.test.ts tests/structuredAi.test.ts tests/uploadedSources.test.ts tests/barcodeWorker.test.ts tests/ocrWorkerPool.test.ts tests/ocrServiceLifecycle.test.ts tests/ocrHttpClient.test.ts tests/ocrRecognizer.test.ts tests/ocrRoutes.test.ts tests/documentRepositoryRoutes.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
```

The 18 new tests cover full ungrouped amounts and their comma-separated
equivalents, range rejection, competing receipt numbers, amount priorities,
route extraction, remarks and transport priorities, and the shared line-provider
contract. They also exercise interpretation after text-source recognition.
See `VERIFICATION.json` for completed isolated checks and their scope.

In a native EasyOCR check, a synthetic receipt printed with `2500.00` yielded
only city words after confidence filtering; the app correctly left the amount
empty and requested manual review. The amount fix is demonstrated with exact
OCR text in the tests and controlled compiled-app requests. It does not fix
that separate image-recognition limitation. The original monitor photo remains
the regression check for the existing OCR and barcode path.

After successful checks, restart `ipas.service`, verify `/api/health`, and compare
the monitor response from `/api/ocr-v2` with the previous result. A clear receipt
with a known total is also useful for checking the owner's actual OCR input.
The isolated test environment differs from the owner's VM; it does not establish
accuracy for every receipt, external AI availability, or database writes.

Stage and commit only these four files. Keep the unrelated staged `phase2b.py`
and standalone `ipas-ocr-label-check.mjs` out of this change.
