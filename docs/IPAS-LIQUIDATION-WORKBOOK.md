# Liquidation Excel export: editable source guide

## Change

`services/liquidationWorkbook.ts` now owns the existing liquidation workbook
renderer: template path, header and row mapping, table styles, totals cells,
signatory drawing text, and final ZIP-member updates. The server imports the
export function for its existing XLSX and Windows PDF-export callers.

`server.ts` decreases from 5,812 to 5,553 lines, a reduction of 259 lines.
All nine moved function bodies are unchanged. The existing date/time formatters
are exported from this module for the PDF caller that already shared them.
The module uses Node built-ins and existing helpers; no dependency is added.

## Daily source editing

Use **Ctrl+P** in VS Code and enter the relevant path:

| Task | File |
| --- | --- |
| Liquidation Excel headers, row/column mapping, styles and signatory text | `services/liquidationWorkbook.ts` |
| Shared liquidation table date/time formatting | `services/liquidationWorkbook.ts` |
| Expense totals, cash advance/settlement, form and record preparation | `services/liquidationRecords.ts` |
| Reusable cell, formula, alignment, merge and text-box XML changes | `services/officeXml.ts` |
| Reading/writing workbook archive contents and extracting logos | `services/zipArchive.ts` |
| Export routing, PDF drawing, Windows automation and API wiring | `server.ts` |

The public functions are `generateLiquidationExcelExport`,
`getLiquidationReferenceExcelPath`, `formatLiquidationTableDate` and
`normalizeLiquidationTableTime`. The workbook's sheet/style/drawing population
functions remain internal. Edit source, validate, build and restart.
`dist-server/server.cjs` is generated output.

## Preserved behavior

- The template is still read from
  `reference_files/liquidation_form_reference.xlsx` under the current working
  directory. A fresh template is read for each export; missing or invalid files
  retain their existing errors.
- Worksheet headers and row fields keep the same cells, date/time formatting,
  numeric handling, styles, row heights and settlement merge changes.
- The current table shows at most 43 items. Totals still use all input items,
  including items beyond that existing visible-row limit.
- Cached totals/formulas, cash advance and Return to CO/Reimbursement labels
  retain their existing behavior.
- Signatory names/titles still target the same named drawing text boxes.
- The renderer updates the same worksheet, styles and drawing ZIP members,
  removes the calculation chain, and retains other member contents.
- Source payloads and original template files are not modified by rendering.

The API routes, database persistence, frontend, camera sync, OCR engines, HTTPS
setup and PDF renderers retain their existing implementations. The shared
date/time formatting has moved without changing its behavior.

## Files to copy

| Download | Destination |
| --- | --- |
| `liquidationWorkbook.ts` | `/srv/IPAS-PUBLISH/services/liquidationWorkbook.ts` |
| `liquidationWorkbook.test.ts` | `/srv/IPAS-PUBLISH/tests/liquidationWorkbook.test.ts` |
| `server.ts` | `/srv/IPAS-PUBLISH/server.ts` |
| `IPAS-LIQUIDATION-WORKBOOK.md` | `/srv/IPAS-PUBLISH/docs/IPAS-LIQUIDATION-WORKBOOK.md` |

The replacement server is based on owner commit `293b554`. Verify the existing
server's SHA256 before replacing it:

```text
4ee4e3f40cc699d928fcbb202f5f6d83bfda451b5b3d8823da315b749a87b0fb
```

If it differs, merge the isolated change into the newer source instead.
Back up `server.ts` and `dist-server/server.cjs` before replacing or building.
Individual hashes and the isolated review diff are supplied separately.

## Checks and test scope

Run in `/srv/IPAS-PUBLISH` after copying the module, test and replacement server:

```bash
node --import tsx --test tests/liquidationWorkbook.test.ts tests/officeXml.test.ts tests/zipArchive.test.ts tests/liquidationRecords.test.ts tests/liquidationText.test.ts tests/structuredAi.test.ts tests/uploadedSources.test.ts tests/barcodeWorker.test.ts tests/ocrWorkerPool.test.ts tests/ocrServiceLifecycle.test.ts tests/ocrHttpClient.test.ts tests/ocrRecognizer.test.ts tests/ocrRoutes.test.ts tests/documentRepositoryRoutes.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
```

The 12 new tests create a self-contained workbook fixture in a temporary folder,
render it through the extracted module, and read it using the existing XLSX
library. They cover dates/times, headers, rows, expense/settlement values,
formulas, signatory text, styles, untouched archive members, template/payload
integrity, the existing visible-row limit, and missing/invalid template errors.
The test restores its working directory and removes its temporary folder.

Separate compiled Linux app checks compare real Excel exports before and after
extraction using the existing public workbook copied into an isolated reference
directory. Every exported ZIP member's content is compared and XML members are
parsed. Smart Capture PDF drawings and logo bytes are also compared. The Linux
liquidation PDF overlay is tested on a blank synthetic reference PDF to verify
unchanged drawing bytes and the shared date/time text. This does not establish
the visual layout of the owner's reference PDF or Windows Excel automation.
See `VERIFICATION.json` and the individual reports for completed isolated checks.

After validation, restart `ipas.service`, check `/api/health`, and verify an
Excel/PDF download on the owner's VM with its actual templates. These checks do
not establish every owner-specific template, database writes, external AI
availability or every application feature.

Commit only these four files, then push `refactor/modular-server` to GitHub after
owner verification. Keep unrelated staged `phase2b.py` and the standalone
`ipas-ocr-label-check.mjs` diagnostic outside this change.
