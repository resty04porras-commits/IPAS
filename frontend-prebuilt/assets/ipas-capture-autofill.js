/* Automatic equipment drafts for the recovered Smart Capture frontend.
 * Commits through its existing Modify/Save handler so table and exports agree.
 * No database save or storage upload is performed here. */
(function () {
  "use strict";
  if (window.__ipasCaptureAutofillInstalled) return;
  window.__ipasCaptureAutofillInstalled = true;
  var jobs = new Map();
  var metadata = new Map();
  var currentOwner = "";
  var reading = null;
  var committing = null;
  var scheduled = false;
  var phone = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var required = ["components", "description", "hardwareId", "serial"];
  var fieldNames = { components: "component", description: "description", hardwareId: "hardwareId", serial: "serialNumber", remarks: "remarks" };
  var localSelections = new Map();
  window.__ipasCanonicalEquipmentComponent = function (value) {
    var text = String(value || "").trim();
    return /^(?:CPU\s+ADAPT(?:ER|OR)|LAPTOP\s+ADAPT(?:ER|OR)|NOTEBOOK\s+ADAPT(?:ER|OR)|(?:LAPTOP\s+|CPU\s+)?CHARGER|(?:AC\s*[/-]?\s*|POWER\s+)ADAPT(?:ER|OR)|LAD)$/i.test(text) ? "LAPTOP ADAPTER" : text;
  };
  function exclusions() {
    try { var value = JSON.parse(localStorage.getItem("ipas_capture_row_exclusions_" + encodeURIComponent(currentOwner)) || "[]"); return new Set(Array.isArray(value) ? value.filter(key => typeof key === "string").slice(-200) : []); }
    catch (_) { return new Set(); }
  }
  function exclusionKeys(job, hash) { return [job.eventId ? "capture:" + job.eventId : "", hash ? "image:" + hash : ""].filter(Boolean); }
  async function persistExclusion(job, excluded) {
    var hash = await job.hash;
    if (owner() !== job.owner) return;
    var values = exclusions(); exclusionKeys(job, hash).forEach(key => excluded ? values.add(key) : values.delete(key));
    try { localStorage.setItem("ipas_capture_row_exclusions_" + encodeURIComponent(currentOwner), JSON.stringify(Array.from(values).slice(-200))); } catch (_) {}
  }
  function removeNativeRows(ids) {
    var photo = visiblePhotos()[0];
    var element = photo && photo.button;
    var key = element && Object.keys(element).find(key => key.startsWith("__reactFiber$"));
    for (var fiber = key && element[key]; fiber; fiber = fiber.return) {
      if (typeof fiber.type !== "function") continue;
      for (var hook = fiber.memoizedState; hook; hook = hook.next) {
        var value = hook.memoizedState;
        if (!Array.isArray(value) || !hook.queue || !hook.queue.dispatch) continue;
        var exact = value.some(row => row && ids.includes(row.captureId) && Object.prototype.hasOwnProperty.call(row, "components"));
        // The recovered form's empty asset-row hook is followed by receipt rows,
        // three booleans and nullable form state. Functional dispatch also sees
        // a row whose preceding Modify/Save update has not painted yet.
        var next = hook.next;
        var empty = !value.length && next && Array.isArray(next.memoizedState) && next.next &&
          typeof next.next.memoizedState === "boolean" && next.next.next && typeof next.next.next.memoizedState === "boolean" &&
          next.next.next.next && typeof next.next.next.next.memoizedState === "boolean";
        if (!exact && !empty) continue;
        hook.queue.dispatch(function (rows) { return Array.isArray(rows) ? rows.filter(row => !ids.includes(row.captureId)) : rows; });
        return true;
      }
    }
    return false;
  }
  var style = document.createElement("style");
  style.textContent = '@media(max-width:600px){[data-ipas-autofill-photo]{display:grid!important;grid-template-columns:40px minmax(0,1fr) auto;gap:.5rem!important}[data-ipas-autofill-photo]>button:first-child{grid-row:1;grid-column:1}[data-ipas-autofill-photo]>div{grid-row:1;grid-column:2/4;min-width:0}[data-ipas-autofill-photo]>button:nth-of-type(2){grid-row:2;grid-column:1/3;justify-self:start}[data-ipas-autofill-photo]>button:nth-of-type(3){grid-row:2;grid-column:2;justify-self:end}[data-ipas-autofill-photo]>button[aria-label^="Remove "]{grid-row:2;grid-column:3;justify-self:end}}';
  document.head.appendChild(style);

  function owner() {
    try { return String((JSON.parse(localStorage.getItem("icc_user") || "null") || {}).employeeId || ""); }
    catch (_) { return ""; }
  }
  function active() {
    var heading = document.querySelector("#root header h2");
    return heading && heading.textContent.trim() === "Smart Capture Workflow";
  }
  function visiblePhotos() {
    return active() ? Array.from(document.querySelectorAll('#root button[aria-label^="Remove "]')).map(function (button) {
      var row = button.parentElement;
      var image = row && row.querySelector("img");
      return image ? { button: button, row: row, name: button.getAttribute("aria-label").slice(7).trim(), preview: image.getAttribute("src") } : null;
    }).filter(Boolean) : [];
  }
  function photoFor(job) { return visiblePhotos().find(photo => photo.preview === job.preview && photo.name === job.name); }
  async function hashBlob(blob) {
    if (!window.crypto || !window.crypto.subtle) return "";
    var result = await window.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, "0")).join("");
  }
  async function imageBlob(url) {
    if (!/^(blob:|data:image\/)/i.test(url)) throw new Error("Image preview is unavailable. Reattach the photo.");
    var response = await fetch(url);
    if (!response.ok) throw new Error("Image preview is unavailable. Reattach the photo.");
    var blob = await response.blob();
    if (blob.size > 20 * 1024 * 1024) throw new Error("This photo exceeds the 20 MB reading limit. Use a smaller photo.");
    return blob;
  }
  function registerMetadata(event) {
    var detail = event.detail || {};
    if (!detail.eventId || detail.captureType !== "equipment" || (detail.empId && String(detail.empId) !== owner())) return;
    if (currentOwner !== owner()) {
      jobs.forEach(job => { job.alive = false; if (job.controller) job.controller.abort(); });
      jobs.clear(); metadata.clear(); currentOwner = owner();
    }
    var item = { id: detail.eventId, name: detail.fileName, sourceHash: detail.sourceSha256 || "", owner: owner(),
      ...window.__ipasEquipmentUnits?.selection(detail),
      hash: imageBlob(detail.imageData).then(hashBlob).catch(() => "") };
    metadata.set(item.id, item);
    while (metadata.size > 200) metadata.delete(metadata.keys().next().value);
    schedule();
  }
  window.addEventListener("ipas-cam-capture", registerMetadata);
  window.addEventListener("ipas-smart-capture-saved", registerMetadata);
  window.addEventListener("ipas-equipment-files", function (event) {
    var selectedOwner = owner(), chosen = window.__ipasEquipmentUnits?.selection(event.detail);
    if (!chosen || !selectedOwner) return;
    (event.detail.files || []).forEach(file => hashBlob(file).then(hash => {
      if (owner() !== selectedOwner) return;
      localSelections.set(hash, Object.assign({}, window.__ipasEquipmentUnits.forFile(file), chosen)); if (localSelections.size > 300) localSelections.delete(localSelections.keys().next().value);
      schedule();
    }).catch(() => {}));
  });

  async function savedCapture(job) {
    var hash = await job.hash;
    if (!hash) return null;
    for (var item of metadata.values()) {
      if (item.owner === job.owner && (item.sourceHash === hash || await item.hash === hash)) return item;
    }
    return null;
  }
  function keep(job) { return job.alive && !job.excluded && owner() === job.owner && currentOwner === job.owner; }
  function choose(select, value) {
    var match = Array.from(select.options || []).find(option => option.value.toLowerCase() === String(value || "").toLowerCase());
    if (!match) {
      match = document.createElement("option"); match.value = value || "";
      match.textContent = value || "Select remarks"; select.prepend(match);
    }
    select.value = match.value;
  }
  function modalJob(modal) {
    var image = modal && modal.querySelector('[data-role="preview"]');
    return image ? jobs.get(image.getAttribute("src")) : null;
  }
  function groupRecord(job) {
    var api = window.__ipasEquipmentUnits;
    if (!api || !job.equipmentUnitId) return Object.assign({}, job.record || {}, job.manual);
    var members = Array.from(jobs.values()).filter(other => keep(other) && other.equipmentUnitId === job.equipmentUnitId && other.record);
    var groups = api.merge(members.map(other => Object.assign({}, other.record, other.manual, {
      captureId: other.captureId || other.eventId || other.preview, equipmentType: other.equipmentType, equipmentUnitId: other.equipmentUnitId,
      notes: other.notes, serialSource: other.serialSource, manualFields: Array.from(other.dirty), manualOrder: other.manualOrder || 0,
    })));
    return groups[0] || Object.assign({}, job.record || {}, job.manual);
  }
  // The recovered bundle dispatches Save on window. Supply context directly to
  // the table listener as well, independent of same-target listener ordering.
  window.__ipasAutofillDetailMetadata = function (detail) {
    if (!active()) return {};
    var job = committing || modalJob(document.querySelector('[data-ipas-image-modify="1"]')) ||
      Array.from(jobs.values()).find(job => job.captureId === detail.captureId && keep(job));
    if (!job || !job.alive || owner() !== job.owner) return {};
    return { equipmentType: job.equipmentType, equipmentUnitId: job.equipmentUnitId, notes: job.notes || "", serialSource: job.serialSource,
      manualFields: Array.from(job.dirty), manualOrder: committing ? job.manualOrder || 0 : Date.now() };
  };
  function fillModal(modal, job) {
    var record = committing ? Object.assign({}, job.record || {}, job.manual) : groupRecord(job);
    Object.keys(fieldNames).forEach(function (field) {
      var input = modal.querySelector('[data-field="' + fieldNames[field] + '"]');
      if (!input || (field !== "remarks" && record[field] === undefined)) return;
      var value = field === "remarks" ? (record.remarks || "") : (record[field] || "");
      if (input.tagName === "SELECT") choose(input, value); else input.value = value;
    });
    var staff = modal.querySelector('[data-field="remarksStaff"]');
    if (staff && !(job.manual.remarks || "").startsWith("Transfer Accountability")) { staff.value = ""; staff.disabled = true; staff.classList.add("hidden"); }
  }
  function commit(job) {
    if (!keep(job) || !job.pendingCommit || committing || !active() ||
        document.querySelector('[data-ipas-image-modify="1"]') ||
        document.activeElement && document.activeElement.closest("#ipas-smart-capture-equipment-table textarea")) return;
    var photo = photoFor(job);
    if (!photo) return;
    var button = Array.from(photo.row.querySelectorAll("button")).find(button => button.textContent.trim() === "Modify");
    if (!button) return;
    committing = job;
    try {
      button.click();
      var modal = document.querySelector('[data-ipas-image-modify="1"]');
      if (!modal || modalJob(modal) !== job) return;
      modal.hidden = true;
      modal.dataset.ipasAutofill = "1";
      fillModal(modal, job);
      var save = modal.querySelector('[data-role="save"]');
      if (save) { save.click(); job.pendingCommit = false; }
    } finally { committing = null; }
  }
  function watchModal() {
    var modal = document.querySelector('[data-ipas-image-modify="1"]');
    var cameraPanel = document.getElementById("ipas-cam-panel");
    if (cameraPanel) {
      if (modal && !modal.hidden && !cameraPanel.dataset.autofillHidden) {
        cameraPanel.dataset.autofillHidden = "1"; cameraPanel.style.visibility = "hidden";
      } else if (!modal && cameraPanel.dataset.autofillHidden) {
        delete cameraPanel.dataset.autofillHidden; cameraPanel.style.visibility = "";
      }
    }
    if (!modal || modal.dataset.ipasAutofill || modal.dataset.ipasAutofillReady) return;
    var job = modalJob(modal);
    if (!job) return;
    modal.dataset.ipasAutofillReady = "1";
    fillModal(modal, job);
    function edited(event) {
      var field = Object.keys(fieldNames).find(key => fieldNames[key] === event.target.dataset.field);
      if (field) job.dirty.add(field);
    }
    modal.addEventListener("input", edited); modal.addEventListener("change", edited);
  }
  window.addEventListener("ipas-smart-capture-detail-save", function (event) {
    var detail = event.detail || {};
    var job = committing || modalJob(document.querySelector('[data-ipas-image-modify="1"]'));
    if (!job || !job.alive || owner() !== job.owner) return;
    if (job.excluded && !committing) { job.excluded = false; persistExclusion(job, false); job.state = "done"; }
    job.captureId = detail.captureId;
    if (!committing) {
      job.manualOrder = Date.now();
      job.dirty.forEach(field => job.manual[field] = detail[field] || "");
      // Remarks are always taken from the user's control, never extraction.
      job.manual.remarks = detail.remarks || "";
      if (!job.record) job.record = Object.assign({}, detail);
    }
    Object.assign(detail, { equipmentType: job.equipmentType, equipmentUnitId: job.equipmentUnitId,
      notes: job.notes || "", serialSource: job.serialSource,
      manualFields: Array.from(job.dirty), manualOrder: job.manualOrder || 0 });
    var photo = photoFor(job);
    if (photo) photo.button.dataset.autofillCaptureId = job.captureId;
  }, true);
  window.addEventListener("ipas-smart-capture-detail-edit", function (event) {
    var detail = event.detail || {};
    jobs.forEach(function (job) {
      if (!keep(job) || !(detail.captureIds || []).includes(job.captureId)) return;
      job.manual.remarks = String(detail.remarks || ""); job.dirty.add("remarks");
      job.manualOrder = Date.now();
      job.pendingCommit = true;
    });
    schedule();
  });
  window.addEventListener("ipas-smart-capture-detail-remove", function (event) {
    var ids = (event.detail || {}).captureIds || [];
    // The existing save handler also invalidates staged files and cached exports.
    // Use it before filtering native rows, so a previous workbook cannot retain
    // a row that the operator has just removed.
    var draft = Array.from(jobs.values()).find(job => ids.includes(job.captureId) && keep(job) && job.record);
    if (draft) { draft.pendingCommit = true; commit(draft); }
    removeNativeRows(ids);
    jobs.forEach(function (job) {
      if (!ids.includes(job.captureId) || !job.alive || owner() !== job.owner) return;
      job.excluded = true; job.pendingCommit = false; job.state = "excluded";
      if (job.controller) job.controller.abort(); persistExclusion(job, true);
    });
    schedule();
  });
  document.addEventListener("focusout", schedule);

  function applyDraft(job, data, final) {
    if (!keep(job) || data.employeeId !== job.owner || !data.record) return;
    job.record = { components: "", description: "", hardwareId: "", serial: "", remarks: "" };
    required.forEach(field => job.record[field] = typeof data.record[field] === "string" ? data.record[field] : "");
    job.record.components = window.__ipasCanonicalEquipmentComponent(job.record.components);
    var equipment = window.__ipasEquipmentUnits?.selection(data) || window.__ipasEquipmentUnits?.selection(job);
    if (equipment) {
      Object.assign(job, equipment); window.__ipasEquipmentUnits.markPreview(job.preview, equipment);
      job.record.components = window.__ipasEquipmentUnits.component(equipment.equipmentType);
    }
    job.state = final ? "done" : "refining"; job.review = Boolean(data.needsReview); job.missing = data.missingFields || [];
    job.notes = String(data.record.notes || ""); job.pendingCommit = true; schedule();
    job.serialSource = data.serialSource || (/SNID fallback/i.test(job.notes) ? "snid" : /Manufacturer S\/N label read/i.test(job.notes) ? "manufacturer" : "unknown");
  }
  async function readResponse(response, job) {
    if (!response.ok || !String(response.headers.get("Content-Type") || "").includes("application/x-ndjson")) {
      var data = await response.json().catch(() => null);
      if (!response.ok || !data || !data.record) throw new Error(data && data.error || "Automatic reading could not finish. Retry or enter the details manually.");
      applyDraft(job, data, true); return;
    }
    var reader = response.body.getReader(), decoder = new TextDecoder(), buffer = "", completed = false;
    function line(text) {
      if (!text.trim()) return;
      var update = JSON.parse(text);
      if (update.stage === "error") throw new Error(update.error || "Reading could not finish; local fields were kept.");
      if (update.stage === "local") applyDraft(job, update, false);
      if (update.stage === "final") { applyDraft(job, update, true); completed = true; }
    }
    try {
      for (;;) {
        var chunk = await reader.read(); buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
        var split;
        while ((split = buffer.indexOf("\n")) !== -1) { line(buffer.slice(0, split)); buffer = buffer.slice(split + 1); }
        if (chunk.done) break;
      }
      if (buffer.trim()) line(buffer);
      if (!completed) throw new Error("Reading stopped before completion. Local fields were kept; retry or edit manually.");
    } finally { reader.releaseLock(); }
  }

  async function run(job) {
    reading = job;
    try {
      job.state = "preparing"; schedule();
      var capture = await savedCapture(job);
      var equipment = window.__ipasEquipmentUnits?.selection(capture) || localSelections.get(await job.hash);
      if (equipment) { Object.assign(job, equipment); window.__ipasEquipmentUnits.markPreview(job.preview, equipment); }
      if (!keep(job)) return;
      if (phone && !capture && !job.retry) { job.state = "waiting"; return; }
      job.eventId = capture && capture.id;
      var values = exclusions();
      if (exclusionKeys(job, await job.hash).some(key => values.has(key))) { job.excluded = true; job.state = "excluded"; return; }
      var controller = new AbortController(); job.controller = controller;
      var timer = setTimeout(() => controller.abort(), 180000);
      var options = { method: "POST", credentials: "include", headers: { Accept: "application/x-ndjson" }, signal: controller.signal };
      try {
        if (capture) {
          options.headers["Content-Type"] = "application/json";
          options.body = JSON.stringify({ eventId: capture.id, retry: Boolean(job.retry) });
        } else {
          var form = new FormData(); form.append("evidence", await job.blob, job.name);
          if (equipment) { form.append("equipmentType", equipment.equipmentType); form.append("equipmentUnitId", equipment.equipmentUnitId); }
          if (job.retry) form.append("retry", "true"); options.body = form;
        }
        job.state = "reading"; schedule();
        var response = await fetch("/api/intake/auto-extract", options);
        await readResponse(response, job);
      } finally { clearTimeout(timer); }
    } catch (error) {
      if (keep(job)) { job.state = "error"; job.error = error.name === "AbortError" ? "Reading timed out. The photo was kept; retry or enter details manually." : error.message; }
    } finally { reading = null; job.retry = false; schedule(); }
  }
  function renderJob(job, photo) {
    photo.row.dataset.ipasAutofillPhoto = "1";
    var badge = photo.row.querySelector("[data-ipas-reading]");
    if (!badge) {
      badge = document.createElement("span"); badge.dataset.ipasReading = "1";
      badge.setAttribute("role", "status"); badge.style.cssText = "display:block;font-size:.72rem;line-height:1.4;margin-top:.25rem;color:#475569;";
      var image = photo.row.querySelector("img");
      var caption = image && image.parentElement && image.parentElement.nextElementSibling;
      (caption && caption.tagName === "DIV" ? caption : photo.row).appendChild(badge);
    }
    var grouped = job.equipmentUnitId ? groupRecord(job) : null;
    var missing = grouped ? required.filter(field => !grouped[field]) : job.missing;
    var review = grouped ? missing.length > 0 || grouped.conflicts?.length || /SNID fallback/i.test(grouped.notes || "") || /Vision review required/i.test(job.notes || "") : job.review;
    var text = job.state === "queued" ? "Queued for reading" : job.state === "preparing" ? "Preparing image…" :
      job.state === "waiting" ? "Waiting for phone sync…" : job.state === "excluded" ? "Row removed — photo kept" : job.state === "reading" ? "Reading equipment labels…" :
      job.state === "refining" ? "Local fields ready — checking remaining labels…" :
      job.state === "error" ? job.error : review ? "Needs review" + (missing.length ? ": " + missing.map(field => ({components:"Components",description:"Description",hardwareId:"Hardware ID",serial:"Serial"})[field] || field).join(", ") : " — compare with the image") : (grouped ? "Unit fields ready" : "Read complete" + (/SNID fallback/i.test(job.notes || "") ? " (SNID fallback)" : "")) + " — verify the fields";
    if (job.state === "done" && !text.includes("SNID fallback") && /SNID fallback/i.test(grouped ? grouped.notes || "" : job.notes || "")) text += " (SNID fallback)";
    var photoProgress = window.__ipasEquipmentUnits?.photoProgress(job);
    if (photoProgress) text = photoProgress.label + " · Capture " + photoProgress.index + "/4 (" + photoProgress.captured + "/4 photos) — " + text;
    if (badge.firstChild && badge.firstChild.nodeType === Node.TEXT_NODE) { if (badge.firstChild.nodeValue !== text) badge.firstChild.nodeValue = text; }
    else badge.prepend(document.createTextNode(text));
    badge.title = job.notes || "";
    var retry = badge.querySelector("button");
    var canRetry = job.state === "excluded" || job.state === "error" || job.state === "waiting" || job.state === "done" && review;
    if (canRetry && !retry) {
      retry = document.createElement("button"); retry.type = "button";
      retry.style.cssText = "margin-left:.5rem;color:#1d4ed8;text-decoration:underline;font:inherit;";
      retry.addEventListener("click", function () {
        if (reading === job) return;
        var restoring = job.excluded;
        var targets = restoring && job.equipmentUnitId ? Array.from(jobs.values()).filter(other => other.alive && other.owner === job.owner && other.equipmentUnitId === job.equipmentUnitId && other.excluded) : [job];
        targets.forEach(function (other) {
          other.excluded = false;
          persistExclusion(other, false).then(function () { other.retry = !restoring; other.state = "queued"; schedule(); });
        });
      });
      badge.appendChild(retry);
    } else if (retry && !canRetry) retry.remove();
    var retryLabel = job.state === "excluded" ? "Restore row" : "Retry reading";
    if (retry && canRetry && retry.textContent !== retryLabel) retry.textContent = retryLabel;
  }
  function sync() {
    scheduled = false;
    var nextOwner = owner();
    if (nextOwner !== currentOwner) {
      jobs.forEach(job => { job.alive = false; if (job.controller) job.controller.abort(); });
      jobs.clear(); metadata.clear(); localSelections.clear(); currentOwner = nextOwner;
    }
    if (!active() || !currentOwner) return;
    var photos = visiblePhotos(); var previews = new Set(photos.map(photo => photo.preview));
    jobs.forEach(function (job, key) {
      if (!previews.has(key)) { window.__ipasEquipmentUnits?.forgetPreview(job.preview); persistExclusion(job, false); job.alive = false; if (job.controller) job.controller.abort(); jobs.delete(key); }
    });
    photos.forEach(function (photo) {
      var job = jobs.get(photo.preview);
      if (!job) {
        var blob = imageBlob(photo.preview);
        job = { preview: photo.preview, name: photo.name, owner: currentOwner, alive: true, state: "queued", manual: {}, dirty: new Set(), blob: blob,
          hash: blob.then(hashBlob).catch(() => ""), pendingCommit: false, missing: [] };
        blob.catch(() => {}); jobs.set(photo.preview, job);
      }
      renderJob(job, photo);
      if (job.pendingCommit) commit(job);
    });
    watchModal();
    if (!reading) {
      var queued = Array.from(jobs.values()).find(job => job.alive && !job.excluded && job.state === "queued");
      if (queued) run(queued);
      else jobs.forEach(function (job) {
        if (job.state === "waiting") savedCapture(job).then(function (entry) { if (entry && keep(job)) { job.state = "queued"; schedule(); } });
      });
    }
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(sync); } }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("ipas-cam-capture-deleted", function (event) {
    var detail = event.detail || {};
    if (detail.empId && String(detail.empId) !== currentOwner) return;
    metadata.delete(detail.eventId);
    jobs.forEach(function (job) { if (job.eventId === detail.eventId) { persistExclusion(job, false); job.alive = false; if (job.controller) job.controller.abort(); } });
    schedule();
  });
  window.addEventListener("ipas-equipment-progress", schedule);
  schedule();
})();
