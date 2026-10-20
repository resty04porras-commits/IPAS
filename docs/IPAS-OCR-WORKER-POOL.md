# OCR worker pool: editable source guide

## What changed

The legacy OCR worker pool now lives in `services/ocr/workerPool.ts`.
`server.ts` creates one pool and passes its `submit` function to the existing
shared OCR recognizer. Legacy startup still uses the pool's `prewarm` function.

The server decreases from 7,257 to 6,832 lines, a reduction of 425 lines.
The moved protocol types and worker functions retain their existing behavior.
The module uses the same native Node dependencies; no models or packages are
installed as part of this refactor.

The current normal engine remains the Python EasyOCR HTTP service. This legacy
worker pool is used by the existing legacy mode and service fallback. Historical
`PaddleOCR` function names, environment variables, and diagnostic messages remain
compatible; moving them does not install or enable a new PaddleOCR model.

## Where to edit each part

Press **Ctrl+P** in VS Code and enter the relevant path:

| Task | Source file |
| --- | --- |
| Worker Python selection, JSON-lines protocol, pool scheduling, retries, warm-up | `services/ocr/workerPool.ts` |
| Python HTTP service startup, health checks, recovery, shutdown | `services/ocr/serviceLifecycle.ts` |
| HTTP upload, HTTP OCR/barcode responses, HTTP request timeouts | `services/ocr/httpClient.ts` |
| Choosing the service or worker and handling fallback | `services/ocr/recognizer.ts` |
| Shared OCR snapshot normalization | `services/ocr/snapshots.ts` |
| Current HTTP OCR model and preprocessing | `ocr-service/ocr_api.py` |
| Python legacy worker model and preprocessing | `tools/paddle_ocr_worker.py` |
| Barcode decoding for the HTTP service | `ocr-service/barcode_reader.py` |
| Environment defaults, module wiring, field extraction, remaining routes | `server.ts` |

For daily coding, edit these normal source files. Build the backend after changing
TypeScript; `dist-server/server.cjs` is generated output.

## Preserved worker behavior

- Importing the module or creating an unused pool starts no worker.
- `PADDLE_OCR_PYTHON`, the platform virtualenv, and the platform Python fallback
  keep their original selection order. Python still receives `-u` and the same
  `tools/paddle_ocr_worker.py` path.
- UTF-8, disabled user-site packages, model-source-check, and cache environment
  settings are preserved.
- Each slot shares its startup promise. Requests carry unique IDs and use the
  existing ready/startup-error/recognition JSON-lines protocol.
- Base64 image content, full/probe mode, crop rectangles, and batch keys are
  preserved. Snapshot text, confidence, dimensions, and boxes use the same
  normalization helper.
- Partially received lines remain buffered. Malformed output is logged and
  unrelated response IDs do not replace a pending request's result.
- The pool reuses the least busy existing worker, opens another configured slot
  when needed, and retains explicit worker-slot selection.
- Startup failure, recognition failure, process exit, and unwritable input keep
  their original rejection paths. Failed recognition does not become an empty
  successful scan.
- Request timeouts keep their retry limit and optional worker reset. Probe calls
  can keep reset disabled. An old child cannot clear a replacement's pool slot.
- Reset rejects pending work, requests process termination, and retains the
  existing delayed SIGKILL escalation when needed.
- Warm-up still primes every slot once, coalesces simultaneous warm-up calls,
  and honors `DISABLE_PADDLE_OCR=true` for prewarming.

The pool owns legacy worker state. The separate HTTP service lifecycle continues
to own the managed Python HTTP service. This extraction adds no new application
shutdown handlers or OCR engine defaults.

## Files to copy

| Download | Destination on the server |
| --- | --- |
| `workerPool.ts` | `/srv/IPAS-PUBLISH/services/ocr/workerPool.ts` |
| `ocrWorkerPool.test.ts` | `/srv/IPAS-PUBLISH/tests/ocrWorkerPool.test.ts` |
| `server.ts` | `/srv/IPAS-PUBLISH/server.ts` |
| `IPAS-OCR-WORKER-POOL.md` | `/srv/IPAS-PUBLISH/docs/IPAS-OCR-WORKER-POOL.md` |

The full replacement `server.ts` is based on owner commit `1e605c6`. Check the
current server's SHA256 before replacing it:

```text
3ed208c347ee0b337c29f4ab6a97cb9c7c63a31792cb532c245b4cce04de8665
```

If the hash differs, merge this extraction into the newer source. Back up both
the current `server.ts` and `dist-server/server.cjs` first. The review diff and
source hashes are supplied separately; there is no archive or automatic installer.

## Verification and deployment

Run in `/srv/IPAS-PUBLISH` after copying the source:

```bash
node --import tsx --test tests/ocrWorkerPool.test.ts tests/ocrServiceLifecycle.test.ts tests/ocrHttpClient.test.ts tests/ocrRecognizer.test.ts tests/ocrRoutes.test.ts tests/documentRepositoryRoutes.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
```

The worker tests use real lightweight Node child processes that implement a
controlled version of the Python protocol. They check startup, exact inputs,
concurrency, batch crops, scheduling, failure, timeout/reset/retry, warm-up,
Python selection, and integration with the shared recognizer. They do not load
or benchmark the actual legacy PaddleOCR model.

Full-application checks use a Python protocol fixture to verify legacy mode and
HTTP-service fallback through OCR v2, asset extraction, and receipt extraction.
Additional full-app checks cover the configured HTTP service and real cached
EasyOCR/ZXing inference on the original monitor image. See `VERIFICATION.json`
for the completed isolated-environment results and their scope.

Restart `ipas.service` after the checks pass. Verify `/api/health`, then send the
monitor photo to `/api/ocr-v2` and compare text and both decoded barcode values to
the previous result. The owner's VM must be verified separately from the cloud.

OCR accuracy, image compression, camera behavior, database records, and HTTPS
configuration are outside this structural change. Remaining server field
extraction and other modules are candidates for later steps.
