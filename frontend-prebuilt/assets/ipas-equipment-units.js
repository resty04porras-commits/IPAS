/* Equipment-only capture selection and evidence grouping. No ticket camera hooks. */
(function (root) {
  "use strict";
  if (root.__ipasEquipmentUnits) return;
  var types = ["Laptop", "Laptop Adapter", "Laptop Bag", "CPU", "Monitor", "Monitor Adapter", "CPU Adapter", "Printer", "Scanner", "Keyboard", "Mouse", "UPS", "Speaker", "Webcam", "External Drive", "Flashdrive", "Fan", "IP Phone", "Modem", "Tp-link"];
  var files = new WeakMap(), previews = new Map(), current = null, account = "", units = [], dialog = null;
  var norm = value => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  var clean = value => String(value || "").trim();
  function selection(value) {
    var type = value && types.find(type => type.toLowerCase() === clean(value.equipmentType).toLowerCase());
    var id = value && clean(value.equipmentUnitId);
    return type && /^[a-z\d][a-z\d-]{15,79}$/i.test(id) ? { equipmentType: type, equipmentUnitId: id } : null;
  }
  function component(type) {
    if (/^(?:CPU|Laptop) Adapter$/i.test(type)) return "LAPTOP ADAPTER";
    return type === "CPU" ? "SYSTEM UNIT" : clean(type).toUpperCase();
  }
  // The identifier source controls S/N > unknown serial > SNID. Manual edits
  // take priority even when the operator deliberately clears a value.
  function merge(records) {
    var groups = new Map();
    records.forEach(function (row, index) {
      var chosen = selection(row);
      var key = chosen ? "unit:" + chosen.equipmentUnitId : row.hardwareId || row.serial
        ? "fields:" + [clean(row.components).toLowerCase(), clean(row.hardwareId), clean(row.serial)].join("|")
        : "image:" + (row.captureId || row.sourceName || index);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });
    return Array.from(groups.values(), function (members) {
      var chosen = selection(members[0]);
      var result = { components: chosen ? component(chosen.equipmentType) : "", description: "", hardwareId: "", serial: "", remarks: "", captureIds: [], rowKeys: [], conflicts: [], notes: "", equipmentType: chosen?.equipmentType, equipmentUnitId: chosen?.equipmentUnitId };
      members.forEach(row => { result.captureIds.push(row.captureId); result.rowKeys.push(row.rowKey || row.captureId || row.sourceName); });
      ["components", "description", "hardwareId", "serial", "remarks"].forEach(function (field) {
        var manual = members.filter(row => (row.manualFields || []).includes(field)).sort((a,b) => (b.manualOrder || 0) - (a.manualOrder || 0))[0];
        if (manual) { result[field] = clean(manual[field]); return; }
        if (field === "components" && chosen) return;
        var candidates = members.filter(row => clean(row[field]));
        if (field === "serial") {
          var rank = row => row.serialSource === "snid" || /SNID fallback/i.test(row.notes || "") ? 1 : row.serialSource === "manufacturer" ? 3 : 2;
          var highest = Math.max(0, ...candidates.map(rank));
          candidates = candidates.filter(row => rank(row) === highest);
        }
        if (field === "description") {
          // Brand-only plus its more complete model/version is compatible.
          candidates.sort((a,b) => clean(b[field]).length - clean(a[field]).length);
          var best = candidates[0];
          if (best && candidates.every(row => norm(best[field]).includes(norm(row[field])))) candidates = [best];
        }
        var distinct = Array.from(new Map(candidates.map(row => [norm(row[field]), clean(row[field])])).values());
        if (chosen && distinct.length > 1 && field !== "remarks") {
          result.conflicts.push(field); result[field] = "";
        } else result[field] = distinct[distinct.length - 1] || "";
      });
      if (result.conflicts.length) result.notes = "Conflicting " + result.conflicts.join(", ") + " across this unit's photos. Use Modify to confirm the correct value.";
      if (result.serial && members.some(row => row.serial === result.serial && (row.serialSource === "snid" || /SNID fallback/i.test(row.notes || "")))) result.notes += " SNID fallback: manufacturer S/N has not been read.";
      return result;
    });
  }
  var localCaptures = new Map(), aliases = new Map(), photoEvents = new Map(), refreshing = null;
  var LIMIT = 4;
  function owner() { try { return clean(JSON.parse(root.localStorage.getItem("icc_user") || "null")?.employeeId); } catch (_) { return ""; } }
  function load() {
    var next = owner(); if (next === account) return;
    account = next; current = null; units = []; previews.clear(); files = new WeakMap(); localCaptures.clear(); aliases.clear(); photoEvents.clear();
    try { units = JSON.parse(root.localStorage.getItem("ipas_equipment_units_" + encodeURIComponent(account)) || "[]").filter(row => selection(row)).slice(-200); } catch (_) {}
  }
  function persist() {
    try { root.localStorage.setItem("ipas_equipment_units_" + encodeURIComponent(account), JSON.stringify(units.filter(unit => unit.serverCount > 0).slice(-200).map(unit => ({ equipmentType: unit.equipmentType, equipmentUnitId: unit.equipmentUnitId, equipmentUnitNumber: unit.equipmentUnitNumber, serverCount: unit.serverCount || 0, version: unit.version || 0 })))); } catch (_) {}
  }
  function changed() { if (root.dispatchEvent && root.CustomEvent) root.dispatchEvent(new root.CustomEvent("ipas-equipment-progress")); }
  function pendingCount(id) { return Array.from(localCaptures.values()).filter(photo => photo.equipmentUnitId === id).length; }
  function nextNumber(type) {
    return Math.max(0, ...units.filter(unit => component(unit.equipmentType) === component(type) && ((unit.serverCount || 0) + pendingCount(unit.equipmentUnitId) > 0)).map(unit => unit.equipmentUnitNumber || 0)) + 1;
  }
  function remember(value, activate, authoritative) {
    load(); var chosen = selection(value); if (!chosen || !account) return null;
    if (value.equipmentOwner && value.equipmentOwner !== account) return null;
    var unit = units.find(row => row.equipmentUnitId === chosen.equipmentUnitId);
    if (!unit) { unit = Object.assign({ equipmentUnitNumber: nextNumber(chosen.equipmentType), serverCount: 0, version: 0 }, chosen); units.push(unit); }
    unit.equipmentOwner = account;
    if (Number.isSafeInteger(value.equipmentUnitNumber) && value.equipmentUnitNumber > 0) unit.equipmentUnitNumber = value.equipmentUnitNumber;
    var version = Number(value.equipmentProgressVersion) || 0;
    if (Number.isSafeInteger(value.equipmentCaptureCount) && value.equipmentCaptureCount >= 0 &&
        (authoritative || version > (unit.version || 0) || !unit.version)) {
      unit.serverCount = value.equipmentCaptureCount; unit.version = version;
    }
    if (Array.isArray(value.captures)) value.captures.forEach(entry => photoEvents.set(entry.eventId, { ...chosen, equipmentCaptureIndex: entry.equipmentCaptureIndex }));
    if (value.eventId) photoEvents.set(value.eventId, { ...chosen, equipmentCaptureIndex: value.equipmentCaptureIndex });
    if (activate) current = unit;
    persist(); return unit;
  }
  function progress(value) {
    load(); var chosen = selection(value); if (!chosen) return null;
    if (value.equipmentOwner && value.equipmentOwner !== account) return null;
    var unit = units.find(row => row.equipmentUnitId === chosen.equipmentUnitId);
    var captured = (unit?.serverCount || 0) + pendingCount(chosen.equipmentUnitId);
    var number = captured ? unit?.equipmentUnitNumber || value.equipmentUnitNumber || nextNumber(chosen.equipmentType) : nextNumber(chosen.equipmentType);
    if (unit && !captured) unit.equipmentUnitNumber = number;
    return { ...chosen, equipmentUnitNumber: number, label: chosen.equipmentType + " " + number, captured, limit: LIMIT, remaining: Math.max(0, LIMIT - captured), nextCapture: Math.min(LIMIT, captured + 1) };
  }
  async function refresh() {
    load(); var selectedOwner = account; if (!account || typeof root.fetch !== "function") return;
    if (refreshing) return refreshing;
    var controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000);
    var task = (async function () {
      try {
        var response = await root.fetch("/api/cam/pending?unitsOnly=true", { credentials: "include", headers: { Accept: "application/json" }, signal: controller.signal });
        if (!response.ok) return;
        var data = await response.json(); if (owner() !== selectedOwner || !Array.isArray(data.units)) return;
        var known = new Set(data.units.map(unit => unit.equipmentUnitId));
        units.forEach(unit => { if (!known.has(unit.equipmentUnitId)) unit.serverCount = 0; });
        data.units.forEach(unit => remember(unit, false, true)); persist(); changed();
      } catch (_) { /* Offline capture remains bounded locally; server rechecks on push. */ }
      finally { clearTimeout(timer); }
    })();
    refreshing = task; try { await task; } finally { if (refreshing === task) refreshing = null; }
  }
  function markFiles(batch, value) {
    load(); var chosen = selection(value); if (!chosen) return;
    batch.forEach(file => { if (!files.has(file)) files.set(file, Object.assign({}, chosen)); });
    root.dispatchEvent(new root.CustomEvent("ipas-equipment-files", { detail: { files: batch, ...chosen } }));
  }
  function reserveFiles(batch, value) {
    load(); var chosen = selection(value), unit = remember(value, true); if (!chosen || !unit) return false;
    var fresh = batch.filter(file => !files.has(file));
    if (progress(chosen).captured + fresh.length > LIMIT) return false;
    fresh.forEach(file => {
      var token = "photo-" + root.crypto.randomUUID(), index = progress(chosen).captured + 1;
      var detail = { ...chosen, equipmentOwner: account, equipmentLocalCaptureId: token, equipmentCaptureIndex: index };
      files.set(file, detail); localCaptures.set(token, detail);
    });
    markFiles(batch, value); changed(); return true;
  }
  function saved(file, result) {
    load(); var local = files.get(file);
    if (!local || local.equipmentOwner !== account) return false;
    var previousUnit = local.equipmentUnitId;
    if (local?.equipmentLocalCaptureId) { localCaptures.delete(local.equipmentLocalCaptureId); aliases.set(local.equipmentLocalCaptureId, result.eventId); }
    var chosen = selection(result); if (chosen) Object.assign(local, chosen, { equipmentCaptureIndex: result.equipmentCaptureIndex });
    remember(result, current?.equipmentUnitId === previousUnit && chosen?.equipmentUnitId !== previousUnit); changed(); return true;
  }
  function markPreview(preview, value) {
    load(); var chosen = selection(value); if (!chosen) return;
    previews.set(preview, { ...previews.get(preview), ...value, ...chosen }); if (previews.size > 300) previews.delete(previews.keys().next().value);
  }
  function forgetPreview(preview) {
    load(); var detail = previews.get(preview); previews.delete(preview);
    if (detail?.equipmentLocalCaptureId) localCaptures.delete(detail.equipmentLocalCaptureId);
    changed();
  }
  function photoProgress(value) {
    var detail = previews.get(value.preview) || value;
    var eventId = value.eventId || aliases.get(detail.equipmentLocalCaptureId);
    var photo = photoEvents.get(eventId) || detail;
    var unit = progress(value);
    return unit ? { ...unit, index: photo.equipmentCaptureIndex || value.equipmentCaptureIndex || 1 } : null;
  }
  var dialogStyle = '*{box-sizing:border-box}section{width:min(500px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;background:#fff;color:#0f172a;border-radius:18px;padding:20px;box-shadow:0 20px 50px #0003}h2{font-size:20px;margin:0 0 8px}p{font-size:14px;line-height:1.5;color:#475569;margin:0 0 12px}input{width:100%;min-height:44px;border:1px solid #94a3b8;border-radius:8px;padding:10px;font:inherit}button{font:inherit;text-align:left;cursor:pointer;min-height:44px;border:1px solid #cbd5e1;border-radius:9px;padding:10px;background:#fff;color:#0f172a}button:hover:not(:disabled){background:#eff6ff}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,input:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}.top{display:flex;align-items:start;justify-content:space-between;gap:8px}.list{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.continue{display:block;width:100%;margin:10px 0;color:#1d4ed8;border-color:#93c5fd;background:#eff6ff}.unit{grid-column:1/-1}h3{font-size:14px;margin:16px 0 0}.empty{grid-column:1/-1}small{display:block;font-size:12px;color:#64748b;margin-top:4px}.progress{padding:14px;border:1px solid #bfdbfe;background:#eff6ff;border-radius:12px;margin:12px 0}.progress strong{display:block}.actions{display:grid;gap:10px;margin-top:14px}';
  function showDialog(title, html, attr) {
    load(); if (!account || !root.document || dialog) return null;
    var previous = root.document.activeElement, selectedOwner = account;
    var host = root.document.createElement("div"); host.dataset[attr || "ipasEquipmentPicker"] = "1";
    host.style.cssText = "position:fixed;inset:0;z-index:10000;background:#0f172a99;display:flex;align-items:center;justify-content:center;padding:12px;font-family:inherit;";
    var shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<style>' + dialogStyle + '</style><section role="dialog" aria-modal="true" aria-labelledby="equipment-title"><div class="top"><h2 id="equipment-title"></h2><button type="button" data-close aria-label="Cancel equipment selection">Close</button></div>' + html + '</section>';
    shadow.querySelector("h2").textContent = title; root.document.body.appendChild(host); dialog = host;
    function close() { host.remove(); if (dialog === host) dialog = null; root.document.removeEventListener("keydown", key, true); if (previous?.isConnected) previous.focus(); }
    var result = { shadow, host, close, valid: () => owner() === selectedOwner };
    function key(event) {
      if (event.key === "Escape") { event.preventDefault(); result.close(); }
      if (event.key === "Tab") {
        var controls = Array.from(shadow.querySelectorAll("button,input")).filter(node => !node.hidden && !node.disabled), first = controls[0], last = controls[controls.length - 1], active = shadow.activeElement;
        if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
      }
    }
    shadow.querySelector("[data-close]").onclick = () => result.close();
    host.onclick = event => { if (event.target === host && !event.composedPath().includes(shadow.querySelector("section"))) result.close(); };
    root.document.addEventListener("keydown", key, true);
    return result;
  }
  function choose(callback) {
    var view = showDialog("Choose equipment", '<p>One physical unit per group. Take up to 4 photos of its labels. You can move to the next unit after any photo.</p><div data-current></div><label for="equipment-search">Search equipment type</label><input id="equipment-search" type="search" placeholder="Search: Monitor, Laptop, Printer…" autocomplete="off"><h3>New unit</h3><div class="list" data-types></div><h3 data-recent-title>Continue an existing unit</h3><div class="list" data-units></div>');
    if (!view) return;
    var shadow = view.shadow, input = shadow.querySelector("input"), known = root.__ipasSmartCaptureGetGroupedRows?.() || [];
    function selected(value) {
      if (!view.valid()) { view.close(); return; }
      var chosen = remember(value, true); if (!chosen || !progress(chosen).remaining) return;
      view.close(); callback(Object.assign({}, chosen));
    }
    function unitLabel(unit) { var p = progress(unit), row = known.find(row => row.equipmentUnitId === unit.equipmentUnitId); return p.label + " · " + p.captured + "/4 photos" + (row && (row.hardwareId || row.serial) ? " — " + (row.hardwareId || row.serial) : ""); }
    function addButton(label, value, target, className) {
      var button = root.document.createElement("button"); button.type = "button"; button.textContent = label; button.className = className || "";
      button.disabled = !progress(value).remaining; button.onclick = () => selected(value); target.appendChild(button);
    }
    function paint() {
      if (!view.host.isConnected) return;
      var query = norm(input.value), typeList = shadow.querySelector("[data-types]"), unitList = shadow.querySelector("[data-units]"), currentBox = shadow.querySelector("[data-current]");
      typeList.textContent = ""; unitList.textContent = ""; currentBox.textContent = "";
      if (current) addButton((progress(current).remaining ? "Continue " : "Complete: ") + unitLabel(current), current, currentBox, "continue");
      types.filter(type => norm(type).includes(query)).forEach(type => {
        var button = root.document.createElement("button"); button.type = "button"; button.setAttribute("aria-label", type); button.textContent = type;
        var hint = root.document.createElement("small"); hint.textContent = "New " + type + " " + nextNumber(type) + " · Capture 1/4"; button.appendChild(hint);
        button.onclick = () => selected({ equipmentType: type, equipmentUnitId: "unit-" + root.crypto.randomUUID() }); typeList.appendChild(button);
      });
      units.filter(unit => progress(unit).captured > 0 && (norm(unit.equipmentType).includes(query) || norm(unitLabel(unit)).includes(query))).slice().reverse().forEach(unit => addButton("Add label: " + unitLabel(unit), unit, unitList, "unit"));
      shadow.querySelector("[data-recent-title]").hidden = !unitList.childElementCount;
      if (!typeList.childElementCount) { var p = root.document.createElement("p"); p.className = "empty"; p.textContent = "No equipment types found."; typeList.appendChild(p); }
    }
    input.oninput = paint;
    var repaint = () => paint(); root.addEventListener("ipas-equipment-progress", repaint);
    var close = view.close; view.close = () => { root.removeEventListener("ipas-equipment-progress", repaint); close(); };
    paint(); input.focus(); refresh().then(paint);
  }
  function afterCapture(value, callbacks) {
    // A delayed send must not cover an operator's existing editor or viewer.
    if (root.document && Array.from(root.document.querySelectorAll('[role="dialog"], [data-ipas-image-modify="1"], #ipas-cam-lightbox:not(.hidden)'))
      .some(node => !node.hidden && node.getClientRects().length > 0)) return;
    var p = progress(value); if (!p) return;
    var view = showDialog(p.label + " · " + p.captured + "/4 captures", '<div class="progress" role="status" aria-live="polite"><strong data-progress></strong><small data-note></small></div><p>Details from this unit\'s photos fill one row. Reading can continue in the background.</p><div class="actions"><button type="button" data-continue></button><button type="button" data-next>Next unit / component</button><button type="button" data-review>Review details</button></div>', "ipasEquipmentStep");
    if (!view) return;
    function paint() {
      var state = progress(value); view.shadow.querySelector("[data-progress]").textContent = state.label + " — " + state.captured + " of 4 captures";
      view.shadow.querySelector("[data-note]").textContent = state.remaining ? "Capture another label if fields are missing, or choose the next unit." : "Four photos reached. Review these details or choose the next unit.";
      var button = view.shadow.querySelector("[data-continue]"); button.disabled = !state.remaining;
      button.textContent = state.remaining ? "Continue " + state.label + " · Capture " + state.nextCapture + "/4" : "Maximum 4 captures reached";
    }
    var repaint = () => { if (view.host.isConnected) paint(); }; root.addEventListener("ipas-equipment-progress", repaint);
    var close = view.close; view.close = () => { root.removeEventListener("ipas-equipment-progress", repaint); close(); };
    view.shadow.querySelector("[data-continue]").onclick = () => { if (!view.valid() || !progress(value).remaining) return; view.close(); callbacks.continue?.(value); };
    view.shadow.querySelector("[data-next]").onclick = () => { if (!view.valid()) { view.close(); return; } view.close(); callbacks.next?.(); };
    view.shadow.querySelector("[data-review]").onclick = view.close; paint(); view.shadow.querySelector("[data-review]").focus();
  }
  root.__ipasEquipmentUnits = { types: types.slice(), selection, component, merge, choose, remember, progress, photoProgress, afterCapture, reserveFiles, saved, refresh,
    currentSelection: () => { load(); return current; },
    markFiles, forFile: file => files.get(file), markPreview, forgetPreview, forPreview: preview => { load(); return previews.get(preview); } };
  if (root.addEventListener) {
    ["ipas-cam-capture", "ipas-smart-capture-saved"].forEach(name => root.addEventListener(name, event => {
      if (event.detail?.captureType === "equipment" && (!event.detail.empId || clean(event.detail.empId) === owner())) { remember(event.detail, false); changed(); }
    }));
    root.addEventListener("ipas-cam-capture-deleted", event => {
      var detail = event.detail || {}; if (detail.captureType === "ticket" || (detail.empId && clean(detail.empId) !== owner())) return;
      photoEvents.delete(detail.eventId); if (selection(detail)) remember(detail, false); refresh(); changed();
    });
  }
})(globalThis);
