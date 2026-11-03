# Automatic Smart Capture equipment drafts

When a photo appears in Smart Capture, IPAS automatically reads its equipment labels and fills **Components, Description, Hardware ID and Serial** in the equipment table. **Remarks starts blank and is manual input only.** The existing Modify action lets the operator correct the four extracted fields. Remarks can also be entered directly in the table.

The filename shows queued/reading/completed/review status. Unreadable values remain blank. A failed read keeps the image and offers **Retry reading**; retries are explicit rather than automatic cloud retries. Existing OCR, barcode reading, optional Gemini assistance, request budgets and cloud timeouts continue to apply. These values remain drafts and still need comparison with the original image before saving or export; this update makes no claim of guaranteed recognition accuracy.

## Equipment units and the searchable picker

### Phone capture steps and counters

All equipment camera actions (**Equipment**, **Use Phone Camera**, **Open Camera**, and **Add More from Camera**) use the same searchable equipment picker. The phone shows stable labels such as **Monitor 1** and **Monitor 2**, separate from the raw Components value used by the existing form/export templates. After a capture, choose **Continue [unit] · Capture N/4**, **Next unit / component**, or **Review details**. One clear photo is enough when it contains all fields; three or four photos are not mandatory.

Each selected physical unit accepts at most **four photos**. The UI reserves slots for local/offline photos before uploading, and the server enforces the limit within its existing per-account mutation queue. A retry of the same stored photo does not consume another slot. At four, Continue and the live preview's Capture Photo are disabled for that unit; Next unit remains available. Removing an unneeded photo frees a slot. Previously saved groups that already contain more than four photos are retained and cannot accept more until their count is below four.

The server assigns unit numbers and photo positions, persists them with captures, and returns versioned progress through push/SSE/pending. `/api/cam/pending?unitsOnly=true` provides unit counts and event identities without image bytes so a reloaded phone can show the same units. Client-supplied numbers or counts do not authorize extra captures. Opening or cancelling a picker does not consume a photo slot. The phone's native camera is launched from a user click; the browser displays the unit/capture step before and after the native capture. Existing live camera preview stays available while continuing a unit.

Counters are scoped to the current account's active captured-image list. The numbers distinguish physical units in the capture workflow; the exported Components/Description/Hardware ID/Serial/Remarks columns and their values keep their existing format. Tickets bypass this picker, continuation panel and four-photo rule. Manual editing, Remarks, S/N priority, row deletion/restoration, storage cleanup, shared OCR caching and cloud-budget limits remain in effect.

Before **Open Camera**, **Use Phone Camera**, the mobile **Equipment** button or an equipment photo attachment, choose one of the 20 searchable equipment types. Choose **New unit** for a different physical item, including a second monitor of the same model. To photograph another sticker of the same item, choose **Add photo to** its current unit or an existing unit in the picker. Live-camera captures continue in the selected unit until the camera is stopped and another unit is selected. Tickets retain their existing camera flow.

The selected equipment type and stable unit ID accompany each saved photo through phone push, SSE, pending replay and local automatic-reading responses. The server persists these fields with equipment captures. Reading caches continue to depend on account and actual image bytes, not the unit hint. An existing saved capture's stored grouping takes precedence over request hints. Old photos without unit metadata retain their previous grouping; they are not retrospectively assigned by category alone.

The table and explicit export combine complementary fields only within the chosen physical unit. Readable manufacturer S/N takes precedence over its SNID fallback regardless of photo order. Different manufacturer serials or company tags within that unit leave the conflicting field blank and identify it for **Modify**. Manual edits, including deliberate blanks, take precedence over automatic results. CPU Adapter remains a picker choice and shares the existing **LAPTOP ADAPTER** output category; Monitor Adapter remains separate.

Deleting a grouped draft row excludes every member photo from its data row, while retaining the images and saved records. **Restore row** on a member restores that unit's excluded photos using cached reads where available. Photo deletion/storage cleanup still applies to exact photo identities. Two explicitly selected units stay separate in exports even if their OCR values happen to coincide.

## Field rules

- CPU Adapter, Laptop Adapter/Adaptor, LAD and charger use the **LAPTOP ADAPTER** category. Unrelated categories and the existing manual component choices remain available. A common category does not prove two photos are the same physical unit; distinct identifiers remain distinct rows.
- Prefer a readable **Serial Number / Serial No. / S/N / SN** over SNID, regardless of which OCR region had a higher score. When no readable manufacturer S/N is available, an explicitly labeled numeric **SNID** can fill Serial as a fallback. Its source is included in the reading status/notes. Product codes, EAN/UPC, company tags, model and version values do not become a fallback serial.
- Description includes the visible **brand, model and version**. Labels with a model value on the next line are supported. `NO` and `MODEL NO` alone are not descriptions. No unseen brand/model/version is invented; manual correction remains available through **Modify**.
- The trash icon at the end of a data row removes that **draft row**, while keeping the captured photo, remote files and saved database records. It also removes the corresponding native form rows used for staging/export, and ignores late automatic results for those rows. Exclusions are stored for the current account in this browser (up to 200 identity keys, no image data), so refresh does not silently recreate them. **Restore row** reuses a cached draft when available; manually saving the photo's Modify form can also restore it.

