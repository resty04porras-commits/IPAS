/* Durable removal for the recovered Smart Capture photo list. */
(function () {
  "use strict";
  if (window.__ipasCaptureCleanupInstalled) return;
  window.__ipasCaptureCleanupInstalled = true;
  var busy = false;
  var replay = new WeakSet();
  var removedEvents = new Set();
  var statusText = "";
  var lastError = false;
  var scheduled = false;
  var knownPhotos = new Map();
  var uploadRemovals = [];
  var flushingUploads = false;
  var uploadNotice = null;

  function employeeId() {
    try { return String((JSON.parse(localStorage.getItem("icc_user") || "null") || {}).employeeId || ""); }
    catch (_) { return ""; }
  }
  async function digestPreview(url) {
    if (!window.crypto || !window.crypto.subtle || !/^(blob:|data:image\/)/i.test(url)) return null;
    try {
      var response = await fetch(url);
      if (!response.ok) return null;
      var blob = await response.blob();
      if (blob.size > 30 * 1024 * 1024) return null;
      var hash = await window.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
    } catch (_) { return null; }
  }
  function rememberPhotos() {
    var current = new Map();
    var owner = employeeId();
    for (var button of buttons()) {
      var preview = previewOf(button);
      var old = knownPhotos.get(preview);
      current.set(preview, old && old.empId === owner ? old : {
        name: nameOf(button), preview: preview, empId: owner, digest: digestPreview(preview),
      });
    }
    knownPhotos = current;
  }
  async function queueUploadedPhotos(snapshots, hashes, owner) {
    if (!owner || employeeId() !== owner) return;
    for (var snapshot of snapshots) {
      if (snapshot.empId === owner && hashes.has(await snapshot.digest)) uploadRemovals.push(snapshot);
    }
    schedule();
  }
  async function flushUploadedPhotos() {
    if (busy || flushingUploads || !active() || !uploadRemovals.length) return;
    flushingUploads = true;
    try {
      var pending = uploadRemovals.splice(0);
      var removed = 0;
      for (var snapshot of pending) {
        if (snapshot.empId !== employeeId()) continue;
        if (removeVisible(snapshot.name, snapshot.preview)) removed += 1;
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      if (removed) message("Uploaded photos were removed from this capture list. The saved files and records were kept.", false);
    } finally { flushingUploads = false; if (uploadRemovals.length) schedule(); }
  }
  function renderUploadNotice() {
    var heading = document.querySelector("#root header h2");
    var node = document.getElementById("ipas-capture-upload-status");
    var show = uploadNotice && heading && employeeId() === uploadNotice.empId &&
      ["File Manager", "Uploaded Tickets", "Upload TER"].includes(heading.textContent.trim());
    if (!show) { if (node) node.remove(); return; }
    if (!node) {
      node = document.createElement("p");
      node.id = "ipas-capture-upload-status";
      node.setAttribute("role", "status");
      node.setAttribute("aria-live", "polite");
      node.style.cssText = "margin:1rem 1.5rem 0;padding:.8rem 1rem;border:1px solid #cbd5e1;border-radius:.75rem;font-size:.875rem;line-height:1.5;background:#f8fafc;color:#334155;";
      heading.closest("header").insertAdjacentElement("afterend", node);
    }
    if (node.textContent !== uploadNotice.text) node.textContent = uploadNotice.text;
  }

  // The recovered upload form has no source component available. Observe only
  // its same-origin multipart Nextcloud POST. Do not consume/change its request
  // or response, infer success from a toast, or delay the existing upload flow.
  var originalFetch = window.fetch.bind(window);
  window.fetch = function (input, options) {
    var snapshots = null;
    var uploadOwner = "";
    try {
      var url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
      var method = String((options && options.method) || (input && input.method) || "GET").toUpperCase();
      if (url.origin === location.origin && url.pathname === "/api/upload-to-nextcloud" && method === "POST" &&
          options && options.body instanceof FormData && options.body.getAll("files").some(file => file instanceof Blob)) {
        snapshots = Array.from(knownPhotos.values());
        uploadOwner = employeeId();
        uploadNotice = null;
        schedule();
      }
    } catch (_) { /* All other requests pass through unchanged. */ }
    var result = originalFetch(input, options);
    if (snapshots) result.then(function (response) {
      if (!response.ok) return;
      response.clone().json().then(async function (data) {
        if (data.success !== true || !data.captureCleanup) return;
        var receipt = data.captureCleanup;
        var owner = employeeId();
        if (!uploadOwner || owner !== uploadOwner) return;
        if (receipt.employeeId && receipt.employeeId !== owner) return;
        if (receipt.status !== "complete") {
          uploadNotice = { empId: owner, text: receipt.warning || "Files uploaded. Captures were kept because cleanup could not finish. Use Clear captured photos after checking the saved files." };
          schedule();
          return;
        }
        var hashes = new Set((receipt.savedFiles || []).map(file => file.sha256));
        await queueUploadedPhotos(snapshots, hashes, receipt.employeeId);
        uploadNotice = { empId: owner, text: "Upload completed. Matching captures are cleared from Smart Capture; saved files and records remain in storage." };
        schedule();
      }).catch(function () { /* Unconfirmed responses retain the captured drafts. */ });
    }).catch(function () { /* Failed uploads retain all captured drafts. */ });
    return result;
  };

  function active() {
    var heading = document.querySelector("#root header h2");
    return heading && heading.textContent.trim() === "Smart Capture Workflow";
  }
  function card() {
    if (!active()) return null;
    var headings = document.querySelectorAll("#root p, #root h3, #root h4");
    for (var heading of headings) {
      if (heading.textContent.trim().toLowerCase() !== "captured images") continue;
      for (var node = heading.parentElement, depth = 0; node && depth < 7; node = node.parentElement, depth++) {
        if (node.classList.contains("rounded-3xl") && node.classList.contains("border")) return node;
      }
    }
    return null;
  }
  function buttons() {
    var scope = card();
    return scope ? Array.from(scope.querySelectorAll('button[aria-label^="Remove "]')) : [];
  }
  function nameOf(button) { return button.getAttribute("aria-label").slice(7).trim(); }
  function message(text, error) { statusText = text; lastError = Boolean(error); schedule(); }

  async function json(url, options) {
    var controller = new AbortController();
    var timer = setTimeout(() => controller.abort(), 30000);
    try {
      var response = await fetch(url, Object.assign({ credentials: "include", cache: "no-store",
        headers: { Accept: "application/json" } }, options, { signal: controller.signal }));
      var data = await response.json().catch(() => null);
      if (!response.ok || !data) {
        if (response.status === 401 || response.status === 403) throw new Error("Sign in with the account that captured these photos, then retry.");
        throw new Error("The saved photo could not be removed. Check the connection and retry.");
      }
      return data;
    } finally { clearTimeout(timer); }
  }

  function previewOf(button) {
    var image = button.parentElement && button.parentElement.querySelector("img");
    return image ? image.getAttribute("src") : "";
  }
  function payloadOf(dataUrl) {
    if (typeof dataUrl !== "string" || !/^data:[^,]*;base64,/i.test(dataUrl)) return null;
    return dataUrl.slice(dataUrl.indexOf(",") + 1).replace(/\s/g, "").replace(/=+$/, "");
  }
  async function previewPayload(url) {
    if (!/^(blob:|data:image\/)/i.test(url)) throw new Error("The photo preview could not be verified. Refresh and retry.");
    var response = await fetch(url);
    if (!response.ok) throw new Error("The photo preview is unavailable. Refresh and retry.");
    var blob = await response.blob();
    if (blob.size > 20 * 1024 * 1024) return null;
    var bytes = new Uint8Array(await blob.arrayBuffer());
    var binary = "";
    for (var offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 32768));
    return btoa(binary).replace(/=+$/, "");
  }
  function removeVisible(fileName, preview) {
    var matches = buttons().filter(button => nameOf(button) === fileName && (preview === undefined || previewOf(button) === preview));
    if (matches.length !== 1) return false;
    var button = matches[0];
    replay.add(button);
    try { button.click(); } finally { replay.delete(button); }
    return true;
  }
  function notifyRemoved(entry, empId) {
    window.dispatchEvent(new CustomEvent("ipas-cam-capture-deleted", { detail: {
      eventId: entry.eventId, fileName: entry.fileName, captureType: entry.captureType || "", empId: empId,
    } }));
  }

  async function removePhotos(photoButtons) {
    if (busy || !photoButtons.length) return;
    var snapshots = photoButtons.map(button => ({ name: nameOf(button), preview: previewOf(button) }));
    busy = true;
    var completed = 0;
    message("Removing captured photos…", false);
    try {
      var user = await json("/api/auth/me");
      if (!user.employeeId) throw new Error("Sign in, then retry removing the photos.");
      var empId = String(user.employeeId);
      var data = await json("/api/cam/pending?empId=" + encodeURIComponent(empId));
      if (!Array.isArray(data.images)) throw new Error("The server could not confirm the saved photo list. Retry.");
      var eligible = data.images.filter(entry => entry && entry.captureType !== "ticket");
      var targets = [];
      var selectedIds = new Set();
      for (var snapshot of snapshots) {
        var content = eligible.length ? await previewPayload(snapshot.preview) : null;
        var matches = content ? eligible.filter(entry => payloadOf(entry.imageData) === content) : [];
        matches.forEach(entry => selectedIds.add(entry.eventId));
        targets.push({ snapshot: snapshot, entries: matches });
      }
      // Match saved content, not just the filename. A local upload must never
      // delete an unrelated saved capture that happens to share its name.
      for (var target of targets) {
        if (!target.entries.length && eligible.some(entry => entry.fileName === target.snapshot.name && !selectedIds.has(entry.eventId))) {
          throw new Error("This photo differs from its saved copy. Remove the saved original from Phone Camera, then retry.");
        }
      }
      var deletedIds = new Set();
      for (var target of targets) {
        for (var entry of target.entries) {
          if (deletedIds.has(entry.eventId)) continue;
          var result = await json("/api/cam/pending/" + encodeURIComponent(entry.eventId) + "?empId=" + encodeURIComponent(empId), { method: "DELETE" });
          if (result.success !== true) throw new Error("The server did not confirm deletion. Retry.");
          deletedIds.add(entry.eventId);
          notifyRemoved(entry, empId);
        }
        // Unsynced local uploads also use the original React removal handler.
        removeVisible(target.snapshot.name, target.snapshot.preview);
        await new Promise(resolve => requestAnimationFrame(resolve));
        completed += 1;
      }
      message("Removed " + completed + " captured photo" + (completed === 1 ? "" : "s") + ". Saved accountability records were kept.", false);
    } catch (error) {
      message((completed ? "Removed " + completed + " photo(s). " : "") +
        (error.name === "AbortError" ? "Deletion timed out. Reconnect and retry the remaining photos." : error.message || "Could not remove photos. Retry."), true);
    } finally { busy = false; schedule(); }
  }

  // Capture phase runs before React's local-only delete handler. Only replay it
  // after the server has acknowledged the delete, so failures retain the row.
  document.addEventListener("click", function (event) {
    var button = event.target instanceof Element ? event.target.closest('button[aria-label^="Remove "]') : null;
    var scope = card();
    if (!button || !scope || !scope.contains(button) || replay.has(button)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!busy) removePhotos([button]);
  }, true);

  window.addEventListener("ipas-cam-capture-deleted", function (event) {
    var detail = event.detail || {};
    if (!detail.eventId || removedEvents.has(detail.eventId)) return;
    removedEvents.add(detail.eventId);
    if (detail.captureType === "ticket") return;
    // Never update a newly logged-in account using a previous account's event.
    try {
      var user = JSON.parse(localStorage.getItem("icc_user") || "null");
      if (user && detail.empId && String(user.employeeId) !== String(detail.empId)) return;
    } catch (_) {}
    if (detail.reason === "uploaded") {
      queueUploadedPhotos(Array.from(knownPhotos.values()), new Set([detail.imageSha256, detail.sourceSha256].filter(Boolean)), String(detail.empId || ""));
      return;
    }
    if (!busy) removeVisible(detail.fileName);
    schedule();
  });

  function draw() {
    renderUploadNotice();
    var scope = card();
    if (!scope) return;
    rememberPhotos();
    flushUploadedPhotos();
    var toolbar = scope.querySelector("#ipas-capture-cleanup");
    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.id = "ipas-capture-cleanup";
      toolbar.style.cssText = "margin:1rem 0;display:flex;flex-wrap:wrap;align-items:center;gap:.75rem;";
      var button = document.createElement("button");
      button.type = "button";
      button.setAttribute("aria-label", "Clear captured photos");
      button.style.cssText = "padding:.65rem .9rem;border:1px solid #fecaca;border-radius:.75rem;background:#fff;color:#991b1b;font:inherit;font-size:.85rem;font-weight:600;cursor:pointer;";
      button.addEventListener("click", () => removePhotos(buttons()));
      var status = document.createElement("p");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.style.cssText = "margin:0;font-size:.85rem;line-height:1.5;";
      toolbar.append(button, status);
      (scope.querySelector('[class*="p-5"]') || scope.firstElementChild || scope).appendChild(toolbar);
    }
    var count = buttons().length;
    var clearButton = toolbar.querySelector("button");
    var label = "Clear captured photos" + (count ? " (" + count + ")" : "");
    if (clearButton.textContent !== label) clearButton.textContent = label;
    if (clearButton.disabled !== Boolean(busy || !count)) clearButton.disabled = Boolean(busy || !count);
    var statusNode = toolbar.querySelector("p");
    var text = statusText || "Clears photos in this list. Saved accountability records are kept.";
    if (statusNode.textContent !== text) statusNode.textContent = text;
    var color = lastError ? "rgb(153, 27, 27)" : "rgb(71, 85, 105)";
    if (statusNode.style.color !== color) statusNode.style.color = color;
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; draw(); });
  }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
})();
