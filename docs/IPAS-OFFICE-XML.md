# Workbook cells, styles and drawing text: editable source guide

## Change

`services/officeXml.ts` now owns the existing XML helpers for worksheet text,
numbers, formula cached values, cell styles, row heights, merge ranges, style
alignment, and named drawing text boxes. The server imports these helpers for
its existing workbook export callers.

`server.ts` decreases from 6,013 to 5,812 lines, a reduction of 201 lines.
All 15 moved function bodies are unchanged. Nine helpers are exported; escaping,
cell-address parsing and lower-level cell replacement remain internal.
The module uses plain TypeScript and adds no dependency or external service.

## Daily source editing

Use **Ctrl+P** in VS Code and enter the path for the part you want to edit:

| Task | File |
| --- | --- |
| Reusable worksheet cell values, formula caches, styles, merges, drawing text | `services/officeXml.ts` |
| Reading/writing workbook ZIP members and extracting embedded logos | `services/zipArchive.ts` |
| Liquidation record fields, form preparation and totals | `services/liquidationRecords.ts` |
| Which cells/rows/styles a form uses, export layout, template selection, PDF rendering | `server.ts` |

Exported helpers:

- `setInlineStringInSheet` and `setRichHeaderStringInSheet`
- `setNumberInSheet` and `setFormulaCachedValue`
- `setCellStyleInSheet` and `setRowHeightInSheet`
- `removeMergeRangesInSheet` and `setXfAlignmentAttributes`
- `replaceDrawingTextBox`

Edit source, validate, build, then restart. `dist-server/server.cjs` is generated
output and should not be edited manually.

## Preserved behavior

- Text uses the existing XML escaping, whitespace preservation, inline-string
  representation and rich-header formatting.
- Cell changes retain the existing address parsing, column insertion order,
  style attributes, missing-row behavior and invalid-address errors.
- Number handling, clearing empty/non-finite values and formula cached-value
  updates retain the same behavior. Existing formulas remain with their cells.
- Row heights, style indices, alignment attributes and merge counts retain
  their existing formatting and update rules.
- Named text-box updates preserve the existing body/list properties and
  paragraph formatting. Missing targets retain the existing result.

Form-specific row ranges, column mappings, style choices, formulas, totals,
template paths and export routing remain in their existing callers. The API,
database persistence, frontend, camera sync, OCR engines and HTTPS setup retain
their existing implementations. This extraction does not expand the XML helper
format support or rewrite saved forms or original templates.

## Files to copy

| Download | Destination |
| --- | --- |
| `officeXml.ts` | `/srv/IPAS-PUBLISH/services/officeXml.ts` |
| `officeXml.test.ts` | `/srv/IPAS-PUBLISH/tests/officeXml.test.ts` |
| `server.ts` | `/srv/IPAS-PUBLISH/server.ts` |
| `IPAS-OFFICE-XML.md` | `/srv/IPAS-PUBLISH/docs/IPAS-OFFICE-XML.md` |

The replacement server is based on owner commit `372af2e`. Verify the existing
server's SHA256 before replacing it:

```text
2c7c77146b04d1802b58e1fe92c0ed5650a495687a8e25f14db946fca6ecd335
```

If it differs, merge the isolated change into the newer source instead.
Back up `server.ts` and `dist-server/server.cjs` before replacing or building.
Individual hashes and the isolated review diff are supplied separately.

## Checks and test scope

Run in `/srv/IPAS-PUBLISH` after copying the module, test and replacement server:

```bash
node --import tsx --test tests/officeXml.test.ts tests/zipArchive.test.ts tests/liquidationRecords.test.ts tests/liquidationText.test.ts tests/structuredAi.test.ts tests/uploadedSources.test.ts tests/barcodeWorker.test.ts tests/ocrWorkerPool.test.ts tests/ocrServiceLifecycle.test.ts tests/ocrHttpClient.test.ts tests/ocrRecognizer.test.ts tests/ocrRoutes.test.ts tests/documentRepositoryRoutes.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
```

The 18 new tests cover the helper behaviors and a workbook edited through XML,
then independently parsed using the existing XLSX library to check values,
identifier text and formulas.

Separate compiled Linux app checks compare real liquidation Excel exports
before and after extraction using the existing public workbook copied into a
temporary reference directory. Every exported ZIP member's content is compared,
and XML members are parsed. Test headers include XML-special characters.
Expense cells, positive/negative settlement labels and empty-row validation are
checked. Smart Capture PDF page drawing and embedded image bytes are also
compared, excluding creation timestamps. See `VERIFICATION.json` for scope.

After successful checks, restart `ipas.service` and check `/api/health`.
An Excel/PDF download on the owner's VM can verify its actual templates.
The isolated checks do not establish Windows Excel automation, liquidation
reference-PDF rendering, every owner-specific template, database writes,
external AI availability or every application feature.

Stage and commit only these four files, then push `refactor/modular-server` to
GitHub after owner verification. Keep unrelated staged `phase2b.py` and the
standalone `ipas-ocr-label-check.mjs` diagnostic outside this change.
