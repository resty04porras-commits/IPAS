# OCR and optional Gemini Vision assistance

This update keeps local OCR, barcode decoding, capture, export and persistence endpoints. It adds bounded Gemini assistance to incomplete or uncertain Smart Capture drafts and switches the app's shared Gemini transport to a single configured model. It does not install or replace an OCR engine, invoke Ollama in production, or introduce database schema changes.

## Processing

1. Uncached images run through the existing local OCR reader and barcode reader before cloud assistance.
2. Complete local equipment fields skip cloud assistance. Missing fields, a brand without a model, or explicit low-clarity/conflict notes are eligible for review.
3. Cloud use requires `IPAS_AI_MODE=hybrid`, a configured key and `INTAKE_AI_FALLBACK_ENABLED=true` for intake. The default is `local-only`. Unknown mode values also disable cloud transmission.
4. At most two images in one intake request are eligible by default. Each is sent separately, once, without model hopping or retries. The shared deadline is 20 seconds per cloud call.
5. Existing identifiers remain on disagreements. Vision may fill missing fields and extend a recognized brand with a proposed model. New identifiers, model additions and conflicts are marked as reviewable drafts. Product barcodes such as EAN/UPC are excluded from the serial field when decoded barcode evidence identifies their type. Explicit SNID values are excluded from manufacturer serials. Serial/product label values no longer inflate the manufacturer model description.
6. Timeout, quota, malformed output or unavailable budget storage retains the local result. Unreadable values remain blank for manual entry.
7. Successful drafts are cached with their review notes. Cloud-failure results are not permanently cached. Local barcode results are cached separately so the existing enrichment pass reuses the scan.

The existing frontend reads the response's `summary.message`, so review notices and conflict proposals appear with the scan result. Equipment fields remain editable. `notes` also travel with the records. Review notices are advisory: this change does not add a confirmation barrier to the existing save endpoint. The extraction endpoint itself does not save forms or write equipment data to the database. Review the image and draft before using the existing Save or Export actions.

Local OCR values are supplied to validation before reference alignment. Existing reference alignment and consolidation rules remain in place. Reference-supplied values and decoded barcodes alone do not establish independent verification of an equipment field; the summary states this when a reference was used.

## Configuration

Keep the API key in the ignored `.env` or `.env.local`, never in source or documentation. Existing `.env.local` values override `.env`.

For optional cloud assistance, set these non-secret values privately in the configuration file:

```dotenv
IPAS_AI_MODE=hybrid
GEMINI_MODEL=gemini-3.5-flash-lite
INTAKE_AI_FALLBACK_ENABLED=true
IPAS_AI_TIMEOUT_MS=20000
IPAS_AI_REQUESTS_PER_MINUTE=5
IPAS_AI_REQUESTS_PER_24H=10
INTAKE_AI_MAX_IMAGES_PER_REQUEST=2
```

For local-only processing:

```dotenv
IPAS_AI_MODE=local-only
```

Restart the user `ipas.service` after editing runtime configuration. Setting the intake fallback flag to false prevents every intake cloud-recovery branch, including partially readable images. The global mode also gates the existing document comparison and receipt Gemini calls. Those cloud-dependent operations can report unavailable in local-only mode; local OCR and barcode capture continue.

## Request budget and failure handling

- The app uses one configured Gemini model, defaulting to the model that passed the owner's real-image test: `gemini-3.5-flash-lite`. It does not automatically try other models after an error.
- All shared app Gemini calls use the same persistent request ledger, including comparison/document extraction and receipts. They do not use the old SDK retry/model-fallback loop.
- The default local cap is five attempts in a rolling minute and ten attempts in a rolling 24 hours. These are conservative application caps, **not promises about Google's actual quota**. The provider can reject a request sooner based on its request/token limits or account rules.
- Every reserved attempt counts before transmission, including timeout and failed provider responses. A client timeout does not prove the provider canceled processing or excluded the request from its quota.
- The ledger is `~/.local/state/ipas/cloud-ai-budget.json` under the service user's home directory. It contains timestamps and cooldown state, not images, keys or extracted identifiers. It uses mode `0600`, atomic replacement and an exclusive lock for concurrent writers. It survives app restarts.
- Only one cloud call is active per app process. Busy requests retain the local path instead of building an unbounded cloud queue.
- HTTP 429 pauses cloud calls for at least 15 minutes locally; an explicit daily quota error pauses them for 24 hours. Transient service/network/timeout failures pause immediate cloud sends for one minute. No automatic retry waits are added to the capture request.
- Missing, invalid or unreadable budget state fails closed for cloud use. A new ledger is created only when no ledger exists. An existing stale lock needs investigation while the app is stopped; do not clear the ledger to bypass a provider or application quota.
- These controls apply to the app transport. The separately invoked diagnostic benchmark scripts make their own explicit requests and are not counted in the app ledger. Avoid repeated diagnostics during normal use.

No paid billing is enabled by this update. Project tier, model access and provider quotas remain controlled by Google. The owner confirmed Free tier but the daily quota for the selected 3.5 Flash-Lite model still needs account-level verification.

## Validation

Automated source checks include local-only transmission prevention, persistent minute/24-hour budgets, simultaneous request handling, provider cooldowns, real AbortSignal cancellation, invalid/truncated structured responses, credential redaction, exact identifiers, product barcode rejection and reviewable conflicts. Existing OCR, HTTP client, worker, reference alignment, consolidation, comparison and export tests are retained.

Local compiled API fixtures exercise the real intake endpoint with synthetic OCR, barcode and Gemini responses. These validate control flow and compatibility; they are not real image-recognition benchmarks or owner-VM deployment tests.

Owner real-image baseline, before integration: the standalone Gemini 3.5 Flash-Lite diagnostic read `monitor.jpg` in 3.87 seconds and returned MONITOR, Acer K222HQL, MTR-2021-044 and MMT1LSS00983607E9B4220. The serial matched the earlier barcode decode. This is one successful fixture, not a general accuracy guarantee.

Official model/configuration references:

- https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
- https://ai.google.dev/gemini-api/docs/generate-content/thinking
- https://ai.google.dev/gemini-api/docs/generate-content/whats-new-gemini-3.8

## Owner checks after installing the source files

```bash
node --import tsx --test tests/cloudVision.test.ts tests/visionValidation.test.ts tests/intakeNormalization.test.ts tests/intakeConsolidation.test.ts tests/comparison.test.ts tests/referenceAlignment.test.ts tests/structuredAi.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
```

After choosing the configuration and restarting the service, check health and local OCR, then run one real intake scan. Confirm draft values, review notices, reference handling and the saved/exported fields. Preserve the unrelated `phase2b.py` and `ipas-ocr-label-check.mjs` work by staging/committing only this update's explicit files.
