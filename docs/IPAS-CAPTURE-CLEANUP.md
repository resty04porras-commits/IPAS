# Smart Capture removal and storage-upload cleanup

## Problem and behavior

The recovered React frontend's Captured Images trash button removed only the current browser row. The photo remained in the account's saved camera store and was restored by the camera sync script on reload. A second race allowed concurrent load/push/delete operations to persist stale snapshots.

This update connects the existing list's trash button to the existing per-event camera deletion API. The local React row is removed only after the server confirms the deletion. Failure keeps the row visible with a retry message.

A **Clear captured photos** button is shown in Smart Capture's Captured Images card. It snapshots the visible list and removes only matching non-ticket captures for the authenticated account, then removes the corresponding browser drafts. Saved content is matched against the preview bytes; filenames alone never authorize deletion. Newly arriving photos are retained, including new content sharing a selected filename. Unsynced local uploads are removed using React's existing handler. If a local preview differs from its saved copy (for example, a recompressed upload), deletion is blocked and the user can remove the saved original directly from Phone Camera instead.

The action removes capture photos and their associated local detail rows. It does not delete saved accountability forms, database records, reference documents, receipt tickets or another account's captures. It makes no OCR, Gemini or other AI requests.

## After uploading to storage / File Manager

The existing `/api/upload-to-nextcloud` flow snapshots the account's matching equipment captures before writing files. Only after **every WebDAV file upload succeeds** does it retire those captured copies from the camera store. Matching uses SHA-256 of the actual file contents, never filenames alone. New photos arriving during the upload, unuploaded photos, tickets and other accounts are retained. When duplicate destination filenames occur within a batch, only the final content at that destination is eligible for cleanup.

The remote files remain in Nextcloud. Existing accountability forms and PostgreSQL document records are not changed or deleted by cleanup. This change does not create database records for uploads that the existing upload flow only stores in Nextcloud.

The browser removes only matching captured drafts after receiving the server's successful-upload receipt or a corresponding saved-capture deletion event. This works when uploading from File Manager and returning to Smart Capture. Newly captured or attached photos are outside the upload's snapshot and remain available. Attaching images, scanning, exporting a form and merely opening File Manager do not count as successful uploads and do not clear photos.

If any upload fails, no captures in that batch are retired. If the remote upload succeeds but local capture cleanup fails, the upload still returns success with a separate warning; both saved files and captures are kept. Use **Clear captured photos** after checking the saved files to retry cleanup without re-uploading them.

Phone Smart Capture sends an original-file checksum alongside its smaller transmitted photo, allowing a later upload of the original phone file to retire the resized copy. Use the existing HTTPS address: browser SHA-256 needs a secure context. Older resized captures without this provenance, or content that has changed, are retained unless their actual bytes match the uploaded file; clear those manually after checking storage. On HTTP without browser hashing, refresh Smart Capture after upload to reflect completed server cleanup.

## Implementation

- `frontend-prebuilt/assets/ipas-capture-cleanup.js` provides the scoped toolbar and capture-phase delete integration. It uses the existing account session and camera APIs; it never clears all browser storage.
- `frontend-prebuilt/assets/ipas-cam.js` handles server deletion events, removes matching camera cards/local details and cancels pending reinjection for deleted event ids. Stale queued/polled capture events cannot reinsert the same deleted event during that browser session. Existing camera upload and new-capture routing remain available.
- `controllers/cameraSyncController.ts` serializes load/read/push/delete operations per account, commits persistence before acknowledging changes and broadcasts deletion to that account's live SSE clients. Failed persistence keeps the prior memory/disk state. Atomic writes use unique temporary filenames.
- The existing employee channel fallback is retained. Session/account mismatch checks continue to reject cross-account requests. No database schema, OCR, Vision or camera transport endpoint is replaced.
- The HTML entry point loads the new helper and updates the camera-script cache version. Both scripts must be deployed together with the backend controller.
- `controllers/documentRepositoryController.ts` invokes the optional capture lifecycle dependency wired in `server.ts`, after all storage writes succeed. Cleanup warnings do not turn completed uploads into upload errors.
- `frontend-prebuilt/assets/ipas-capture-cleanup.js` observes only the existing same-origin multipart storage-upload request and reads a cloned success response. It does not alter the request, consume the original response, infer success from a toast, or send any storage deletion request.
- `frontend-prebuilt/assets/ipas-smart-capture-camera.js` includes original-file provenance when preparing phone photos. It preserves existing image quality, camera controls and retry behavior.

Already open clients should reload after deployment to receive the new scripts. A fresh upload is allowed after a deletion, including an intentional reattachment of the same photo content.

## Verification

```bash
node --import tsx --test tests/cameraSync.test.ts
node --import tsx --test tests/captureStorageUpload.test.ts
node --check frontend-prebuilt/assets/ipas-capture-cleanup.js
node --check frontend-prebuilt/assets/ipas-cam.js
node --check frontend-prebuilt/assets/ipas-smart-capture-camera.js
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
npm run build:web
```

Backend tests cover persistence/reload, clearing seven selected captures, ticket/account isolation, simultaneous uploads/retries, cold-start/delete races, failed disk writes, corrupt storage and new uploads after clearing.

Storage-upload tests use a fake WebDAV client, temporary captures and an isolated database configuration that rejects all attempted database queries. They cover full success, partial/connection failures, unconfirmed writes, cleanup failure, original/resized phone matching, same-name different-content files, duplicate destinations, new captures during uploads and strict session-account scoping. No real storage credentials, owner files, database records or cloud AI are used.

Chromium checks use the actual recovered frontend and camera scripts with a synthetic authenticated local camera API and temporary store: restore seven photos, clear, reject a stale SSE capture, reload empty, accept a fresh capture, retain it on deletion failure, and delete it successfully on retry. These checks do not use owner images or external AI.

After deployment, open the actual Smart Capture list, click **Clear captured photos**, wait for success, then refresh/reopen and verify the list stays empty. Confirm that a newly captured photo still arrives normally.

Stage only this update's explicit files when committing. Preserve the unrelated `phase2b.py` and `ipas-ocr-label-check.mjs` work.
