# Comparison Tools: physical evidence and progress

## Behavior

Comparison Tools reads the reference document once, reads each distinct evidence
file, then compares Components, Description, Hardware ID and Serial. Reference
values never fill blank physical fields or appear in an image-assistance prompt.
A field that cannot be read remains blank. These are draft readings that require
checking against the original labels and document.

Results use one equipment row with exactly five columns: Components, Description,
Hardware ID, Serial and Remarks. Every result is included, including matching
equipment. The four main columns show the PDF reference values; an unassigned
photo-only row shows its observed values. The Remarks describe image differences
in English. This presentation does not copy reference values into physical OCR
fields or change the matching outcome.

Examples:

| Finding | Remarks |
| --- | --- |
| All compared values match | `Match` |
| Different serial | `Serial number mismatch: PDF "ABC0"; image "ABCO".` |
| Serial not read | `Serial number not readable in the image. PDF: "ABC0".` |
| No matched readable image details | `Missing image evidence. Verify Hardware ID "MTR-2024-001" and serial number "ABC0" against the original photo.` |
| Unassigned photo | `No matching PDF record identified. Verify the equipment identifiers.` |

Missing image evidence is a verification finding, not proof that the equipment
has been lost. Conflicting or ambiguous identifiers request manual verification.
Two units of the same type keep separate rows; display/export does not deduplicate
them. Remarks generated here are specific to Comparison Tools. Manual Remarks in
Smart Capture remain unchanged.

Excel and PDF downloads use the same five columns and include matches. The report
has black cell borders and wrapped text; PDF headers repeat across pages. Export
uses the comparison-only `POST /api/compare/export` endpoint, which validates the
results and generates a download without cloud AI, database writes or uploads.
This report does not replace official accountability or other module templates.
If the PDF font cannot encode a character, export fails explicitly and Excel can
retain the original text; identifiers are not silently substituted.

The underlying result array still contains document/image values, statuses and
field notes, with an added `reportRow` presentation object. The existing frontend
history, Clear All and Proceed to Upload actions are retained. The comparison
renderer hides only the original per-field table while its five-column view is
available. No equipment records or storage uploads are created by extraction;
the existing frontend saves a successful comparison history entry as before.

## Association and identifiers

- Exact identifiers are compared within the same field. Formatting and case may
  differ; leading zeros and OCR-confusable characters such as `0`/`O` are not
  silently corrected.
- Complementary photos may combine when their identifiers identify the same
  document row. A unique readable equipment type/model is a weaker association
  with an explicit physical-unit review note.
- The same model on two document rows does not choose the first unit. Ambiguous
  or unmatched physical evidence is included separately with a blank document
  side. A hardware tag and serial pointing to different rows produce a warning.
- Conflicting photo values leave that field blank and list the candidates in its
  field notes. An explicitly read manufacturer S/N outranks an SNID fallback.
  Serial-only and tag-only photos that cannot identify one unit remain separate;
  the program does not guess that they belong together.
- CPU Adapter/LAD/charger follow the shared Laptop Adapter policy. Monitor Adapter
  stays distinct. A shared brand alone does not confirm a model-bearing
  description. Hardware identifiers retain their existing comparison rules.
- Remarks are not inferred as physical evidence.

## Reading, limits and cancellation

A recognized structured Excel table or five-column text PDF form is read locally
without a reference AI call. The PDF reader uses the installed PDF.js package,
not a shell program or cloud service. It assigns text by column position and
row, preserves identifier characters and empty cells, and excludes the form's
metadata and acknowledgement text. The supplied one-page accountability PDF
was verified to contain seven rows that can all be read this way.

The comparison-only browser adapter sends original PDF bytes instead of the
recovered frontend's flattened text so the server retains column geometry.
Multipart uploads already retain those bytes. Other input types and staged
upload files are unchanged. PDF.js is loaded dynamically from node_modules;
the generated CJS server bundle and other PDF export libraries remain separate.

The local reader accepts up to 20 MB / 30 pages / 100,000 text items. It rejects
ambiguous columns, overlapping identifiers, unsupported rotation or an
unrecognized continuation page rather than returning an incomplete expected
table. Image-only scans and unsupported layouts still use the existing complete
document reader when cloud reading is enabled and has allowance. When that is
unavailable, an explicit error is shown. This update does not guarantee local
reading of every PDF layout or add a renderer/OCR service for scanned PDF pages.

Evidence photos use existing local regional OCR and barcode label interpretation.
Database lookup values are not substituted for visible photo values. Cloud
assistance is optional and limited to the existing `INTAKE_AI_MAX_IMAGES_PER_REQUEST`
(default 2). There is no additional all-images cloud pass, model switching or
increase to worker parallelism or the shared request allowance. Reference calls
and image assistance consume that same installation budget. Recognized local
PDF/Excel reading consumes no provider allowance. An exhausted image-assistance
budget leaves local physical values available for comparison. Current owner limits
are 5 attempts/minute and 10/24 hours; provider limits remain separate.

