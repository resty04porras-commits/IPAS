# Local barcode worker: editable source guide

## Change

The one-shot local barcode worker now lives in `services/ocr/barcodeWorker.ts`.
`server.ts` creates the worker client and gives its `scan` function to the existing
OCR HTTP client. The server decreases from 6,832 to 6,735 lines, a reduction of
97 lines. The worker functions retain their previous behavior after dependency
and type renaming.

The local OpenCV process is an existing compatibility fallback when the OCR HTTP
service returns HTTP 404 for `/barcode`. The current Python HTTP barcode service
and its ZXing decoder remain the normal path. No model, package, database, camera,
or HTTPS configuration is changed by this extraction.

## Daily source editing

Press **Ctrl+P** in VS Code and enter the path for the part you want to edit:

| Task | Editable file |
| --- | --- |
| Local barcode Python selection, process timeout, input/output handling | `services/ocr/barcodeWorker.ts` |
| Existing OpenCV barcode image decoding in the local process | `tools/barcode_scan_worker.py` |
| HTTP barcode response handling and deciding when to use the local fallback | `services/ocr/httpClient.ts` |
| ZXing and OpenCV barcode decoding for the HTTP service | `ocr-service/barcode_reader.py` |
| Legacy OCR worker protocol and request scheduling | `services/ocr/workerPool.ts` |
| Python HTTP OCR startup, health checks, recovery, shutdown | `services/ocr/serviceLifecycle.ts` |
| OCR engine selection and recognition fallback | `services/ocr/recognizer.ts` |
| Reference-record lookup and remaining server business logic | `server.ts` |
| Barcode response types | `types/barcode.ts` |

Edit source files, then build the backend. `dist-server/server.cjs` is generated
output and is not the daily editing target.

## Preserved behavior

- Creating the worker client starts no child process. Unsupported text, PDF, and
  spreadsheet inputs keep their existing image-only failure response.
- `BARCODE_SCAN_PYTHON` has precedence over `PADDLE_OCR_PYTHON`, followed by the
  platform virtualenv and platform Python fallback.
- The process still receives `-u` and `tools/barcode_scan_worker.py`, inherits the
  environment, and sets the existing UTF-8 and disabled-user-site flags.
- Each image scan uses a separate process and sends the same base64 image and
  MIME type as one JSON payload, then closes stdin.
- Output is accumulated until the process closes. Default and per-call timeouts,
  forced termination, process errors, malformed JSON, and missing-output errors
  keep their existing behavior.
- A valid failure JSON response from the Python script remains a failed scan,
  including when the script exits nonzero after reporting the failure.
- Barcode trimming, candidate types/points, default messages, and candidate arrays
  remain compatible. The transport sets `matched: false` and `record: null`;
  inventory matching remains a separate operation using actual reference records.
- The HTTP client still invokes this local worker for `/barcode` HTTP 404 only.
  Other service failures retain their existing handling.
- A local barcode failure remains optional for OCR v2; successful OCR is not
  discarded because the optional barcode operation failed.

## Files to copy

| Download | Destination |
| --- | --- |
| `barcodeWorker.ts` | `/srv/IPAS-PUBLISH/services/ocr/barcodeWorker.ts` |
| `barcodeWorker.test.ts` | `/srv/IPAS-PUBLISH/tests/barcodeWorker.test.ts` |
| `server.ts` | `/srv/IPAS-PUBLISH/server.ts` |
| `IPAS-BARCODE-WORKER.md` | `/srv/IPAS-PUBLISH/docs/IPAS-BARCODE-WORKER.md` |

The full `server.ts` is based on owner commit `7a3ec71`. Before replacing it,
verify its current SHA256:

```text
7bbc4de3c96d3dffc1c5a07767c63b987e9fb1fcfdd31c3646f9b16412193b98
```

If the hash differs, merge the isolated change into the newer source. Back up
both the current source and `dist-server/server.cjs` before copying or building.
The source hashes and review diff are supplied as separate files. No archive or
automatic installer is used.

## Validation and deployment

Run in `/srv/IPAS-PUBLISH` after copying:

```bash
node --import tsx --test tests/barcodeWorker.test.ts tests/ocrWorkerPool.test.ts tests/ocrServiceLifecycle.test.ts tests/ocrHttpClient.test.ts tests/ocrRecognizer.test.ts tests/ocrRoutes.test.ts tests/documentRepositoryRoutes.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
```

The new tests use actual lightweight Node child processes to exercise the
one-shot protocol, exact image input, response preservation, Python selection,
process failure, timeout, concurrency, and the HTTP client's local fallback.
These protocol fixtures do not claim real image recognition accuracy.

Separate isolated checks compare the new module against direct invocation of
the original Python/OpenCV script, test the compiled application with a controlled
Python barcode fixture and a missing HTTP endpoint, and exercise the normal
EasyOCR/ZXing path with the original monitor image. See `VERIFICATION.json` for
the completed checks and their scope. Decoder limitations remain unchanged.

After checks pass, restart `ipas.service`, verify `/api/health`, then test the
monitor image with `/api/ocr-v2` and compare OCR text/confidence and both barcode
values with the previous response. The owner's VM deployment requires its own
verification. Keep unrelated staged files out of the commit.

The rest of `server.ts`, including field extraction and other business logic,
remains available for subsequent modularization steps.