## Earlier local results

The frontend opts into an authenticated NDJSON response from `/api/intake/auto-extract`. The server publishes full-image local fields before targeted crop scans, then local enriched fields before optional cloud refinement, followed by the final draft. Existing JSON clients continue to receive the final JSON response. Manual edits made between these stages remain authoritative, and Remarks stays manual throughout. Explicit **Retry reading** bypasses both the automatic-draft cache and the underlying intake/barcode caches for that image; ordinary reloads and **Restore row** keep using cached results.

Targeted crops are restricted to missing fields (including brand-only descriptions), and almost identical crop rectangles are read once. A full-image result containing an SNID fallback also requests the existing serial and manufacturer-label crops, even when no S/N keyword was detected in the first pass. A remaining SNID fallback is eligible for the existing bounded cloud check, subject to all configured limits. SNID stays available if S/N remains unreadable or the budget/service is unavailable. No OCR model, image-quality setting, cloud quota limit or worker concurrency is removed or increased by this update.

The log records `firstDraftMs` and `totalMs` for each automatic read. Earlier visible fields do not guarantee a shorter final recognition time on every image; measure both timings on the actual VM. A browser-disconnected read can finish in the bounded shared server queue so another device or an explicit restore can reuse its result.

## Capture and extraction flow

- Equipment/phone photos continue to use the existing camera transport and capture list. During page transitions, desktop injection now targets Smart Capture's exact file input or waits until it is ready.
- Phone Smart Capture emits its confirmed saved-capture identity after sending the resized image. The phone and laptop request the same saved image from the authenticated account, so the server shares one in-flight read and one cached draft.
- The authenticated `/api/intake/auto-extract` endpoint accepts either the account's saved equipment `eventId` or one local evidence image. Tickets and another account's captures cannot be selected. Temporary uploaded evidence files are removed after processing.
- `services/captureAutofill.ts` uses the existing local OCR/barcode and controlled Gemini extraction pipeline. It runs one extraction at a time, accepts at most four distinct pending reads, and caches up to 100 drafts for 24 hours within that running server process. Requests for the same account and image bytes share the pending/cached result. Restarting the process clears this draft cache; the persistent cloud-request budget remains in effect.
- Only the four requested fields are accepted from extraction. Upstream Remarks is discarded. Explicitly blank Remarks also remains blank through the accountability export sanitizer.
- The editable frontend helper commits through the existing Modify/Save handler, keeping the native form state, table and export payload consistent without changing the recovered compiled React bundle. Automatic commits finish synchronously before painting a dialog. Manual field edits made while reading take precedence; the helper waits while the operator has a Modify dialog or Remarks input open.
- Two units with the same component name but different identifiers remain separate table rows. Multiple photos with the same component and exact identifier combination may share one display row. A manual Remarks value applies to that displayed asset row.
- Deleting a photo cancels its browser work and prevents late results from adding its row again. Switching accounts invalidates the prior account's work. Reading that completes while another menu is open can be applied when returning to Smart Capture.

No automatic accountability/database save, export or Nextcloud upload is performed. The previously installed delete/clear and post-storage-upload cleanup remain separate actions. Comparison Tools is unchanged by this update and will be handled separately.

Use the existing HTTPS IPAS address, including on the phone, so camera access and SHA-256 image identity are available. On a phone, automatic reading waits for confirmation that the photo was sent to the account; if sending fails, keep the photo and use the existing Retry Send or the explicit Retry reading action.

## Verification

```bash
node --import tsx --test tests/captureAutofill.test.ts tests/cameraSync.test.ts tests/captureStorageUpload.test.ts
node --import tsx --test tests/equipmentUnits.test.ts tests/equipmentLabels.test.ts tests/visionValidation.test.ts
node --check frontend-prebuilt/assets/ipas-equipment-units.js
node --check frontend-prebuilt/assets/ipas-capture-autofill.js
node --check frontend-prebuilt/assets/ipas-cam.js
node --check frontend-prebuilt/assets/ipas-smart-capture-camera.js
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
npm run build:web
```

Backend tests cover four-field drafts with blank Remarks, phone/laptop sharing, cache isolation/expiry, bounded serialized work, explicit retry, partial results, failures, session scoping, ticket rejection, removed captures and temporary-file cleanup. Chromium checks use the real recovered UI and capture/autofill controllers with fake extraction and synthetic images; no owner files, real database records, paid storage or external AI are used.

The row deletion bridge matches exact capture IDs in the recovered native form state and invalidates staged packages/cached exported workbooks before removing a row. Its empty-state fallback is specific to the tested compiled frontend; repeat the browser deletion/restoration, explicit export and staging checks if that bundle is upgraded. The compiled React bundle itself is unchanged.

After deployment, reload both phone and laptop on HTTPS, capture one clear equipment label and leave Smart Capture open. Confirm that the image arrives, its reading status completes, the four fields populate automatically, and Remarks stays blank until typed. Compare values with the actual label and test a manual correction. The image does not disappear merely because reading succeeded.