Evidence is processed sequentially, with at most one comparison active per server
process. Exact duplicate evidence bytes are read once per request. Successful
source and image readings are cached in process memory for up to 24 hours,
scoped by employee and file content (20 source entries, 100 image entries).
Existing raw intake readings can be reused; reference-aligned results and barcode
repository records are not used as physical values. A manual retry may assist
previously unassisted unclear photos within the same per-request allowance;
failed assistance remains retryable. Restart clears these caches.

The optional `Accept: application/x-ndjson` protocol sends headers and progress
before OCR, heartbeats while reading, then one final result or explicit error.
Legacy JSON clients retain the original array/error format. The frontend adapter
is limited to the two comparison POST endpoints and the Comparison Tools page.
It returns streamed JSON to the recovered frontend so its old 90-second wait for
response headers no longer aborts normal multi-image reading. The compiled
frontend bundle is unchanged.

Local daily/minute allowance errors and cooldown now have distinct explanations.
The browser retains an explicit streamed error even when its transport reduces
stream errors to a generic "Failed to fetch" message. The request allowance,
private budget ledger and provider model are unchanged; no counters are reset.

The comparison has a 15-minute limit and can be cancelled. Leaving the page or
account also cancels the browser request. Cancellation stops subsequent work
after the current bounded OCR/provider call returns; it does not forcibly kill
shared OCR workers. A very large upload can still encounter the native client's
header timeout before it reaches the server. Retry after the current read ends
can reuse successful in-memory readings. The selected browser files are kept.

## Editable sources

| Responsibility | File |
| --- | --- |
| Field rules and result shape | `services/comparison.ts` |
| Safe physical association, progress and sequencing | `services/comparisonWorkflow.ts` |
| Local PDF table geometry and installed PDF.js loader | `services/comparisonPdf.ts` |
| Five-column values, English findings and comparison-only downloads | `services/comparisonReport.ts` |
| Optional streamed API response | `services/comparisonStream.ts` |
| Comparison route handlers and upload cleanup | `controllers/accountabilityController.ts` |
| Existing readers, bounded AI client and scoped caches | `server.ts` |
| Comparison-only browser adapter | `frontend-prebuilt/assets/ipas-comparison-progress.js` |
| Equipment-row presentation and scoped export button handling | `frontend-prebuilt/assets/ipas-comparison-report.js` |
| Comparison download routing | `routes/accountabilityRoutes.ts` |
| Adapter inclusion | `frontend-prebuilt/index.html` |

Smart Capture camera code, equipment grouping, ticket cameras, intake reference
alignment, exports and other modal implementations are not replaced by this
change. The shared general/identifier normalization functions are unchanged.

## Verification and installation

This report update follows the tested comparison and local-PDF corrections on
owner branch `refactor/modular-server`, last saved commit `7556cd6`. The report
update's server baseline is
`3b76e6c22ce06afb24b4c28c6a42b374536ff90cfa16cf00cd8b9583ba47ceef`.
Back up the six replacement files and generated server before copying the nine
report files. Keep unrelated staged `phase2b.py` and root
`ipas-ocr-label-check.mjs` outside the scoped commit.

Check the installed PDF.js Node reader before copying the correction. Its current
package supports Node >=20.19, >=22.13 or >=24 and includes optional native support
used by its Node loader. A missing dependency or unsupported Node version must
be resolved before relying on local PDF reading:

```bash
node --input-type=module -e 'await import("pdfjs-dist/legacy/build/pdf.mjs"); console.log("Local PDF reader: READY; Node " + process.version)'
```

```bash
node --import tsx --test tests/comparisonReport.test.ts tests/comparisonPdf.test.ts tests/comparison.test.ts tests/comparisonWorkflow.test.ts tests/comparisonStream.test.ts tests/referenceAlignment.test.ts tests/cameraSync.test.ts tests/captureAutofill.test.ts tests/captureStorageUpload.test.ts tests/equipmentLabels.test.ts tests/equipmentUnits.test.ts tests/visionValidation.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
npm run build:web
systemctl --user restart ipas.service
curl -sS --max-time 20 -w '\nHTTP %{http_code}\n' http://127.0.0.1:3000/api/health
```

Tests cover physical/reference separation, duplicates, ambiguous units, conflicts,
serial priority, assistance limits, progress, cancellation, legacy JSON, errors,
upload cleanup and the recovered browser workflow. Local extraction from the
actual supplied PDF was checked against all seven rows. A compiled API check
uses that PDF plus synthetic OCR responses with the 10-attempt temporary budget
already exhausted; all seven images are processed with zero provider requests.
This does not measure recognition accuracy on the owner's actual photographs.
Verify that live comparison after installation, including serials, blanks, extra
evidence and the existing export actions, before saving this update to GitHub.

Additional report checks cover the five-column view, exact English findings,
matching-row exports, significant identifier characters, repeated PDF headers,
literal Excel strings, bounded export input, download errors and navigation.
The renderer leaves source selection, camera, ticket and other modal handlers
in the recovered compiled frontend intact; the compiled bundle is unchanged.
