# Workbook ZIP contents and template logos: editable source guide

## Change

`services/zipArchive.ts` now owns the existing helpers that read ZIP members,
rewrite a workbook archive, update or remove a named member, and extract an
embedded template logo. Excel `.xlsx` files contain ZIP members such as worksheet
XML, styles, drawings, and images. The server imports these helpers for its
existing Excel and PDF export callers.

`server.ts` decreases from 6,201 to 6,013 lines, a reduction of 188 lines.
All five moved function bodies, the CRC32 table, and the entry type are unchanged.
The new module uses Node's built-in `node:zlib`; no dependency is installed.

## Daily source editing

Use **Ctrl+P** in VS Code and enter the path for the part you want to edit:

| Task | File |
| --- | --- |
| Reading/writing ZIP members, compression, extracting embedded template logos | `services/zipArchive.ts` |
| Worksheet XML, cell styles, drawings, export layout and PDF rendering | `server.ts` |
| Record fields, form preparation, expense totals and settlement | `services/liquidationRecords.ts` |
| Reading receipt amount, route and remarks from OCR text | `services/liquidationText.ts` |

The exported helpers are `readZipEntries`, `writeZipEntries`, `updateZipEntry`,
and `extractZipEntryBuffer`. The entry type is `XlsxZipEntry`; CRC32 calculation
remains internal. The module works with in-memory buffers. Existing callers
continue to decide which template files to read and which export files to return.

Edit source, validate, build and restart. `dist-server/server.cjs` is generated
output and should not be edited manually.

## Preserved behavior

- The directory reader retains member order, names, stored/deflated content,
  and its existing missing-directory, corrupt-header and compression errors.
- The writer retains its existing deflate method, checksums and ZIP layout.
- Updating a named member retains other members; returning `null` removes that
  member. A missing name does not create a new member or call the updater.
- Single-member extraction keeps its existing supported compression methods,
  local-header search and `null` results. Its handling of descriptor-based
  entries remains different from the directory reader, as before.
- Worksheet/formula updates, logo selection, PDF rendering, template paths,
  expense totals and export API routes remain with their existing callers.

The database, frontend, camera sync, OCR engines and HTTPS setup retain their
existing implementations. No saved form or original template is rewritten by
copying these source files.

## Files to copy

| Download | Destination |
| --- | --- |
| `zipArchive.ts` | `/srv/IPAS-PUBLISH/services/zipArchive.ts` |
| `zipArchive.test.ts` | `/srv/IPAS-PUBLISH/tests/zipArchive.test.ts` |
| `server.ts` | `/srv/IPAS-PUBLISH/server.ts` |
| `IPAS-ZIP-ARCHIVE.md` | `/srv/IPAS-PUBLISH/docs/IPAS-ZIP-ARCHIVE.md` |

The replacement server is based on owner commit `253ead4`. Verify the existing
server's SHA256 before replacing it:

```text
e49059990bf841f61e66ef13d7645adceb5b812909f9229d6b1d68d4b6f7412c
```

If it differs, merge the isolated change into the newer source instead.
Back up `server.ts` and `dist-server/server.cjs` before replacing or building.
Individual source hashes and the isolated review diff are supplied separately.

## Checks and test scope

Run in `/srv/IPAS-PUBLISH` after copying the module, test and replacement server:

```bash
node --import tsx --test tests/zipArchive.test.ts tests/liquidationRecords.test.ts tests/liquidationText.test.ts tests/structuredAi.test.ts tests/uploadedSources.test.ts tests/barcodeWorker.test.ts tests/ocrWorkerPool.test.ts tests/ocrServiceLifecycle.test.ts tests/ocrHttpClient.test.ts tests/ocrRecognizer.test.ts tests/ocrRoutes.test.ts tests/documentRepositoryRoutes.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
```

The 14 new tests use independent Python ZIP fixtures and the existing XLSX
library. They cover supported compression, logo bytes, entry updates/removal,
checksums, formulas/identifiers, empty content, archive comments and the existing
error behavior for corrupt or unsupported input.

Separate compiled Linux app checks generate real liquidation Excel exports
before and after extraction using the existing public workbook copied into a
temporary reference directory. Every exported ZIP member's content is compared;
expense cells, settlement labels and empty-row validation are also checked.

The compiled Smart Capture PDF check uses the existing public accountability
template for its header image. Page sizes, decoded page drawing bytes, the serial
identifier, and embedded image bytes are compared before and after extraction.
Creation timestamps are excluded from that comparison. See `VERIFICATION.json`
and the individual reports for completed isolated checks.

After successful checks, restart `ipas.service` and check `/api/health`.
A sample Excel/PDF download on the owner's VM can verify its actual templates
separately. The isolated checks do not establish Windows Excel automation,
liquidation reference-PDF rendering, every owner-specific template, database
writes, external AI availability or every application feature.

Stage and commit only these four files. Keep unrelated staged `phase2b.py` and
the standalone `ipas-ocr-label-check.mjs` diagnostic outside this change.
