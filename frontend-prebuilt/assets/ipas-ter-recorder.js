(function () {
  "use strict";

  var PANEL_ID = "ipas-ter-recorder";
  var DRAFT_KEY = "ipas_ter_active_travel_entry_draft";
  var PENDING_KEY = "ipas_ter_pending_travel_entries";
  var DRAFT_IMAGE_DB = "ipas-ter-recorder-drafts";
  var DRAFT_IMAGE_STORE = "ticketImages";
  var DRAFT_IMAGE_KEY = "active-ticket";
  var TRANSPORT_TYPES = [
    "Tricycle",
    "Jeep",
    "Taxi",
    "E-Bike",
    "Bus",
    "Plane",
    "Ferry",
    "Motorcycle",
    "Van",
    "Others",
  ];

  var state = {
    date: "",
    departTime: "",
    arriveTime: "",
    timeRange: "",
    departDate: null,
    stream: null,
    ticketFile: null,
    ticketPreviewUrl: "",
    ticketImageData: "",
    ticketFileName: "",
    ticketMimeType: "",
    entryId: "",
    restoring: false,
    pollTimer: null,
    syncingPending: false,
  };

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function isLiquidationActive() {
    var bodyText = document.body ? document.body.textContent || "" : "";
    return bodyText.indexOf("Liquidation Workflow") !== -1 &&
      bodyText.indexOf("Travel Expense Report Form") !== -1;
  }

  function findHeading(text) {
    var headings = document.querySelectorAll("h1,h2,h3,h4");
    for (var i = 0; i < headings.length; i += 1) {
      if ((headings[i].textContent || "").trim() === text) return headings[i];
    }
    return null;
  }

  function findLiquidationCard() {
    var heading = findHeading("Travel Expense Report Form");
    var el = heading;
    for (var depth = 0; el && depth < 8; depth += 1) {
      var cls = typeof el.className === "string" ? el.className : "";
      if (cls.indexOf("bg-white") !== -1 &&
          cls.indexOf("rounded-3xl") !== -1 &&
          cls.indexOf("border") !== -1) {
        return el;
      }
      el = el.parentElement;
    }
    return heading ? heading.parentElement : null;
  }

  function formatDate(date) {
    return date.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatTime(date) {
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  function setStatus(message, isError) {
    var el = document.querySelector("#" + PANEL_ID + " [data-ter-status]");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("error", !!isError);
  }

  function safeJsonParse(value) {
    try { return JSON.parse(value || "null"); } catch (_) { return null; }
  }

  function readCurrentUser() {
    var keys = ["icc_user", "ipas_user", "user"];
    for (var i = 0; i < keys.length; i += 1) {
      var user = safeJsonParse(localStorage.getItem(keys[i]));
      if (user && typeof user === "object") return user;
    }
    return {};
  }

  function getTerId() {
    var user = readCurrentUser();
    var rawId = user.employeeId || user.id || user.username || user.name || "shared";
    return "ter:" + String(rawId || "shared").replace(/[^a-zA-Z0-9:_@./ -]+/g, "").slice(0, 120);
  }

  function getDraftId() {
    if (state.entryId) return state.entryId;
    var draft = safeJsonParse(localStorage.getItem(DRAFT_KEY));
    if (draft && draft.id) {
      state.entryId = String(draft.id);
      return state.entryId;
    }
    state.entryId = "liquidation-mobile-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    return state.entryId;
  }

  function readPendingEntries() {
    var value = safeJsonParse(localStorage.getItem(PENDING_KEY));
    return Array.isArray(value) ? value : [];
  }

  function writePendingEntries(entries) {
    try {
      if (entries.length) localStorage.setItem(PENDING_KEY, JSON.stringify(entries));
      else localStorage.removeItem(PENDING_KEY);
    } catch (err) {
      console.warn("[ipas-ter-recorder] Unable to store pending travel entries:", err);
    }
  }

  function queuePendingEntry(record) {
    var pending = readPendingEntries().filter(function (entry) {
      return entry && entry.id !== record.id;
    });
    pending.push(Object.assign({}, record, {
      terId: getTerId(),
      pendingAt: new Date().toISOString(),
    }));
    writePendingEntries(pending);
  }

  function toServerEntry(record) {
    return Object.assign({}, record, {
      ticketFileName: record.ticketFileName || state.ticketFileName || "",
      ticketMimeType: record.ticketMimeType || state.ticketMimeType || "",
      ticketImageData: record.ticketImageData || state.ticketImageData || "",
      createdAt: record.createdAt || new Date().toISOString(),
    });
  }

  async function postTravelEntry(record) {
    var response = await fetch("/api/ter/travel-entry", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify({
        terId: getTerId(),
        entry: toServerEntry(record),
      }),
    });
    var payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) {
      throw new Error((payload && payload.error) || "Unable to sync travel entry to server.");
    }
    return payload && payload.entry ? payload.entry : record;
  }

  async function flushPendingEntries() {
    if (state.syncingPending || !navigator.onLine) return;
    var pending = readPendingEntries();
    if (!pending.length) return;
    state.syncingPending = true;
    var remaining = [];
    for (var i = 0; i < pending.length; i += 1) {
      var entry = pending[i];
      try {
        await postTravelEntry(entry);
        if (entry.id === state.entryId) {
          clearPersistedDraft();
          resetRecorder(true);
          setStatus("Pending travel entry synced to server.");
        }
      } catch (_) {
        remaining.push(entry);
      }
    }
    writePendingEntries(remaining);
    state.syncingPending = false;
  }

  function setText(selector, value) {
    var el = document.querySelector("#" + PANEL_ID + " " + selector);
    if (el) el.textContent = value || "-";
  }

  function updateTimeDisplay() {
    setText("[data-ter-date]", state.date);
    setText("[data-ter-depart]", state.departTime);
    setText("[data-ter-arrive]", state.arriveTime);
    setText("[data-ter-range]", state.timeRange);
    var arriveButton = document.querySelector("#" + PANEL_ID + " [data-ter-arrive-button]");
    if (arriveButton) arriveButton.disabled = !state.departTime;
  }

  function openDraftImageDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        resolve(null);
        return;
      }
      var request = indexedDB.open(DRAFT_IMAGE_DB, 1);
      request.onupgradeneeded = function () {
        request.result.createObjectStore(DRAFT_IMAGE_STORE);
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function saveDraftImage(data) {
    return openDraftImageDb().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DRAFT_IMAGE_STORE, "readwrite");
        tx.objectStore(DRAFT_IMAGE_STORE).put(data, DRAFT_IMAGE_KEY);
        tx.oncomplete = function () { db.close(); resolve(true); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    }).catch(function () { return false; });
  }

  function loadDraftImage() {
    return openDraftImageDb().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DRAFT_IMAGE_STORE, "readonly");
        var request = tx.objectStore(DRAFT_IMAGE_STORE).get(DRAFT_IMAGE_KEY);
        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { reject(request.error); };
        tx.oncomplete = function () { db.close(); };
      });
    }).catch(function () { return null; });
  }

  function clearDraftImage() {
    return openDraftImageDb().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DRAFT_IMAGE_STORE, "readwrite");
        tx.objectStore(DRAFT_IMAGE_STORE).delete(DRAFT_IMAGE_KEY);
        tx.oncomplete = function () { db.close(); resolve(true); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    }).catch(function () { return false; });
  }

  function getFieldValue(name) {
    var el = document.querySelector("#" + PANEL_ID + " [name='" + name + "']");
    return el ? el.value : "";
  }

  function setFieldValue(name, value) {
    var el = document.querySelector("#" + PANEL_ID + " [name='" + name + "']");
    if (el) el.value = value || "";
  }

  function buildDraftObject() {
    var now = new Date().toISOString();
    var existing = null;
    try { existing = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch (_) {}
    var id = state.entryId || (existing && existing.id) || "liquidation-mobile-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    state.entryId = id;
    return {
      id: id,
      status: "in_progress",
      date: state.date,
      departTime: state.departTime,
      arriveTime: state.arriveTime,
      timeRange: state.timeRange,
      transportationType: getFieldValue("ter_transport"),
      fromLocation: getFieldValue("ter_from"),
      toLocation: getFieldValue("ter_to"),
      amount: getFieldValue("ter_amount"),
      remarks: getFieldValue("ter_remarks"),
      ticketImage: state.ticketImageData ? DRAFT_IMAGE_KEY : "",
      ticketFileName: state.ticketFileName,
      ticketMimeType: state.ticketMimeType,
      createdAt: existing && existing.createdAt ? existing.createdAt : now,
      updatedAt: now,
    };
  }

  function draftHasContent(draft) {
    return !!(draft && [
      draft.date,
      draft.departTime,
      draft.arriveTime,
      draft.timeRange,
      draft.transportationType,
      draft.fromLocation,
      draft.toLocation,
      draft.amount,
      draft.remarks,
      draft.ticketImage,
    ].some(function (value) { return String(value || "").trim() !== ""; }));
  }

  function persistDraft() {
    if (state.restoring) return;
    try {
      var draft = buildDraftObject();
      if (!draftHasContent(draft)) return;
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch (err) {
      console.warn("[ipas-ter-recorder] Unable to save active draft:", err);
    }
    if (state.ticketImageData) {
      saveDraftImage({
        dataUrl: state.ticketImageData,
        fileName: state.ticketFileName,
        mimeType: state.ticketMimeType,
      });
    }
  }

  function clearPersistedDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
    clearDraftImage();
  }

  function restoreTicketPreview(data) {
    if (!data || !data.dataUrl) return;
    state.ticketImageData = data.dataUrl;
    state.ticketFileName = data.fileName || "ter-ticket-draft.jpg";
    state.ticketMimeType = data.mimeType || "image/jpeg";
    state.ticketFile = dataURLToFile(state.ticketImageData, state.ticketFileName);
    state.ticketPreviewUrl = URL.createObjectURL(state.ticketFile);
    var image = document.querySelector("#" + PANEL_ID + " [data-ter-ticket-preview]");
    var preview = document.querySelector("#" + PANEL_ID + " [data-ter-ticket-box]");
    if (image) image.src = state.ticketPreviewUrl;
    if (preview) preview.classList.add("active");
  }

  function restoreDraftToPanel() {
    var raw = null;
    try { raw = localStorage.getItem(DRAFT_KEY); } catch (_) {}
    if (!raw) return;
    var draft = null;
    try { draft = JSON.parse(raw); } catch (_) { return; }
    if (!draft || draft.status !== "in_progress") return;
    state.restoring = true;
    state.entryId = draft.id || "";
    state.date = draft.date || "";
    state.departTime = draft.departTime || "";
    state.arriveTime = draft.arriveTime || "";
    state.timeRange = draft.timeRange || "";
    setFieldValue("ter_transport", draft.transportationType || "");
    setFieldValue("ter_from", draft.fromLocation || "");
    setFieldValue("ter_to", draft.toLocation || "");
    setFieldValue("ter_amount", draft.amount || "");
    setFieldValue("ter_remarks", draft.remarks || "");
    updateTimeDisplay();
    state.restoring = false;
    if (draft.ticketImage) {
      loadDraftImage().then(function (data) {
        restoreTicketPreview(data);
      });
    }
    setStatus("Unfinished travel entry restored.");
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach(function (track) { track.stop(); });
    }
    state.stream = null;
    var video = document.querySelector("#" + PANEL_ID + " video");
    if (video) video.srcObject = null;
  }

  function clearTicket(shouldPersist) {
    if (state.ticketPreviewUrl) URL.revokeObjectURL(state.ticketPreviewUrl);
    state.ticketFile = null;
    state.ticketPreviewUrl = "";
    state.ticketImageData = "";
    state.ticketFileName = "";
    state.ticketMimeType = "";
    var image = document.querySelector("#" + PANEL_ID + " [data-ter-ticket-preview]");
    if (image) image.removeAttribute("src");
    var preview = document.querySelector("#" + PANEL_ID + " [data-ter-ticket-box]");
    if (preview) preview.classList.remove("active");
    clearDraftImage();
    if (shouldPersist !== false) persistDraft();
  }

  function nativeSetValue(el, value) {
    if (!el) return;
    var proto = HTMLInputElement.prototype;
    if (el.tagName === "TEXTAREA") proto = HTMLTextAreaElement.prototype;
    if (el.tagName === "SELECT") proto = HTMLSelectElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function getFiberFromElement(el) {
    while (el && el !== document.body) {
      var keys = Object.keys(el);
      var key = keys.find(function (name) {
        return name.indexOf("__reactFiber$") === 0 || name.indexOf("__reactContainer$") === 0;
      });
      if (key) return el[key];
      el = el.parentElement;
    }
    return null;
  }

  function getHookAt(fiber, index) {
    var hook = fiber && fiber.memoizedState;
    for (var i = 0; hook && i < index; i += 1) hook = hook.next;
    return hook || null;
  }

  function hasDispatch(hook) {
    return !!(hook && hook.queue && typeof hook.queue.dispatch === "function");
  }

  function isBlankValue(value) {
    return String(value == null ? "" : value).trim() === "";
  }

  function isEmptyLiquidationRecord(record) {
    if (!record || typeof record !== "object") return true;
    return [
      record.transactionDate,
      record.time,
      record.from,
      record.to,
      record.modeOfTransportation,
      record.amount,
      record.perDiem,
      record.breakfast,
      record.lunch,
      record.dinner,
      record.others,
      record.remarks,
    ].every(isBlankValue);
  }

  function findAppFiber() {
    var anchor = findLiquidationCard() || document.getElementById("root");
    var fiber = getFiberFromElement(anchor);
    while (fiber) {
      if (fiber.memoizedState) {
        var captures = getHookAt(fiber, 23);
        var rows = getHookAt(fiber, 25);
        var loadingA = getHookAt(fiber, 26);
        var loadingB = getHookAt(fiber, 27);
        var loadingC = getHookAt(fiber, 28);
        if (Array.isArray(captures && captures.memoizedState) &&
            Array.isArray(rows && rows.memoizedState) &&
            typeof (loadingA && loadingA.memoizedState) === "boolean" &&
            typeof (loadingB && loadingB.memoizedState) === "boolean" &&
            typeof (loadingC && loadingC.memoizedState) === "boolean" &&
            hasDispatch(captures) &&
            hasDispatch(rows)) {
          return fiber;
        }
      }
      fiber = fiber.return;
    }
    return null;
  }

  function getLiquidationRowsFromState() {
    var fiber = findAppFiber();
    var hook = getHookAt(fiber, 25);
    return Array.isArray(hook && hook.memoizedState) ? hook.memoizedState : [];
  }

  function hasLiquidationRecord(record) {
    if (!record) return false;
    var rows = getLiquidationRowsFromState();
    if (record.id && rows.some(function (row) { return row && row.id === record.id; })) return true;
    return !!findMatchingRow(record);
  }

  function addLiquidationRowViaState(record) {
    if (hasLiquidationRecord(record)) return true;
    var fiber = findAppFiber();
    var hook = getHookAt(fiber, 25);
    if (!hasDispatch(hook)) return false;
    try {
      hook.queue.dispatch(function (prev) {
        var rows = Array.isArray(prev) ? prev : [];
        if (record.id && rows.some(function (row) { return row && row.id === record.id; })) return rows;
        var nextRecord = Object.assign({}, record);
        for (var i = 0; i < rows.length; i += 1) {
          if (isEmptyLiquidationRecord(rows[i])) {
            return rows.map(function (row, index) {
              return index === i ? Object.assign({}, row, nextRecord, { id: row.id || nextRecord.id }) : row;
            });
          }
        }
        return rows.concat([record]);
      });
      return true;
    } catch (err) {
      console.warn("[ipas-ter-recorder] Liquidation state insert failed:", err);
      return false;
    }
  }

  function addTicketViaState(file) {
    if (!file) return true;
    var fiber = findAppFiber();
    var hook = getHookAt(fiber, 23);
    if (!hasDispatch(hook)) return false;
    try {
      var capture = {
        id: "travel-ticket-" + Date.now() + "-" + Math.random().toString(36).slice(2),
        file: file,
        previewUrl: URL.createObjectURL(file),
        capturedAt: new Date().toLocaleString(),
        capturedOn: formatDate(new Date()),
      };
      hook.queue.dispatch(function (prev) {
        var captures = Array.isArray(prev) ? prev : [];
        return captures.concat([capture]);
      });
      return true;
    } catch (err) {
      console.warn("[ipas-ter-recorder] Supporting document state insert failed:", err);
      return false;
    }
  }

  function findAddRowButton() {
    var card = findLiquidationCard();
    if (!card) return null;
    var buttons = card.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i += 1) {
      if ((buttons[i].textContent || "").trim() === "Add Row") return buttons[i];
    }
    return null;
  }

  function findDataRows() {
    var card = findLiquidationCard();
    if (!card) return [];
    return Array.from(card.querySelectorAll("tbody tr")).filter(function (row) {
      return row.querySelectorAll("input").length >= 10;
    });
  }

  function getRowInputs(row) {
    return row ? Array.from(row.querySelectorAll("input")) : [];
  }

  function isEmptyDomRow(row) {
    var inputs = getRowInputs(row);
    if (inputs.length < 10) return false;
    return inputs.every(function (input) {
      return String(input.value || "").trim() === "";
    });
  }

  function rowMatchesRecord(row, record) {
    var inputs = getRowInputs(row);
    if (inputs.length < 6) return false;
    var expected = [
      record.transactionDate,
      record.time,
      record.from,
      record.to,
      record.modeOfTransportation,
      record.amount,
    ];
    for (var i = 0; i < expected.length; i += 1) {
      if (String(inputs[i].value || "").trim() !== String(expected[i] || "").trim()) {
        return false;
      }
    }
    return true;
  }

  function fillDomRow(row, record) {
    var inputs = getRowInputs(row);
    if (inputs.length < 6) return false;
    var values = [
      record.transactionDate,
      record.time,
      record.from,
      record.to,
      record.modeOfTransportation,
      record.amount,
      record.perDiem,
      record.breakfast,
      record.lunch,
      record.dinner,
      record.remarks,
    ];
    for (var i = 0; i < values.length && i < inputs.length; i += 1) {
      nativeSetValue(inputs[i], values[i]);
    }
    return true;
  }

  function findMatchingRow(record) {
    var rows = findDataRows();
    for (var i = 0; i < rows.length; i += 1) {
      if (rowMatchesRecord(rows[i], record)) return rows[i];
    }
    return null;
  }

  function waitForTableRecord(record, timeoutMs) {
    var started = Date.now();
    return new Promise(function (resolve) {
      function check() {
        if (findMatchingRow(record)) {
          resolve(true);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(check, 100);
      }
      check();
    });
  }

  function addLiquidationRowViaDom(record) {
    if (hasLiquidationRecord(record)) return Promise.resolve(true);
    var button = findAddRowButton();
    var rows = findDataRows();
    var existingEmptyRow = rows.find(isEmptyDomRow);
    if (existingEmptyRow) {
      fillDomRow(existingEmptyRow, record);
      return waitForTableRecord(record, 1200);
    }
    if (!button) return Promise.resolve(false);
    var before = rows.length;
    button.click();
    return new Promise(function (resolve) {
      var attempts = 0;
      var timer = setInterval(function () {
        attempts += 1;
        var rows = findDataRows();
        if (rows.length > before || attempts > 20) {
          clearInterval(timer);
          var row = rows[rows.length - 1];
          if (!row) { resolve(false); return; }
          fillDomRow(row, record);
          waitForTableRecord(record, 1200).then(resolve);
        }
      }, 100);
    });
  }

  function dataURLToFile(dataURL, fileName) {
    var parts = dataURL.split(",");
    var mime = (parts[0].match(/:(.*?);/) || [])[1] || "image/jpeg";
    var binary = atob(parts[1] || "");
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], fileName, { type: mime });
  }

  function findButtonByText(label) {
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i += 1) {
      if ((buttons[i].textContent || "").trim() === label) return buttons[i];
    }
    return null;
  }

  function findTabButton(sectionLabel, childLabel, nextSectionLabel) {
    var buttons = Array.from(document.querySelectorAll("button"));
    var start = -1;
    var end = buttons.length;
    for (var i = 0; i < buttons.length; i += 1) {
      var text = (buttons[i].textContent || "").trim();
      if (start < 0 && text === sectionLabel) start = i;
      else if (start >= 0 && nextSectionLabel && text === nextSectionLabel) {
        end = i;
        break;
      }
    }
    if (start < 0) return null;
    for (var j = start + 1; j < end; j += 1) {
      if ((buttons[j].textContent || "").trim() === childLabel) return buttons[j];
    }
    return null;
  }

  function navigateToSupportingDocument(callback) {
    var tab = findTabButton("Travel Expense Report", "Supporting Document", "Management");
    if (tab) {
      tab.click();
      setTimeout(callback, 900);
      return;
    }
    var section = findButtonByText("Travel Expense Report");
    if (section) {
      section.click();
      setTimeout(function () {
        var retry = findTabButton("Travel Expense Report", "Supporting Document", "Management");
        if (retry) retry.click();
        setTimeout(callback, 900);
      }, 500);
      return;
    }
    setTimeout(callback, 0);
  }

  function findSupportingDropZone() {
    var hints = [
      "Drop supporting documents here",
      "Images, PDFs, spreadsheets, and other document files",
      "Saved for upload",
    ];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var text = (node.nodeValue || "").trim();
      var hit = hints.some(function (hint) { return text.indexOf(hint) !== -1; });
      if (!hit) continue;
      var el = node.parentElement;
      for (var depth = 0; el && depth < 10; depth += 1) {
        var cls = typeof el.className === "string" ? el.className : "";
        if (cls.indexOf("border-dashed") !== -1) return el;
        el = el.parentElement;
      }
    }
    return null;
  }

  function injectTicketViaDropZone(file) {
    if (!file) return Promise.resolve(true);
    return new Promise(function (resolve) {
      navigateToSupportingDocument(function () {
        var zone = findSupportingDropZone();
        if (!zone) { resolve(false); return; }
        try {
          var data = new DataTransfer();
          data.items.add(file);
          var opts = { bubbles: true, cancelable: true, dataTransfer: data };
          zone.dispatchEvent(new DragEvent("dragenter", opts));
          zone.dispatchEvent(new DragEvent("dragover", opts));
          zone.dispatchEvent(new DragEvent("drop", opts));
          zone.dispatchEvent(new DragEvent("dragleave", opts));
          resolve(true);
        } catch (err) {
          console.warn("[ipas-ter-recorder] Supporting document drop failed:", err);
          resolve(false);
        }
      });
    });
  }

  function readField(name) {
    var el = document.querySelector("#" + PANEL_ID + " [name='" + name + "']");
    return el ? el.value.trim() : "";
  }

  function buildRecord() {
    return {
      id: getDraftId(),
      sourceName: state.ticketFile ? state.ticketFile.name : "Mobile Travel Entry",
      transactionDate: state.date,
      time: state.timeRange,
      from: readField("ter_from"),
      to: readField("ter_to"),
      modeOfTransportation: readField("ter_transport"),
      amount: readField("ter_amount"),
      perDiem: "",
      breakfast: "",
      lunch: "",
      dinner: "",
      others: "",
      remarks: readField("ter_remarks"),
      notes: "Created with TER Travel Entry Recorder",
    };
  }

  function validateRecord(record) {
    if (!state.departTime) return "Click to Depart before saving.";
    if (!state.arriveTime) return "Click to Arrive before saving.";
    if (!record.modeOfTransportation) return "Transportation Type is required.";
    if (!record.from) return "From / Origin is required.";
    if (!record.to) return "To / Destination is required.";
    if (!record.amount) return "Amount / Fare is required.";
    var amount = Number(record.amount);
    if (!Number.isFinite(amount) || amount < 0) return "Amount / Fare must be numeric.";
    return "";
  }

  function resetRecorder(keepStatus) {
    state.date = "";
    state.departTime = "";
    state.arriveTime = "";
    state.timeRange = "";
    state.departDate = null;
    state.entryId = "";
    clearTicket(false);
    stopCamera();
    ["ter_from", "ter_to", "ter_amount", "ter_remarks"].forEach(function (name) {
      var el = document.querySelector("#" + PANEL_ID + " [name='" + name + "']");
      if (el) el.value = "";
    });
    var select = document.querySelector("#" + PANEL_ID + " [name='ter_transport']");
    if (select) select.value = "";
    updateTimeDisplay();
    if (!keepStatus) setStatus("");
  }

  async function openCamera() {
    setStatus("");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("Camera is not available in this browser.", true);
      return;
    }
    stopCamera();
    try {
      var constraints = [
        { video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
        { video: { facingMode: { ideal: "environment" } }, audio: false },
        { video: true, audio: false },
      ];
      var stream = null;
      for (var i = 0; i < constraints.length; i += 1) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints[i]);
          break;
        } catch (_) {}
      }
      if (!stream) {
        setStatus("Unable to open camera. Please allow camera access.", true);
        return;
      }
      state.stream = stream;
      var video = document.querySelector("#" + PANEL_ID + " video");
      var preview = document.querySelector("#" + PANEL_ID + " [data-ter-video-box]");
      if (preview) preview.classList.add("active");
      if (video) {
        video.srcObject = stream;
        video.play().catch(function () {});
      }
      setStatus("Camera ready for ticket capture.");
    } catch (err) {
      setStatus((err && err.message) || "Unable to open camera.", true);
    }
  }

  function captureTicket() {
    var video = document.querySelector("#" + PANEL_ID + " video");
    if (!video || !state.stream) {
      setStatus("Open Camera before capturing a ticket.", true);
      return;
    }
    var width = video.videoWidth || 1280;
    var height = video.videoHeight || 720;
    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext("2d");
    if (!ctx) {
      setStatus("Unable to capture ticket image.", true);
      return;
    }
    ctx.drawImage(video, 0, 0, width, height);
    var dataURL = canvas.toDataURL("image/jpeg", 0.9);
    clearTicket(false);
    var safeFrom = readField("ter_from").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
    var name = "ter-ticket-" + (safeFrom || "travel") + "-" + Date.now() + ".jpg";
    state.ticketFile = dataURLToFile(dataURL, name);
    state.ticketPreviewUrl = URL.createObjectURL(state.ticketFile);
    state.ticketImageData = dataURL;
    state.ticketFileName = name;
    state.ticketMimeType = state.ticketFile.type || "image/jpeg";
    var image = document.querySelector("#" + PANEL_ID + " [data-ter-ticket-preview]");
    var preview = document.querySelector("#" + PANEL_ID + " [data-ter-ticket-box]");
    if (image) image.src = state.ticketPreviewUrl;
    if (preview) preview.classList.add("active");
    setStatus("Ticket captured. Save Travel Entry when ready.");
    persistDraft();
  }

  function depart() {
    var now = new Date();
    state.departDate = now;
    state.date = formatDate(now);
    state.departTime = formatTime(now);
    state.arriveTime = "";
    state.timeRange = "";
    updateTimeDisplay();
    setStatus("Departure time recorded.");
    persistDraft();
  }

  function arrive() {
    if (!state.departTime) {
      setStatus("Click to Depart first.", true);
      return;
    }
    var now = new Date();
    state.arriveTime = formatTime(now);
    state.timeRange = state.departTime + " to " + state.arriveTime;
    updateTimeDisplay();
    setStatus("Arrival time recorded.");
    persistDraft();
  }

  async function saveTravelEntry() {
    var record = buildRecord();
    var error = validateRecord(record);
    if (error) {
      setStatus(error, true);
      return;
    }
    setStatus("Saving travel entry...");
    var rowSaved = addLiquidationRowViaState(record);
    if (rowSaved) rowSaved = await waitForTableRecord(record, 1400);
    if (!rowSaved) rowSaved = await addLiquidationRowViaDom(record);
    if (!rowSaved) {
      setStatus("Unable to insert travel entry into Liquidation table.", true);
      return;
    }

    var ticketSaved = true;
    if (state.ticketFile) {
      ticketSaved = addTicketViaState(state.ticketFile);
      if (!ticketSaved) ticketSaved = await injectTicketViaDropZone(state.ticketFile);
    }

    if (!ticketSaved) {
      setStatus("Travel row was inserted, but the ticket could not be attached. Draft kept for recovery.", true);
      persistDraft();
      return;
    }

    try {
      await postTravelEntry(record);
    } catch (err) {
      queuePendingEntry(toServerEntry(record));
      persistDraft();
      setStatus("Travel entry saved locally. It will sync when online.", true);
      return;
    }

    clearPersistedDraft();
    resetRecorder(true);
    setStatus("Travel entry saved to Liquidation and synced.");
  }

  function normalizeSyncedRecord(entry) {
    return {
      id: entry.id || "liquidation-mobile-" + Date.now() + "-" + Math.random().toString(36).slice(2),
      sourceName: entry.sourceName || entry.ticketFileName || "Mobile Travel Entry",
      transactionDate: entry.transactionDate || "",
      time: entry.time || "",
      from: entry.from || "",
      to: entry.to || "",
      modeOfTransportation: entry.modeOfTransportation || "",
      amount: entry.amount || "",
      perDiem: entry.perDiem || "",
      breakfast: entry.breakfast || "",
      lunch: entry.lunch || "",
      dinner: entry.dinner || "",
      others: entry.others || "",
      remarks: entry.remarks || "",
      notes: entry.notes || "Created with TER Travel Entry Recorder",
      ticketImageData: entry.ticketImageData || "",
      ticketFileName: entry.ticketFileName || "",
      ticketMimeType: entry.ticketMimeType || "",
    };
  }

  async function addSyncedTravelEntry(entry) {
    var record = normalizeSyncedRecord(entry);
    if (hasLiquidationRecord(record)) return false;
    var rowSaved = addLiquidationRowViaState(record);
    if (rowSaved) rowSaved = await waitForTableRecord(record, 1200);
    if (!rowSaved) rowSaved = await addLiquidationRowViaDom(record);
    if (!rowSaved) return false;

    if (record.ticketImageData) {
      try {
        var file = dataURLToFile(record.ticketImageData, record.ticketFileName || ("ter-ticket-" + record.id + ".jpg"));
        addTicketViaState(file);
      } catch (err) {
        console.warn("[ipas-ter-recorder] Synced ticket attach failed:", err);
      }
    }

    return true;
  }

  async function pollTravelEntries() {
    if (!isLiquidationActive()) return;
    await flushPendingEntries();
    try {
      var response = await fetch("/api/ter/travel-entries?terId=" + encodeURIComponent(getTerId()), {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: {
          "Accept": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      if (!response.ok) return;
      var payload = await response.json();
      var entries = Array.isArray(payload && payload.entries) ? payload.entries : [];
      var added = false;
      for (var i = 0; i < entries.length; i += 1) {
        if (await addSyncedTravelEntry(entries[i])) added = true;
      }
      if (added) setStatus("Travel entry synced from mobile.");
    } catch (_) {}
  }

  function startTravelEntryPolling() {
    if (state.pollTimer) return;
    pollTravelEntries();
    state.pollTimer = setInterval(pollTravelEntries, 2500);
  }

  function stopTravelEntryPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function renderPanel() {
    if (document.getElementById(PANEL_ID)) return;
    var card = findLiquidationCard();
    if (!card || !card.parentElement) return;
    var options = TRANSPORT_TYPES.map(function (type) {
      return "<option value=\"" + esc(type) + "\">" + esc(type) + "</option>";
    }).join("");
    var panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.innerHTML =
      "<div class=\"ipas-ter-recorder-head\">" +
        "<h3>Travel Entry Recorder</h3>" +
        "<div class=\"ipas-ter-recorder-status\" data-ter-status></div>" +
      "</div>" +
      "<div class=\"ipas-ter-recorder-body\">" +
        "<div class=\"ipas-ter-recorder-actions\">" +
          "<button type=\"button\" class=\"ipas-ter-recorder-button depart\" data-ter-depart-button>Click to Depart</button>" +
          "<button type=\"button\" class=\"ipas-ter-recorder-button arrive\" data-ter-arrive-button disabled>Click to Arrive</button>" +
        "</div>" +
        "<div class=\"ipas-ter-recorder-times\">" +
          "<div class=\"ipas-ter-recorder-timebox\"><span>Date</span><strong data-ter-date>-</strong></div>" +
          "<div class=\"ipas-ter-recorder-timebox\"><span>Departure</span><strong data-ter-depart>-</strong></div>" +
          "<div class=\"ipas-ter-recorder-timebox\"><span>Time Range</span><strong data-ter-range>-</strong></div>" +
        "</div>" +
        "<div class=\"ipas-ter-recorder-timebox\"><span>Arrival</span><strong data-ter-arrive>-</strong></div>" +
        "<div class=\"ipas-ter-recorder-fields\">" +
          "<div class=\"ipas-ter-recorder-field\"><label>Transportation Type</label><select name=\"ter_transport\"><option value=\"\">Select type</option>" + options + "</select></div>" +
          "<div class=\"ipas-ter-recorder-field\"><label>Amount / Fare</label><input name=\"ter_amount\" type=\"number\" min=\"0\" step=\"0.01\" inputmode=\"decimal\" placeholder=\"0.00\"></div>" +
          "<div class=\"ipas-ter-recorder-field\"><label>From / Origin</label><input name=\"ter_from\" type=\"text\" placeholder=\"Branch 48 Cadiz\"></div>" +
          "<div class=\"ipas-ter-recorder-field\"><label>To / Destination</label><input name=\"ter_to\" type=\"text\" placeholder=\"Ceres Terminal\"></div>" +
          "<div class=\"ipas-ter-recorder-field full\"><label>Address / Remarks / Details</label><textarea name=\"ter_remarks\" rows=\"2\" placeholder=\"Optional address or details\"></textarea></div>" +
        "</div>" +
        "<div class=\"ipas-ter-recorder-camera\">" +
          "<div class=\"ipas-ter-recorder-actions\">" +
            "<button type=\"button\" class=\"ipas-ter-recorder-button camera\" data-ter-open-camera>Open Camera</button>" +
            "<button type=\"button\" class=\"ipas-ter-recorder-button capture\" data-ter-capture>Capture Ticket</button>" +
          "</div>" +
          "<div class=\"ipas-ter-recorder-preview\" data-ter-video-box><video playsinline muted></video></div>" +
          "<div class=\"ipas-ter-recorder-preview\" data-ter-ticket-box><img data-ter-ticket-preview alt=\"Captured ticket preview\"></div>" +
          "<div class=\"ipas-ter-recorder-ticket-actions\">" +
            "<button type=\"button\" class=\"ipas-ter-recorder-button camera\" data-ter-retake>Retake Ticket</button>" +
            "<button type=\"button\" class=\"ipas-ter-recorder-button remove\" data-ter-remove>Remove Ticket</button>" +
          "</div>" +
        "</div>" +
        "<button type=\"button\" class=\"ipas-ter-recorder-button save\" data-ter-save>Save Travel Entry</button>" +
      "</div>";
    card.parentElement.insertBefore(panel, card);
    panel.querySelector("[data-ter-depart-button]").addEventListener("click", depart);
    panel.querySelector("[data-ter-arrive-button]").addEventListener("click", arrive);
    panel.querySelector("[data-ter-open-camera]").addEventListener("click", openCamera);
    panel.querySelector("[data-ter-capture]").addEventListener("click", captureTicket);
    panel.querySelector("[data-ter-retake]").addEventListener("click", function () {
      clearTicket();
      openCamera();
    });
    panel.querySelector("[data-ter-remove]").addEventListener("click", function () {
      clearTicket();
      setStatus("Ticket removed.");
    });
    panel.querySelector("[data-ter-save]").addEventListener("click", saveTravelEntry);
    panel.querySelectorAll("input,select,textarea").forEach(function (field) {
      field.addEventListener("input", persistDraft);
      field.addEventListener("change", persistDraft);
    });
    updateTimeDisplay();
    restoreDraftToPanel();
  }

  function syncPanel() {
    var panel = document.getElementById(PANEL_ID);
    if (!isLiquidationActive()) {
      stopTravelEntryPolling();
      if (panel) {
        stopCamera();
        panel.remove();
      }
      return;
    }
    renderPanel();
    startTravelEntryPolling();
  }

  var observer = new MutationObserver(function () { syncPanel(); });
  function start() {
    syncPanel();
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
  window.addEventListener("beforeunload", stopCamera);
  window.addEventListener("online", flushPendingEntries);
}());
