# OCR service lifecycle: editable source guide

## What changed

The Python HTTP OCR service lifecycle now lives in
`services/ocr/serviceLifecycle.ts`. `server.ts` creates one lifecycle owner and
passes its readiness function to the existing OCR HTTP client. The health route
uses the same owner's health check.

This separates another 148 lines from `server.ts`: 7,405 to 7,257 lines.
The files are normal editable TypeScript source. There is no archive installer.

## Where to edit

In VS Code, press **Ctrl+P**, then enter one of these paths:

| Change | Source file |
| --- | --- |
| Python selection, service startup, readiness, recovery, shutdown | `services/ocr/serviceLifecycle.ts` |
| HTTP image upload, OCR/barcode response handling, request timeout | `services/ocr/httpClient.ts` |
| OCR engine selection and fallback between service and legacy worker | `services/ocr/recognizer.ts` |
| OCR snapshot normalization | `services/ocr/snapshots.ts` |
| Python OCR model and image preprocessing | `ocr-service/ocr_api.py` |
| Barcode decoding | `ocr-service/barcode_reader.py` |
| Environment defaults, module wiring, legacy worker pool, field extraction | `server.ts` |

`dist-server/server.cjs` is generated output. Edit the source files, then build
the backend before restarting the running application.

## Preserved lifecycle behavior

- The configured engine still determines whether the HTTP service is used.
  Legacy readiness does not start a managed Python HTTP service.
- A healthy service is reused. A service started independently is not owned or
  killed by this module.
- Health uses `/health`, HTTP success, `status: "ok"`, and `modelLoaded !== false`.
  Existing services that omit `modelLoaded` remain compatible.
- Health probes keep their abort timeout, including while reading response JSON.
- When auto-start is disabled, an unhealthy service still reports its existing
  unavailable-service error.
- Concurrent readiness calls share the existing startup promise and one child.
  Readiness still polls at one-second intervals using the configured deadline.
- The configured `OCR_SERVICE_PYTHON` takes precedence. The Windows and POSIX
  virtualenv candidates and platform Python fallback keep their original order.
- Startup still runs `-m uvicorn ocr_api:app --host ... --port ...` in
  `ocr-service/`, inherits the process environment, and sets `PYTHONUTF8=1`.
- Service output still goes to the existing rotating `ocr.log` logger and console.
- An unexpected child exit clears startup state and schedules the existing
  two-second recovery. Intentional shutdown does not schedule recovery.
- Process exit, SIGINT, and SIGTERM still stop an owned service. Signal exit
  codes remain 130 and 143.

Lifecycle state belongs to the single factory instance. Importing the module
does not start Python, register process handlers, or load an OCR model.

## Files to copy

| Download | Destination on the server |
| --- | --- |
| `serviceLifecycle.ts` | `/srv/IPAS-PUBLISH/services/ocr/serviceLifecycle.ts` |
| `ocrServiceLifecycle.test.ts` | `/srv/IPAS-PUBLISH/tests/ocrServiceLifecycle.test.ts` |
| `server.ts` | `/srv/IPAS-PUBLISH/server.ts` |
| `IPAS-OCR-SERVICE-LIFECYCLE.md` | `/srv/IPAS-PUBLISH/docs/IPAS-OCR-SERVICE-LIFECYCLE.md` |

The complete replacement `server.ts` is based on owner commit `ee61d19`.
Before replacing it, check its current SHA256:

```text
3d16c841e2a77797cf74bde6124955442a980590c38479e7877a64fb16a2f3b6
```

If it differs, merge the isolated lifecycle change into the newer source. Keep a
backup of the current `server.ts` and `dist-server/server.cjs` before replacing
or rebuilding either file. `server-changes.diff` is supplied for review.

## Checks after copying

Run in `/srv/IPAS-PUBLISH`:

```bash
node --import tsx --test tests/ocrServiceLifecycle.test.ts tests/ocrHttpClient.test.ts tests/ocrRecognizer.test.ts tests/ocrRoutes.test.ts tests/documentRepositoryRoutes.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
```

Restart `ipas.service` only after the checks pass, then verify `/api/health` and
an actual image request to `/api/ocr-v2`. Compare OCR text and barcode candidates
to the previous result. The temporary Node memory limit applies only to that
TypeScript-check command, matching the owner's successful check on the 6 GiB VM.

## Verification scope

The lifecycle tests use local HTTP endpoints and lightweight Node child fixtures
instead of downloading or loading OCR models. They cover readiness compatibility,
timeouts, external-service ownership, concurrent startup, process options, logs,
recovery, Python selection, startup failure, and actual process shutdown signals.

Separate full-application checks exercise OCR v2, intake, and liquidation using
controlled OCR responses. A further isolated full-app test uses the genuine
cached EasyOCR model, ZXing, and the owner's original monitor image, with the
compiled Node application owning the Python service startup and shutdown.

This is a structural refactor. Recognition accuracy and the image processing
pipeline are unchanged. The original monitor OCR still misses some characters;
its CODE_128 serial and EAN remain separate decoded candidates.

The complete `server.ts` modularization is still in progress. The legacy worker
pool and field extraction logic are candidates for subsequent steps.
