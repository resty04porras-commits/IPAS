# Structured AI responses: editable source guide

## Change

Structured-response parsing, upstream error extraction, retry classification,
transient backoff, and configured-model fallback now live in
`services/structuredAi.ts`. The server creates one helper and imports its shared
error functions for the existing extraction callers and controllers.

`server.ts` decreases from 6,633 to 6,473 lines, a reduction of 160 lines.
The existing model list and its `GEMINI_MODEL` override remain in the server.
The extraction prompts, schemas, account configuration, and API-key handling
retain their existing owners. The already-installed Google GenAI SDK is used.

## Daily source editing

Press **Ctrl+P** in VS Code and enter the path for the part you want to edit:

| Task | Source file |
| --- | --- |
| JSON response parsing, upstream error messages, retries, model fallback | `services/structuredAi.ts` |
| Configured model list, prompts, schemas, extraction business logic | `server.ts` |
| Preparing uploaded files and assembling their text/image/PDF source parts | `services/uploadedSources.ts` |
| Local OCR engine selection and fallback | `services/ocr/recognizer.ts` |
| Local OCR HTTP transport and barcode HTTP fallback | `services/ocr/httpClient.ts` |
| Python HTTP service lifecycle | `services/ocr/serviceLifecycle.ts` |
| Legacy OCR worker scheduling | `services/ocr/workerPool.ts` |
| One-shot local barcode process | `services/ocr/barcodeWorker.ts` |

Edit the source, build the backend, then restart after validation.
`dist-server/server.cjs` is generated output.

## Preserved behavior

- Plain and fenced JSON parsing uses the same normalization and `JSON.parse`.
  Values and identifiers are not corrected or reformatted by this helper.
- Empty or malformed structured JSON retains `InvalidStructuredResponseError`,
  the bounded 500-character diagnostic snippet, and the original parsing cause.
- Upstream error text retains its existing nested-message extraction, fallback,
  and rate-limit/unavailable classifications.
- The transient retry wrapper keeps its six-call default, its original error on
  exhaustion, and backoff of 2,000 ms multiplied by 1.5 after each failed attempt.
  Permanent errors still fail immediately. SDK-internal behavior is unchanged.
- Structured calls keep the same model order, contents/parts, response schema,
  `application/json` response MIME, and 8,192-token output setting.
- Malformed structured output still has three attempts per configured model.
  Retryable failures still move to the next model; the last model's failure
  retains its original error. Permanent API errors do not silently switch models.
- Missing response text retains the existing `[]` default. Parsing does not add
  a new response-schema validator.
- Importing or creating the helper does not make an AI request. The server's
  existing callers decide when to invoke the configured SDK.

The factory accepts a logger and wait function. Production uses console logging
and real timers. Tests record the wait durations without spending time waiting
for a simulated outage.

## Files to copy

| Download | Destination |
| --- | --- |
| `structuredAi.ts` | `/srv/IPAS-PUBLISH/services/structuredAi.ts` |
| `structuredAi.test.ts` | `/srv/IPAS-PUBLISH/tests/structuredAi.test.ts` |
| `server.ts` | `/srv/IPAS-PUBLISH/server.ts` |
| `IPAS-STRUCTURED-AI.md` | `/srv/IPAS-PUBLISH/docs/IPAS-STRUCTURED-AI.md` |

The replacement server is based on owner commit `390cdeb`. Verify the current
server's SHA256 before replacing it:

```text
0d3e0edc01f79b945de1256b73114c234195c514b9b552f165018ea81e3357df
```

If it differs, merge the isolated refactor into the newer source. Back up both
the existing source and `dist-server/server.cjs` before replacing or building.
Individual source hashes and the review diff are supplied separately.

## Checks and test scope

Run in `/srv/IPAS-PUBLISH` after copying:

```bash
node --import tsx --test tests/structuredAi.test.ts tests/uploadedSources.test.ts tests/barcodeWorker.test.ts tests/ocrWorkerPool.test.ts tests/ocrServiceLifecycle.test.ts tests/ocrHttpClient.test.ts tests/ocrRecognizer.test.ts tests/ocrRoutes.test.ts tests/documentRepositoryRoutes.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
```

The new tests cover valid/malformed responses, error envelopes, retry limits and
delays, permanent errors, separate response/transport retry budgets, model order,
output settings, and identifier preservation. A genuine SDK instance sends
structured requests to a local HTTP fixture using a fake test key, exercising
its normal request serialization and response parsing through model fallback.

These AI tests do not contact Google, spend API quota, or establish that an
external account or configured model is currently available. Separate compiled
application checks cover existing OCR v2, asset/receipt extraction, file upload
handling, and the genuine cached EasyOCR/ZXing path with the monitor photo.
See `VERIFICATION.json` for completed isolated checks and their scope.

After the checks pass, restart `ipas.service`, check `/api/health`, and send the
monitor image to `/api/ocr-v2`. Compare its text/confidence and decoded serial/EAN
with the previous response. Verify the owner's VM separately and keep unrelated
staged files out of the commit. Other server modules remain for later extraction.
