/* ============================================================
   IPAS Phone-Camera Sync  — client-side script  (v7)

   v7 changes on top of v6:
   - Login-page guard: camera UI is hidden on the login screen
     and only initialises after the main app sidebar is visible.
   - Auth verification: always confirms session with /api/auth/me
     before booting, so a stale localStorage token cannot trigger
     the camera panel on the login form.
   - Mobile-only fix: the desktop "Phone Camera — Live" panel is
     no longer created on mobile devices.
   - Capture-type selection on mobile:
       • "Capture Equipment" — routes image to Accountability > Smart Capture
       • "Capture Tickets"   — routes image to Travel Expense Report > Supporting Document
   - captureType is sent with every push and broadcast via SSE/pending.
   - Auto-routing on desktop: when a new capture arrives the script
     clicks the correct sidebar nav button then injects the image into
     the active drop zone with no manual "Use" step.
   - Duplicate guard unchanged; multiple different images still work.
   ============================================================ */
(function () {
  "use strict";

  /* ── constants ──────────────────────────────────────────────── */
  var AUTH_POLL_MS      = 2000;
  var POLL_FALLBACK_MS  = 8000;
  var FETCH_DEBOUNCE_MS = 2000;
  var INIT_LOOKBACK_MS  = 0; // Kept for compatibility; fresh loads now fetch saved server-side captures.
  var LS_KEYS = ["icc_user", "ipas_user", "user"];
  var DET_PREFIX = "ipas_cam_det_";

  /* AUTO_INJECT_ENABLED — inject captured images into the active module drop zone.
   * true  = images are auto-routed to Smart Capture / Supporting Document drop zones.
   * false = images appear in panel only (manual form workflow, no OCR trigger). */
  var AUTO_INJECT_ENABLED = true;

  var COMPONENT_OPTIONS = [
    "Laptop",
    "Laptop Adaptor",
    "CPU",
    "Monitor",
    "Printer",
    "Scansnap",
    "UPS",
    "Keyboard",
    "Mouse",
    "Webcam",
    "Speaker",
    "External Drive",
    "Laptop Bag",
  ];

  /* ── device detection ───────────────────────────────────────── */
  var IS_MOBILE = /Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
               || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  /* ── state ──────────────────────────────────────────────────── */
  var initialized      = false;
  var currentEmpId     = null;
  var seenEventIds     = new Set();
  var seenFingerprints = new Set();
  var lastSeenTs       = 0;
  var newCount         = 0;
  var authPollTimer    = null;
  var fetchDebTimer    = null;
  var lastFetchTime    = 0;

  /* ── per-image detail cache ─────────────────────────────────── */
  var imageDetailsCache = {};

  function storeImageDetails(fp, details) {
    imageDetailsCache[fp] = details;
    try { localStorage.setItem(DET_PREFIX + fp, JSON.stringify(details)); } catch (_) {}
  }

  function loadImageDetails(fp) {
    if (imageDetailsCache[fp]) return imageDetailsCache[fp];
    try {
      var raw = localStorage.getItem(DET_PREFIX + fp);
      if (raw) { imageDetailsCache[fp] = JSON.parse(raw); return imageDetailsCache[fp]; }
    } catch (_) {}
    return null;
  }

  /* ── fingerprint: content-based, skips the common JPEG header ──
   * canvas.toDataURL("image/jpeg", quality) writes identical JFIF headers
   * + quantization + Huffman tables for all images at the same quality.
   * Sampling only the first 120 chars means every photo from the same
   * device/session looks identical → every 2nd capture is rejected as a
   * duplicate. Fix: skip the header region and sample from actual scan data. */
  function fingerprint(imageData) {
    var raw = (imageData || "").replace(/^data:[^;]+;base64,/, "");
    var len = raw.length;
    var pos = Math.max(1200, Math.floor(len * 0.35));
    return len + ":" + raw.substring(pos, pos + 180);
  }

  /* ── read user from localStorage ───────────────────────────── */
  function readLocalUser() {
    for (var i = 0; i < LS_KEYS.length; i++) {
      try {
        var raw = localStorage.getItem(LS_KEYS[i]);
        if (!raw) continue;
        var obj = JSON.parse(raw);
        if (obj && obj.employeeId) return obj;
      } catch (_) {}
    }
    return null;
  }

  /* ── auth ───────────────────────────────────────────────────── */
  /*
   * Always verify with /api/auth/me first to confirm the server session is
   * still valid.  localStorage is used only as an offline fallback so that
   * a stale cache entry cannot cause the camera panel to appear on the login
   * form while the React app is showing a fresh 401 to the user.
   */
  function getUser() {
    return fetch("/api/auth/me", { credentials: "include", headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (serverUser) {
        if (serverUser && serverUser.employeeId) return serverUser;
        return readLocalUser(); // offline fallback only
      })
      .catch(function () { return readLocalUser(); }); // network error fallback
  }

  function startAuthPoll() {
    if (authPollTimer) return;
    authPollTimer = setInterval(function () {
      if (initialized) { clearInterval(authPollTimer); return; }
      getUser().then(function (user) {
        if (!user || !user.employeeId) return;
        clearInterval(authPollTimer);
        authPollTimer = null;
        boot(user);
      });
    }, AUTH_POLL_MS);
  }

  /* ── login-page detection ────────────────────────────────────── */
  /*
   * The login form is identified by the presence of a password input with
   * placeholder "••••" (the IPAS login form).  The main app sidebar is
   * identified by the presence of a button labelled "Barcode" or
   * "Supporting Document" inside a nav element.
   *
   * If we are on the login page when boot() fires, we defer camera UI
   * initialisation until the login form disappears and the sidebar appears.
   */
  function isLoginPageVisible() {
    var pwInputs = document.querySelectorAll("input[type='password']");
    for (var i = 0; i < pwInputs.length; i++) {
      var ph = pwInputs[i].placeholder || "";
      // Login form has placeholder "••••"; avoid matching other password inputs
      if (ph === "••••" || ph === "••••") return true;
    }
    return false;
  }

  function isMainAppVisible() {
    // The pN accordion section-header buttons are ALWAYS in the DOM after login,
    // even when the accordion is collapsed (child tab buttons are NOT always in DOM).
    // "Accountability", "Travel Expense Report", "Asset Management" only exist after login.
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var txt = (buttons[i].textContent || "").trim();
      if (txt === "Accountability" || txt === "Travel Expense Report" || txt === "Asset Management") return true;
    }
    // Fallback: main content h2 shows the active tab name (never on login screen)
    var h2s = document.querySelectorAll("h2");
    for (var j = 0; j < h2s.length; j++) {
      var t2 = h2s[j].textContent.trim();
      if (t2 === "Smart Capture Workflow" || t2 === "Liquidation Workflow" ||
          t2 === "Supporting Document"    || t2 === "File Manager"         ||
          t2 === "Asset Dashboard") return true;
    }
    return false;
  }

  /*
   * Calls cb() once the main app sidebar is rendered.
   * If the sidebar is already visible, cb() is called on the next tick.
   * Otherwise a MutationObserver watches for DOM changes until it appears.
   */
  function waitForMainApp(cb) {
    if (isMainAppVisible()) { setTimeout(cb, 0); return; }
    var observer = new MutationObserver(function () {
      if (isMainAppVisible()) {
        observer.disconnect();
        cb();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Fallback: if observer fires too late, bail out after 30 s
    setTimeout(function () { observer.disconnect(); }, 30000);
  }

  /* ── boot ────────────────────────────────────────────────────── */
  function boot(user) {
    if (initialized) return;
    initialized  = true;
    currentEmpId = String(user.employeeId);

    /*
     * Camera UI starts fresh visually, then fetches saved captures for this
     * account from the server so photos taken while this browser was closed
     * still appear after login.
     */
    try { sessionStorage.setItem("ipas_cam_uid", currentEmpId); } catch (_) {}
    try { sessionStorage.removeItem("ipas_cam_fresh"); } catch (_) {}
    seenEventIds      = new Set();
    seenFingerprints  = new Set();
    imageDetailsCache = {};
    lastSeenTs        = INIT_LOOKBACK_MS;

    function startCamera() {
      if (IS_MOBILE) initMobile();
      else           initDesktop();
    }

    if (isLoginPageVisible()) {
      waitForMainApp(startCamera);
    } else {
      startCamera();
    }
  }

  window.addEventListener("storage", function (e) {
    if (!initialized && LS_KEYS.indexOf(e.key) !== -1 && e.newValue) {
      try {
        var obj = JSON.parse(e.newValue);
        if (obj && obj.employeeId) boot(obj);
      } catch (_) {}
    }
  });

  /* ── utils ──────────────────────────────────────────────────── */
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function esc(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  /* ══════════════════════════════════════════════════════════════
     REACT DOM SYNC  — update Asset Rows table from outside React
     ══════════════════════════════════════════════════════════════ */

  /* Set a React-controlled input/textarea value and fire synthetic events */
  function setReactValue(el, value) {
    if (!el) return;
    var proto = (el.tagName === "TEXTAREA") ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /* Find the Asset Rows / Matched Record Details section in the DOM */
  function findAssetRowsSection() {
    var h3s = document.querySelectorAll("h3");
    for (var i = 0; i < h3s.length; i++) {
      var t = h3s[i].textContent.trim();
      if (t === "Asset Rows" || t === "Matched Record Details") {
        /* Walk up to the nearest rounded card wrapper */
        var el = h3s[i].parentElement;
        for (var d = 0; d < 6 && el; d++) {
          if (el.className && typeof el.className === "string" && el.className.indexOf("rounded-3xl") !== -1) return el;
          el = el.parentElement;
        }
        return h3s[i].parentElement;
      }
    }
    return null;
  }

  /* Update a single desktop table row's fields (only non-empty values) */
  function updateDesktopRow(row, fields) {
    var tds = row.querySelectorAll("td");
    if (tds.length < 6) return;
    function writeField(td, tag, val) {
      if (!td || !val || !val.trim()) return;
      var el = td.querySelector(tag);
      if (el) setReactValue(el, val.trim());
    }
    writeField(tds[1], "textarea", fields.component);
    writeField(tds[2], "textarea", fields.description);
    writeField(tds[3], "input",    fields.hardwareId);
    writeField(tds[4], "textarea", fields.serial);
    writeField(tds[5], "textarea", fields.remarks);
  }

  /* Update a single mobile card's fields */
  function updateMobileCard(card, fields) {
    /* Mobile cards use labeled inputs rendered by the <Bn> component.
       Each field is wrapped in a div with a label. We locate by label text. */
    var labels = card.querySelectorAll("label");
    function findInputByLabel(labelText) {
      for (var i = 0; i < labels.length; i++) {
        if (labels[i].textContent.trim() === labelText) {
          var wrapper = labels[i].parentElement;
          if (!wrapper) continue;
          return wrapper.querySelector("input,textarea");
        }
      }
      return null;
    }
    function writeField(labelText, val) {
      if (!val || !val.trim()) return;
      var el = findInputByLabel(labelText);
      if (el) setReactValue(el, val.trim());
    }
    writeField("Component",    fields.component);
    writeField("Description",  fields.description);
    writeField("Hardware ID",  fields.hardwareId);
    writeField("Serial",       fields.serial);
    writeField("Remarks",      fields.remarks);
  }

  /* ── React fiber helpers: locate the ne state dispatch ──────── */

  /*
   * The Smart Capture component declares its hook state in this order
   * (extracted from the compiled bundle):
   *
   *   ...
   *   [Ne, Ue] = useState([])   captured images
   *   [He, yt] = useState([])   (internal)
   *   [ne, It] = useState([])   ← ASSET ROWS — our target
   *   [vt, Ht] = useState([])
   *   [Rt, et] = useState(false)
   *   [bt, Hr] = useState(false)
   *   [fn, On] = useState(false)
   *   [Gn, Si] = useState(null)
   *   ...
   *
   * Detection pattern walking the memoizedState linked list:
   *   state[0] = Array  (ne)
   *   state[1] = Array  (vt)
   *   state[2] = bool   (Rt)
   *   state[3] = bool   (bt)
   *   state[4] = bool   (fn)
   *   state[5] = null   (Gn — initial value)
   *
   * This 6-node fingerprint is unique within the component's state chain.
   */
  function searchStateChainForAssetRows(stateHead) {
    var state = stateHead;
    while (state) {
      try {
        var s0 = state.memoizedState;
        var n1 = state.next;
        var n2 = n1 && n1.next;
        var n3 = n2 && n2.next;
        var n4 = n3 && n3.next;
        var n5 = n4 && n4.next;
        if (!n1 || !n2 || !n3) { state = state.next; continue; }
        var s1 = n1.memoizedState;
        var s2 = n2.memoizedState;
        var s3 = n3.memoizedState;

        if (Array.isArray(s0) &&
            Array.isArray(s1) &&
            typeof s2 === "boolean" &&
            typeof s3 === "boolean") {
          /* Extra confidence when rows already exist */
          var s4 = n4 ? n4.memoizedState : undefined;
          var s5 = n5 ? n5.memoizedState : undefined;
          var extraOk = (s4 === undefined) ||
                        (typeof s4 === "boolean" && (s5 === null || s5 === undefined || typeof s5 === "object"));
          if (!extraOk) { state = state.next; continue; }
          /* If non-empty, verify shape */
          if (s0.length > 0 && typeof s0[0].components === "undefined") { state = state.next; continue; }
          var dispatch = state.queue && state.queue.dispatch;
          if (dispatch) return dispatch;
        }
      } catch (_) {}
      state = state.next;
    }
    return null;
  }

  function findAssetRowsDispatch() {
    /* Find a DOM anchor inside the Smart Capture component */
    var startEl = null;

    /* Strategy 1: "Scan Details" or "Find Record" button */
    var btns = document.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      var bt = btns[i].textContent.trim();
      if (bt === "Scan Details" || bt === "Find Record") { startEl = btns[i]; break; }
    }

    /* Strategy 2: Asset Rows section header */
    if (!startEl) {
      var section = findAssetRowsSection();
      if (section) startEl = section;
    }

    if (!startEl) return null;

    /* Walk up to find a React fiber */
    var el = startEl;
    var fiberKey = null;
    while (el && el !== document.body) {
      var keys = Object.keys(el);
      fiberKey = keys.find(function (k) { return k.startsWith("__reactFiber$"); });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey || !el) return null;

    /* Walk fiber parents to find function component fibers */
    var fiber = el[fiberKey];
    while (fiber) {
      if (typeof fiber.type === "function" && fiber.memoizedState) {
        var dispatch = searchStateChainForAssetRows(fiber.memoizedState);
        if (dispatch) return dispatch;
      }
      fiber = fiber.return;
    }
    return null;
  }

  /* Add a brand-new asset row via React fiber dispatch */
  function addRowViaFiber(fields) {
    var dispatch = findAssetRowsDispatch();
    if (!dispatch) return false;
    var newRow = {
      id:          "cam-manual-" + Date.now() + "-" + Math.floor(Math.random() * 99999),
      sourceName:  "cam-manual",
      components:  fields.component  || "",
      description: fields.description || "",
      hardwareId:  fields.hardwareId  || "",
      serial:      fields.serial      || "",
      remarks:     fields.remarks     || "New Accountability",
      notes:       "",
    };
    try {
      dispatch(function (prev) {
        var arr = Array.isArray(prev) ? prev : [];
        return arr.concat([newRow]);
      });
      return true;
    } catch (err) {
      console.warn("[ipas-cam] fiber dispatch failed:", err);
      return false;
    }
  }

  /* After a fiber add, wait for React to re-render then update fields */
  function waitAndUpdateRow(component, fields, attemptsLeft) {
    if (attemptsLeft <= 0) return;
    setTimeout(function () {
      var section = findAssetRowsSection();
      if (!section) { waitAndUpdateRow(component, fields, attemptsLeft - 1); return; }

      /* Desktop table */
      var table = section.querySelector("table");
      if (table) {
        var tbody = table.querySelector("tbody");
        var rows  = tbody ? Array.from(tbody.querySelectorAll("tr")) : [];
        for (var i = 0; i < rows.length; i++) {
          var tds = rows[i].querySelectorAll("td");
          if (tds.length < 2) continue;
          var compEl = tds[1] && tds[1].querySelector("textarea");
          if (compEl && compEl.value === component) {
            updateDesktopRow(rows[i], fields);
            return;
          }
        }
        waitAndUpdateRow(component, fields, attemptsLeft - 1);
        return;
      }

      /* Mobile cards */
      var mCards = section.querySelectorAll("[class*='rounded-3xl'][class*='border']");
      for (var j = 0; j < mCards.length; j++) {
        var lbl = mCards[j].querySelector("label");
        if (lbl && lbl.textContent.trim() === "Component") {
          var inp = mCards[j].querySelector("input,textarea");
          if (inp && inp.value === component) {
            updateMobileCard(mCards[j], fields);
            return;
          }
        }
      }
      waitAndUpdateRow(component, fields, attemptsLeft - 1);
    }, 400);
  }

  /*
   * Main sync entry point.
   * fields = { component, description, hardwareId, serial, remarks }
   * forceNew = true → always create a new row even if component matches
   * Returns: "dom-updated" | "fiber-added" | "pending" | "failed"
   */
  function syncFieldsToTable(fields, forceNew) {
    var component = (fields.component || "").trim();
    if (!component) return "failed";

    var section = findAssetRowsSection();

    /* ── Tier A: update an existing DOM row ─── */
    if (section && !forceNew) {
      /* Desktop table */
      var table = section.querySelector("table");
      if (table) {
        var tbody = table.querySelector("tbody");
        var rows  = tbody ? Array.from(tbody.querySelectorAll("tr")) : [];
        for (var i = 0; i < rows.length; i++) {
          var tds = rows[i].querySelectorAll("td");
          if (tds.length < 2) continue;
          var compEl = tds[1] && tds[1].querySelector("textarea");
          if (compEl && compEl.value === component) {
            updateDesktopRow(rows[i], fields);
            return "dom-updated";
          }
        }
      }

      /* Mobile cards (lg:hidden) */
      var mobileWrap = section.querySelector(".space-y-4");
      if (mobileWrap) {
        var mCards = mobileWrap.querySelectorAll("[class*='rounded-3xl']");
        for (var j = 0; j < mCards.length; j++) {
          var labels = mCards[j].querySelectorAll("label");
          for (var k = 0; k < labels.length; k++) {
            if (labels[k].textContent.trim() === "Component") {
              var mInp = labels[k].closest("[class]") && labels[k].parentElement &&
                         labels[k].parentElement.querySelector("input,textarea");
              if (mInp && mInp.value === component) {
                updateMobileCard(mCards[j], fields);
                return "dom-updated";
              }
            }
          }
        }
      }
    }

    /* ── Tier B: add via React fiber ─────────── */
    if (addRowViaFiber(fields)) {
      /* After fiber add, wait for React to render and update the fields */
      waitAndUpdateRow(component, fields, 8);
      return "fiber-added";
    }

    return "failed";
  }

  /* ════════════════════════════════════════════════════════════════
     SIDEBAR NAVIGATION — click the correct nav button to switch
     to the target module/tab before injecting the captured image
     ════════════════════════════════════════════════════════════════ */

  /* ── sidebar navigation helpers ─────────────────────────────── */

  /* Return the first button whose trimmed textContent matches label, or null. */
  function findButtonByText(label) {
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      if ((buttons[i].textContent || "").trim() === label) return buttons[i];
    }
    return null;
  }

  /*
   * Find the first button with text childLabel that appears in the DOM AFTER
   * the sectionLabel button and BEFORE the nextSectionLabel button (or end of
   * document if nextSectionLabel is absent or not found in DOM).
   *
   * This is safer than parent-traversal (findButtonInSection) for React
   * accordion sidebars where all section headers and their expanded children
   * are siblings in a single nav container.  Walking UP from the section
   * header reaches the nav root immediately and querySelectorAll returns ALL
   * buttons — returning the first "Barcode" encountered, which can belong to
   * Asset Management instead of Accountability.
   *
   * Position-based search guarantees we only match buttons that are rendered
   * between the target section and the next section in DOM order, which is
   * exactly the set of child buttons belonging to the target accordion section.
   */
  function findTabButton(sectionLabel, childLabel, nextSectionLabel) {
    var allBtns    = Array.from(document.querySelectorAll("button"));
    var sectionIdx = -1;
    var endIdx     = allBtns.length;

    for (var i = 0; i < allBtns.length; i++) {
      var bTxt = (allBtns[i].textContent || "").trim();
      if (sectionIdx < 0 && bTxt === sectionLabel) {
        sectionIdx = i;
      } else if (sectionIdx >= 0 && nextSectionLabel && bTxt === nextSectionLabel) {
        endIdx = i;
        break;
      }
    }

    if (sectionIdx < 0) return null; // section header not found in DOM

    for (var j = sectionIdx + 1; j < endIdx; j++) {
      if ((allBtns[j].textContent || "").trim() === childLabel) return allBtns[j];
    }
    return null; // child button not in DOM (accordion collapsed)
  }

  /*
   * Navigate to the correct sidebar tab for the given captureType, then
   * call cb() once the target tab has had time to render its drop zone.
   *
   * Equipment → Accountability > Smart Capture
   *   Drop zone: "Camera ready when you are"
   * Ticket    → Travel Expense Report > Supporting Document
   *   Drop zone: "Drop supporting documents here"
   *
   * Uses findTabButton() (position-based) to avoid clicking the wrong
   * similarly named button in another sidebar section.
   *
   * nextSection is the sidebar header immediately after the target section;
   * it bounds the search so we only match child buttons of the right section.
   */
  function navigateForCapture(captureType, cb) {
    var sectionLabel = captureType === "equipment" ? "Accountability" :
                       captureType === "ticket"    ? "Travel Expense Report" : null;
    var tabLabel     = captureType === "equipment" ? "Smart Capture" :
                       captureType === "ticket"    ? "Supporting Document" : null;
    var nextSection  = captureType === "equipment" ? "Travel Expense Report" :
                       captureType === "ticket"    ? "Management" : null;

    if (!tabLabel) { setTimeout(cb, 0); return; }

    function clickTabAndWait() {
      /* After section expansion, find the tab button within the section */
      var btn = findTabButton(sectionLabel, tabLabel, nextSection);
      if (btn) btn.click();
      setTimeout(cb, 1000);
    }

    /* Check if the tab button is already in the DOM (section already expanded) */
    var tabBtn = findTabButton(sectionLabel, tabLabel, nextSection);
    if (tabBtn) {
      tabBtn.click();
      setTimeout(cb, 1000);
      return;
    }

    /* Section collapsed — expand it first, then click the child tab */
    var sectionBtn = findButtonByText(sectionLabel);
    if (sectionBtn) {
      sectionBtn.click();
      setTimeout(clickTabAndWait, 600);
    } else {
      setTimeout(cb, 0);
    }
  }

  /* ════════════════════════════════════════════════════════════════
     MOBILE SIDE
     ════════════════════════════════════════════════════════════════ */
  function initMobile() {
    /* ── two capture buttons ────────────────────────────────────── */
    var container = document.createElement("div");
    container.id = "ipas-cam-mobile-btns";

    var btnEquip = document.createElement("button");
    btnEquip.id        = "ipas-cam-btn-equipment";
    btnEquip.type      = "button";
    btnEquip.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 0 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>' +
      '<circle cx="12" cy="13" r="4"/></svg>' +
      '<span>Equipment</span>';

    var btnTicket = document.createElement("button");
    btnTicket.id        = "ipas-cam-btn-ticket";
    btnTicket.type      = "button";
    btnTicket.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/>' +
      '<path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>' +
      '<line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>' +
      '<span>Tickets</span>';

    container.appendChild(btnEquip);
    container.appendChild(btnTicket);

    // makeCamInput creates (or re-creates) the hidden camera input.
    // Destroying and re-creating the element after each capture is the
    // only reliable way to re-open the native camera on iOS Safari —
    // setting value="" on a capture input is ignored by WebKit.
    var CAM_INPUT_STYLE = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;";
    function makeCamInput() {
      var inp = document.createElement("input");
      inp.type    = "file";
      inp.accept  = "image/*";
      inp.capture = "environment";
      inp.style.cssText = CAM_INPUT_STYLE;
      document.body.appendChild(inp);
      inp.addEventListener("change", onCamChange);
      return inp;
    }
    var fileInput = makeCamInput();

    /* Track which button was last tapped so the upload is tagged correctly */
    var pendingCaptureType = "";

    var toast = document.createElement("div");
    toast.id        = "ipas-cam-toast";
    toast.className = "hidden";
    document.body.appendChild(toast);
    document.body.appendChild(container);

    var offlineQueue = [];
    var uploading    = false;

    function showToast(msg, type) {
      toast.className = type || "";
      toast.innerHTML = (type === "uploading") ? '<div class="cam-spinner"></div> ' + msg : msg;
      if (type === "success" || type === "error") {
        setTimeout(function () { toast.className = "hidden"; }, 3500);
      }
    }

    function compressImage(file, cb) {
      var MAX = 1600, QUALITY = 0.82;
      var reader = new FileReader();
      reader.onload = function (e) {
        var img = new Image();
        var done = false;
        img.onload = function () {
          if (done) return; done = true;
          var w = img.width, h = img.height;
          if (w > MAX || h > MAX) {
            if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
            else       { w = Math.round(w * MAX / h); h = MAX; }
          }
          var cv = document.createElement("canvas");
          cv.width = w; cv.height = h;
          cv.getContext("2d").drawImage(img, 0, 0, w, h);
          cb(cv.toDataURL("image/jpeg", QUALITY), "image/jpeg");
        };
        img.onerror = function () {
          if (done) return; done = true;
          cb(e.target.result, file.type || "image/jpeg");
        };
        img.src = e.target.result;
      };
      reader.onerror = function () { showToast("Could not read image.", "error"); };
      reader.readAsDataURL(file);
    }

    function uploadImage(imageData, fileName, mimeType, captureType) {
      return fetch("/api/cam/push", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empId: currentEmpId,
          imageData: imageData,
          fileName: fileName,
          mimeType: mimeType,
          captureType: captureType || "",
        }),
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (d) { return Promise.reject(d.error || r.status); });
        return r.json();
      });
    }

    function flushQueue() {
      if (uploading || !offlineQueue.length || !navigator.onLine) return;
      uploading = true;
      var item = offlineQueue[0];
      uploadImage(item.imageData, item.fileName, item.mimeType, item.captureType)
        .then(function () { offlineQueue.shift(); uploading = false; flushQueue(); })
        .catch(function () { uploading = false; });
    }

    window.addEventListener("online", flushQueue);

    // Per-session set of file keys already processed.
    // Key = name|lastModified|size — stable metadata that uniquely identifies
    // a captured file without needing to read its content.
    var capturedFileKeys = new Set();

    // Build a stable key from file metadata.
    // iOS always returns name="image.jpg" with lastModified=0, so size is the
    // only differentiator there; on Android, lastModified changes per capture.
    function fileKey(f) {
      return (f.name || "?") + "|" + (f.lastModified || 0) + "|" + f.size;
    }

    var handlingChange = false;

    // Named handler attached to every fresh input element by makeCamInput().
    function onCamChange() {
      // Gate 1: prevent re-entry while a capture is in flight.
      if (handlingChange) return;
      if (!fileInput) return;
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;

      // Gate 2: file-key dedup.
      // Android re-delivers the same camera photo to every new <input capture>
      // element that appears in DOM during its async photo-processing pipeline.
      // That caused the previous makeCamInput() approach to fire onCamChange
      // 4-5 times for a single tap, producing 4-5 uploads per capture.
      // Checking the raw file metadata (before any compression) blocks every
      // duplicate delivery of the same photo regardless of how many times the
      // change event fires or how many input elements Android targets.
      var fk = fileKey(file);
      if (capturedFileKeys.has(fk)) return;
      capturedFileKeys.add(fk);

      handlingChange = true;

      // Capture the pending type before removing the input — it is set by the
      // button handler and cleared after the upload is dispatched.
      var captureType = pendingCaptureType;

      // Remove the current input from DOM immediately.
      // Crucially: do NOT create a replacement yet.  A new input is only
      // created when the user explicitly taps a capture button again.
      try { document.body.removeChild(fileInput); } catch (_) {}
      fileInput = null;

      // Always generate a unique timestamped filename so every card in the
      // panel has a distinct name (iOS returns "image.jpg" for all captures).
      var dot = (file.name || "").lastIndexOf(".");
      var ext = (dot >= 0 ? file.name.substring(dot) : ".jpg") || ".jpg";
      var label = captureType === "ticket" ? "ticket" : "capture";
      var fileName = label + "-" + Date.now() + ext;

      var toastLabel = captureType === "equipment" ? "equipment photo" :
                       captureType === "ticket"    ? "ticket photo"    : "photo";

      showToast("Compressing " + toastLabel + "…", "uploading");
      compressImage(file, function (imageData, mimeType) {
        showToast("Sending to desktop…", "uploading");
        uploadImage(imageData, fileName, mimeType, captureType)
          .then(function (data) {
            handlingChange = false;
            pendingCaptureType = "";
            if (data && data.duplicate) { showToast("Already uploaded.", "success"); }
            else {
              var dest = captureType === "equipment" ? " → Smart Capture" :
                         captureType === "ticket"    ? " → Supporting Documents" : "";
              showToast("✓ Sent to desktop!" + dest, "success");
            }
          })
          .catch(function (err) {
            handlingChange = false;
            // Keep fk in capturedFileKeys — the offline queue will retry.
            console.warn("[ipas-cam] push failed:", err);
            offlineQueue.push({ imageData: imageData, fileName: fileName, mimeType: mimeType, captureType: captureType });
            showToast("Saved. Will retry when online.", "error");
          });
      });
    }

    function openCamera(captureType) {
      pendingCaptureType = captureType;
      if (!fileInput) {
        fileInput = makeCamInput();
      }
      // Always clear the in-flight guard before opening the camera so the
      // user can never get permanently locked out by a stale flag.
      handlingChange = false;
      fileInput.click();
    }

    btnEquip.addEventListener("click", function () { openCamera("equipment"); });
    btnTicket.addEventListener("click", function () { openCamera("ticket"); });

    flushQueue();
  }

  /* ════════════════════════════════════════════════════════════════
     DESKTOP SIDE
     ════════════════════════════════════════════════════════════════ */
  function initDesktop() {
    if (document.getElementById("ipas-cam-panel")) return;
    /* lastSeenTs is already set by boot() based on session detection */

    /* ── panel ─────────────────────────────────────────────────── */
    var panel = document.createElement("div");
    panel.id  = "ipas-cam-panel";
    panel.innerHTML =
      '<div id="ipas-cam-panel-header">' +
        '<div id="ipas-cam-status-dot" class="connecting"></div>' +
        '<div id="ipas-cam-panel-title">Phone Camera</div>' +
        '<div id="ipas-cam-count-badge"></div>' +
        '<button id="ipas-cam-panel-toggle" title="Collapse / Expand" aria-label="Toggle panel">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
          ' stroke-width="2.5" stroke-linecap="round"><polyline points="18 15 12 9 6 15"/></svg>' +
        '</button>' +
      '</div>' +
      '<div id="ipas-cam-panel-body">' +
        '<div id="ipas-cam-empty">' +
          '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
          ' stroke-width="1.5" stroke-linecap="round">' +
          '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 0 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>' +
          '<circle cx="12" cy="13" r="4"/></svg>' +
          'Waiting for phone camera&hellip;<br>' +
          'Open this page on your phone and tap <strong>Equipment</strong> or <strong>Tickets</strong>.' +
        '</div>' +
      '</div>';
    document.body.appendChild(panel);

    /* ── enhanced lightbox ─────────────────────────────────────── */
    var lightbox = document.createElement("div");
    lightbox.id        = "ipas-cam-lightbox";
    lightbox.className = "hidden";
    lightbox.setAttribute("role", "dialog");
    lightbox.setAttribute("aria-modal", "true");
    lightbox.setAttribute("aria-label", "Captured image viewer");

    /* Build component options HTML */
    var optionsHtml = '<option value="">— Select Component —</option>';
    for (var oi = 0; oi < COMPONENT_OPTIONS.length; oi++) {
      optionsHtml += '<option value="' + esc(COMPONENT_OPTIONS[oi]) + '">' + esc(COMPONENT_OPTIONS[oi]) + '</option>';
    }
    var remarksOptions = [
      "New Accountability",
      "Transfer Accountability From",
      "Transfer Accountability To",
      "For Disposal",
      "Defective Asset",
      "Spare Asset",
    ];
    var remarksOptionsHtml = "";
    for (var ri = 0; ri < remarksOptions.length; ri++) {
      remarksOptionsHtml += '<option value="' + esc(remarksOptions[ri]) + '">' + esc(remarksOptions[ri]) + '</option>';
    }

    lightbox.innerHTML =
      '<div id="ipas-cam-lightbox-box">' +
        /* title bar */
        '<div id="ipas-cam-lightbox-titlebar">' +
          '<span id="ipas-cam-lightbox-filename" title=""></span>' +
          '<div class="cam-lbx-titlebar-actions">' +
            '<button id="ipas-cam-lbx-download" type="button" title="Download image">' +
              '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
              ' Download' +
            '</button>' +
            '<button id="ipas-cam-lbx-fullscreen" type="button" title="Fullscreen">' +
              '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>' +
              ' Fullscreen' +
            '</button>' +
            '<button id="ipas-cam-lbx-close" type="button" title="Close">' +
              '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
              ' Close' +
            '</button>' +
          '</div>' +
        '</div>' +
        /* image */
        '<div id="ipas-cam-lightbox-img-wrap">' +
          '<img id="ipas-cam-lbx-img" alt="Captured image">' +
        '</div>' +
        /* equipment details form — Set 1 (default, auto-syncs) + Set 2 (checkbox-gated) */
        '<div id="ipas-cam-lightbox-form">' +
          /* ── Set 1 ── */
          '<div class="cam-lbx-set">' +
            '<div class="cam-lbx-set-hdr">' +
              '<span class="cam-lbx-set-tag cam-lbx-set-tag-1">Set 1</span>' +
              '<span class="cam-lbx-set-desc">Default &mdash; values sync to Matched Record Details as you type</span>' +
            '</div>' +
            '<div class="cam-lbx-form-grid">' +
              '<div class="cam-lbx-field cam-lbx-field-full">' +
                '<label class="cam-lbx-label" for="ipas-cam-lbx-component">Component</label>' +
                '<select id="ipas-cam-lbx-component" class="cam-lbx-select">' + optionsHtml + '</select>' +
              '</div>' +
              '<div class="cam-lbx-field">' +
                '<label class="cam-lbx-label" for="ipas-cam-lbx-desc">Description</label>' +
                '<input id="ipas-cam-lbx-desc" type="text" class="cam-lbx-input" placeholder="e.g. ThinkPad X1 Carbon">' +
              '</div>' +
              '<div class="cam-lbx-field">' +
                '<label class="cam-lbx-label" for="ipas-cam-lbx-hwid">Hardware ID</label>' +
                '<input id="ipas-cam-lbx-hwid" type="text" class="cam-lbx-input" placeholder="e.g. LAD-2026-011">' +
              '</div>' +
              '<div class="cam-lbx-field">' +
                '<label class="cam-lbx-label" for="ipas-cam-lbx-serial">Serial Number</label>' +
                '<input id="ipas-cam-lbx-serial" type="text" class="cam-lbx-input" placeholder="e.g. SN123456">' +
              '</div>' +
              '<div class="cam-lbx-field">' +
                '<label class="cam-lbx-label" for="ipas-cam-lbx-remarks">Remarks</label>' +
                '<select id="ipas-cam-lbx-remarks" class="cam-lbx-select">' + remarksOptionsHtml + '</select>' +
                '<input id="ipas-cam-lbx-remarks-staff" type="text" class="cam-lbx-input" placeholder="Staff name" style="display:none;margin-top:8px;">' +
              '</div>' +
            '</div>' +
          '</div>' +
          /* ── Set 2 (second unit of same component type) ── */
          '<div class="cam-lbx-set cam-lbx-set2-wrap">' +
            '<div class="cam-lbx-set-hdr">' +
              '<label class="cam-lbx-set2-toggle-lbl">' +
                '<input id="ipas-cam-lbx-set2" type="checkbox" class="cam-lbx-checkbox">' +
                '<span class="cam-lbx-set-tag cam-lbx-set-tag-2">Set 2</span>' +
                '<span class="cam-lbx-set-desc">Check to add a second unit of the same component type</span>' +
              '</label>' +
            '</div>' +
            '<div id="ipas-cam-lbx-set2-fields" class="cam-lbx-set2-fields cam-lbx-set2-disabled">' +
              '<div class="cam-lbx-form-grid">' +
                '<div class="cam-lbx-field cam-lbx-field-full">' +
                  '<label class="cam-lbx-label" for="ipas-cam-lbx-s2-component">Component</label>' +
                  '<select id="ipas-cam-lbx-s2-component" class="cam-lbx-select" disabled>' + optionsHtml + '</select>' +
                '</div>' +
                '<div class="cam-lbx-field">' +
                  '<label class="cam-lbx-label" for="ipas-cam-lbx-s2-desc">Description</label>' +
                  '<input id="ipas-cam-lbx-s2-desc" type="text" class="cam-lbx-input" placeholder="e.g. ThinkPad X1 Carbon" disabled>' +
                '</div>' +
                '<div class="cam-lbx-field">' +
                  '<label class="cam-lbx-label" for="ipas-cam-lbx-s2-hwid">Hardware ID</label>' +
                  '<input id="ipas-cam-lbx-s2-hwid" type="text" class="cam-lbx-input" placeholder="e.g. LAD-2026-012" disabled>' +
                '</div>' +
                '<div class="cam-lbx-field">' +
                  '<label class="cam-lbx-label" for="ipas-cam-lbx-s2-serial">Serial Number</label>' +
                  '<input id="ipas-cam-lbx-s2-serial" type="text" class="cam-lbx-input" placeholder="e.g. SN654321" disabled>' +
                '</div>' +
                '<div class="cam-lbx-field">' +
                  '<label class="cam-lbx-label" for="ipas-cam-lbx-s2-remarks">Remarks</label>' +
                  '<select id="ipas-cam-lbx-s2-remarks" class="cam-lbx-select" disabled>' + remarksOptionsHtml + '</select>' +
                  '<input id="ipas-cam-lbx-s2-remarks-staff" type="text" class="cam-lbx-input" placeholder="Staff name" style="display:none;margin-top:8px;" disabled>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          /* save feedback */
          '<div id="ipas-cam-lbx-feedback" class="cam-lbx-feedback hidden"></div>' +
          /* actions */
          '<div class="cam-lbx-form-actions">' +
            '<button id="ipas-cam-lbx-cancel" type="button" class="cam-lbx-btn cam-lbx-btn-cancel">Cancel</button>' +
            '<button id="ipas-cam-lbx-save"   type="button" class="cam-lbx-btn cam-lbx-btn-save">Save to Matched Record Details</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(lightbox);

    /* ── notification ──────────────────────────────────────────── */
    var notify = document.createElement("div");
    notify.id        = "ipas-cam-notify";
    notify.className = "hidden";
    document.body.appendChild(notify);

    /* ── refs ──────────────────────────────────────────────────── */
    var statusDot  = document.getElementById("ipas-cam-status-dot");
    var panelBody  = document.getElementById("ipas-cam-panel-body");
    var panelTitle = document.getElementById("ipas-cam-panel-title");
    var badge      = document.getElementById("ipas-cam-count-badge");
    var toggleBtn  = document.getElementById("ipas-cam-panel-toggle");
    var emptyDiv   = document.getElementById("ipas-cam-empty");
    var collapsed  = false;
    var notifyTimer = null;

    /* ── offline-capture retry queue ────────────────────────────── */
    /* Equipment captures that arrived before Smart Capture was active.
     * Drained automatically when Smart Capture opens (MutationObserver). */
    var pendingEquipmentRetries = []; // [{entry, card}]
    var injectedEventIds        = new Set();  // dedup: eventIds already applied
    var smartCaptureRetryTimer  = null;
    var smartCaptureObserver    = null;

    /* lightbox refs */
    var lbxBox        = document.getElementById("ipas-cam-lightbox-box");
    var lbxFilename   = document.getElementById("ipas-cam-lightbox-filename");
    var lbxImg        = document.getElementById("ipas-cam-lbx-img");
    var lbxDownload   = document.getElementById("ipas-cam-lbx-download");
    var lbxFullscreen = document.getElementById("ipas-cam-lbx-fullscreen");
    var lbxClose      = document.getElementById("ipas-cam-lbx-close");
    var lbxComponent  = document.getElementById("ipas-cam-lbx-component");
    var lbxDesc       = document.getElementById("ipas-cam-lbx-desc");
    var lbxHwId       = document.getElementById("ipas-cam-lbx-hwid");
    var lbxSerial     = document.getElementById("ipas-cam-lbx-serial");
    var lbxRemarks    = document.getElementById("ipas-cam-lbx-remarks");
    var lbxRemarksStaff = document.getElementById("ipas-cam-lbx-remarks-staff");
    /* Set 2 refs */
    var lbxSet2       = document.getElementById("ipas-cam-lbx-set2");
    var lbxSet2Fields = document.getElementById("ipas-cam-lbx-set2-fields");
    var lbxS2Comp     = document.getElementById("ipas-cam-lbx-s2-component");
    var lbxS2Desc     = document.getElementById("ipas-cam-lbx-s2-desc");
    var lbxS2HwId     = document.getElementById("ipas-cam-lbx-s2-hwid");
    var lbxS2Serial   = document.getElementById("ipas-cam-lbx-s2-serial");
    var lbxS2Remarks  = document.getElementById("ipas-cam-lbx-s2-remarks");
    var lbxS2RemarksStaff = document.getElementById("ipas-cam-lbx-s2-remarks-staff");
    var lbxSave       = document.getElementById("ipas-cam-lbx-save");
    var lbxCancel     = document.getElementById("ipas-cam-lbx-cancel");
    var lbxFeedback   = document.getElementById("ipas-cam-lbx-feedback");

    var currentEntry = null; /* entry currently open in lightbox */

    var TRANSFER_FROM_REMARK = "Transfer Accountability From";
    var TRANSFER_TO_REMARK = "Transfer Accountability To";

    function isTransferRemark(value) {
      return value === TRANSFER_FROM_REMARK || value === TRANSFER_TO_REMARK;
    }

    function parseRemarksValue(value) {
      var raw = String(value || "").trim();
      if (raw.indexOf(TRANSFER_FROM_REMARK) === 0) {
        return { option: TRANSFER_FROM_REMARK, staff: raw.slice(TRANSFER_FROM_REMARK.length).trim() };
      }
      if (raw.indexOf(TRANSFER_TO_REMARK) === 0) {
        return { option: TRANSFER_TO_REMARK, staff: raw.slice(TRANSFER_TO_REMARK.length).trim() };
      }
      if (remarksOptions.indexOf(raw) !== -1) {
        return { option: raw, staff: "" };
      }
      return { option: "New Accountability", staff: "" };
    }

    function updateRemarksStaffInput(selectEl, staffEl) {
      var show = isTransferRemark(selectEl.value);
      staffEl.style.display = show ? "" : "none";
      staffEl.disabled = selectEl.disabled || !show;
      if (!show) staffEl.value = "";
    }

    function setRemarksControl(selectEl, staffEl, value) {
      var parsed = parseRemarksValue(value);
      selectEl.value = parsed.option;
      staffEl.value = parsed.staff;
      updateRemarksStaffInput(selectEl, staffEl);
    }

    function getRemarksValue(selectEl, staffEl) {
      var option = selectEl.value || "New Accountability";
      var staff = String(staffEl.value || "").trim();
      return isTransferRemark(option) && staff ? option + " " + staff : option;
    }

    /* ── notification flash ────────────────────────────────────── */
    function showNotify(msg) {
      notify.innerHTML = msg;
      notify.classList.remove("hidden");
      clearTimeout(notifyTimer);
      notifyTimer = setTimeout(function () { notify.classList.add("hidden"); }, 4000);
    }

    /* ── collapse ──────────────────────────────────────────────── */
    function setCollapsed(val) {
      collapsed = val;
      panelBody.classList.toggle("collapsed", val);
      toggleBtn.setAttribute("aria-expanded", String(!val));
      var poly = toggleBtn.querySelector("polyline");
      if (poly) poly.setAttribute("points", val ? "6 9 12 15 18 9" : "18 15 12 9 6 15");
    }
    document.getElementById("ipas-cam-panel-header").addEventListener("click", function () {
      setCollapsed(!collapsed);
    });

    /* ── lightbox feedback ─────────────────────────────────────── */
    var feedbackTimer = null;
    function showFeedback(msg, type) {
      lbxFeedback.textContent = msg;
      lbxFeedback.className   = "cam-lbx-feedback cam-lbx-feedback-" + (type || "success");
      clearTimeout(feedbackTimer);
      feedbackTimer = setTimeout(function () {
        lbxFeedback.className = "cam-lbx-feedback hidden";
      }, 4000);
    }

    /* ── lightbox open / close ─────────────────────────────────── */
    function openLightbox(entry) {
      currentEntry = entry;
      var fp = fingerprint(entry.imageData);

      /* Set image and title */
      lbxImg.src = entry.imageData;
      lbxFilename.textContent = entry.fileName || "captured-image.jpg";
      lbxFilename.title       = entry.fileName || "";

      /* Load saved details for this image */
      var saved = loadImageDetails(fp) || {};
      /* Set 1 */
      lbxComponent.value = saved.component   || "";
      lbxDesc.value      = saved.description || "";
      lbxHwId.value      = saved.hardwareId  || "";
      lbxSerial.value    = saved.serial      || "";
      setRemarksControl(lbxRemarks, lbxRemarksStaff, saved.remarks || "");
      /* Set 2 */
      lbxSet2.checked  = saved.set2Enabled  || false;
      lbxS2Comp.value  = saved.set2Component   || "";
      lbxS2Desc.value  = saved.set2Description || "";
      lbxS2HwId.value  = saved.set2HardwareId  || "";
      lbxS2Serial.value  = saved.set2Serial    || "";
      setRemarksControl(lbxS2Remarks, lbxS2RemarksStaff, saved.set2Remarks || "");
      toggleSet2Fields(lbxSet2.checked);
      lbxFeedback.className = "cam-lbx-feedback hidden";

      lightbox.classList.remove("hidden");
      document.body.style.overflow = "hidden";
      lbxComponent.focus();
    }

    function closeLightbox() {
      lightbox.classList.add("hidden");
      document.body.style.overflow = "";
      currentEntry = null;
    }

    /* ── Set 2 toggle (enable / disable fields) ───────────────── */
    function toggleSet2Fields(enabled) {
      lbxSet2Fields.classList.toggle("cam-lbx-set2-disabled", !enabled);
      var set2Els = [lbxS2Comp, lbxS2Desc, lbxS2HwId, lbxS2Serial, lbxS2Remarks, lbxS2RemarksStaff];
      for (var si = 0; si < set2Els.length; si++) set2Els[si].disabled = !enabled;
      updateRemarksStaffInput(lbxS2Remarks, lbxS2RemarksStaff);
    }
    lbxSet2.addEventListener("change", function () {
      toggleSet2Fields(lbxSet2.checked);
      if (!lbxSet2.checked) {
        lbxS2Comp.value = "";
        lbxS2Desc.value = "";
        lbxS2HwId.value = "";
        lbxS2Serial.value = "";
        setRemarksControl(lbxS2Remarks, lbxS2RemarksStaff, "");
      }
    });

    /* ── Set 1 auto-sync (debounced 700 ms) ───────────────────── */
    var autoSyncTimer = null;
    function scheduleAutoSync() {
      clearTimeout(autoSyncTimer);
      autoSyncTimer = setTimeout(function () {
        var component = lbxComponent.value.trim();
        if (!component || !currentEntry) return;
        var fields = {
          component:   component,
          description: lbxDesc.value.trim(),
          hardwareId:  lbxHwId.value.trim(),
          serial:      lbxSerial.value.trim(),
          remarks:     getRemarksValue(lbxRemarks, lbxRemarksStaff),
        };
        /* Merge with existing saved data so Set 2 is not overwritten */
        var fp = fingerprint(currentEntry.imageData);
        var existing = loadImageDetails(fp) || {};
        storeImageDetails(fp, {
          component:       fields.component,
          description:     fields.description,
          hardwareId:      fields.hardwareId,
          serial:          fields.serial,
          remarks:         fields.remarks,
          set2Enabled:     existing.set2Enabled     || false,
          set2Component:   existing.set2Component   || "",
          set2Description: existing.set2Description || "",
          set2HardwareId:  existing.set2HardwareId  || "",
          set2Serial:      existing.set2Serial      || "",
          set2Remarks:     existing.set2Remarks     || "",
        });
        syncFieldsToTable(fields, false);
        showFeedback("Synced to Matched Record Details.", "success");
      }, 700);
    }
    lbxComponent.addEventListener("change", scheduleAutoSync);
    lbxDesc.addEventListener("input",       scheduleAutoSync);
    lbxHwId.addEventListener("input",       scheduleAutoSync);
    lbxSerial.addEventListener("input",     scheduleAutoSync);
    lbxRemarks.addEventListener("change", function () {
      updateRemarksStaffInput(lbxRemarks, lbxRemarksStaff);
      scheduleAutoSync();
    });
    lbxRemarksStaff.addEventListener("input", scheduleAutoSync);
    lbxS2Remarks.addEventListener("change", function () {
      updateRemarksStaffInput(lbxS2Remarks, lbxS2RemarksStaff);
    });

    /* ── download ──────────────────────────────────────────────── */
    lbxDownload.addEventListener("click", function () {
      if (!currentEntry) return;
      var a = document.createElement("a");
      a.href     = currentEntry.imageData;
      a.download = currentEntry.fileName || ("capture-" + currentEntry.ts + ".jpg");
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });

    /* ── fullscreen ────────────────────────────────────────────── */
    lbxFullscreen.addEventListener("click", function () {
      if (!currentEntry) return;
      if (lbxBox.requestFullscreen) {
        lbxBox.requestFullscreen().catch(function () {
          window.open(currentEntry.imageData, "_blank");
        });
      } else if (lbxBox.webkitRequestFullscreen) {
        lbxBox.webkitRequestFullscreen();
      } else {
        window.open(currentEntry.imageData, "_blank");
      }
    });

    /* ── close ─────────────────────────────────────────────────── */
    lbxClose.addEventListener("click", closeLightbox);
    lbxCancel.addEventListener("click", closeLightbox);
    lightbox.addEventListener("click", function (e) {
      if (e.target === lightbox) closeLightbox();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !lightbox.classList.contains("hidden")) closeLightbox();
    });

    /* ── save to Matched Record Details (Set 1 + optional Set 2) ── */
    lbxSave.addEventListener("click", function () {
      if (!currentEntry) return;

      var component   = lbxComponent.value.trim();
      var description = lbxDesc.value.trim();
      var hardwareId  = lbxHwId.value.trim();
      var serial      = lbxSerial.value.trim();
      var remarks     = getRemarksValue(lbxRemarks, lbxRemarksStaff);

      if (!component) {
        showFeedback("Please select a Component for Set 1 before saving.", "error");
        lbxComponent.focus();
        return;
      }

      var set2Active    = lbxSet2.checked;
      var s2Component   = set2Active ? lbxS2Comp.value.trim()    : "";
      var s2Description = set2Active ? lbxS2Desc.value.trim()    : "";
      var s2HardwareId  = set2Active ? lbxS2HwId.value.trim()    : "";
      var s2Serial      = set2Active ? lbxS2Serial.value.trim()  : "";
      var s2Remarks     = set2Active ? getRemarksValue(lbxS2Remarks, lbxS2RemarksStaff) : "";

      if (set2Active && !s2Component) {
        showFeedback("Please select a Component for Set 2, or uncheck Set 2.", "error");
        lbxS2Comp.focus();
        return;
      }

      var fields1 = { component: component, description: description, hardwareId: hardwareId, serial: serial, remarks: remarks };

      /* Persist per-image details including Set 2 */
      var fp = fingerprint(currentEntry.imageData);
      storeImageDetails(fp, {
        component: component, description: description, hardwareId: hardwareId, serial: serial, remarks: remarks,
        set2Enabled:     set2Active,
        set2Component:   s2Component,
        set2Description: s2Description,
        set2HardwareId:  s2HardwareId,
        set2Serial:      s2Serial,
        set2Remarks:     s2Remarks,
      });

      lbxSave.disabled    = true;
      lbxSave.textContent = "Saving…";

      setTimeout(function () {
        /* Set 1 — update existing row or create new */
        var result1 = syncFieldsToTable(fields1, false);

        /* Set 2 — always a new row (second unit of same type) */
        var result2 = null;
        if (set2Active && s2Component) {
          var fields2 = { component: s2Component, description: s2Description, hardwareId: s2HardwareId, serial: s2Serial, remarks: s2Remarks };
          result2 = syncFieldsToTable(fields2, true);
        }

        lbxSave.disabled    = false;
        lbxSave.textContent = "Save to Matched Record Details";

        var msgs = [];
        if (result1 === "dom-updated") msgs.push("Set 1 updated");
        if (result1 === "fiber-added") msgs.push("Set 1 row added");
        if (result2 === "dom-updated") msgs.push("Set 2 updated");
        if (result2 === "fiber-added") msgs.push("Set 2 row added");

        if (msgs.length) {
          showFeedback("✓ " + msgs.join(" · ") + ".", "success");
          showNotify("📋 Equipment details saved to the table.");
        } else {
          showFeedback("Details saved locally. Open the Smart Capture form and scan an image first to create a row, then re-open this image to sync.", "warn");
        }
      }, 50);
    });

    /* ── badge ─────────────────────────────────────────────────── */
    function updateBadge() {
      if (newCount > 0) {
        badge.textContent = newCount > 99 ? "99+" : String(newCount);
        badge.classList.add("visible");
      } else {
        badge.classList.remove("visible");
      }
    }

    function resetDesktopCameraSession(markFresh) {
      if (markFresh) {
        try { sessionStorage.setItem("ipas_cam_fresh", "1"); } catch (_) {}
      }
      clearTimeout(fetchDebTimer);
      clearTimeout(smartCaptureRetryTimer);
      if (smartCaptureObserver) {
        try { smartCaptureObserver.disconnect(); } catch (_) {}
        smartCaptureObserver = null;
      }
      pendingEquipmentRetries = [];
      injectedEventIds        = new Set();
      var cards = panelBody.querySelectorAll(".ipas-cam-card");
      for (var ci = 0; ci < cards.length; ci++) {
        if (cards[ci].parentNode) cards[ci].parentNode.removeChild(cards[ci]);
      }
      if (emptyDiv) emptyDiv.style.display = "";
      newCount = 0;
      updateBadge();
      seenEventIds      = new Set();
      seenFingerprints  = new Set();
      imageDetailsCache = {};
      lastSeenTs        = INIT_LOOKBACK_MS;
      initialized       = false;
      currentEmpId      = null;
      try { if (es) { es.close(); es = null; } } catch (_) {}
      stopPolling();
      document.removeEventListener("click", handleLogoutClick, true);
      try { if (panel && panel.parentNode) panel.parentNode.removeChild(panel); } catch (_) {}
      try { if (lightbox && lightbox.parentNode) lightbox.parentNode.removeChild(lightbox); } catch (_) {}
      try { if (notify && notify.parentNode) notify.parentNode.removeChild(notify); } catch (_) {}
    }

    function handleLogoutClick(event) {
      var el = event.target;
      while (el && el !== document.body) {
        if (el.tagName === "BUTTON" && (el.textContent || "").trim() === "Log Out") {
          resetDesktopCameraSession(true);
          startAuthPoll();
          return;
        }
        el = el.parentElement;
      }
    }

    document.addEventListener("click", handleLogoutClick, true);

    panelBody.addEventListener("scroll", function () { newCount = 0; updateBadge(); });

    /* ── status dot ────────────────────────────────────────────── */
    function setStatus(cls) {
      statusDot.className = cls;
      panelTitle.textContent = {
        connected:  "Phone Camera — Live",
        connecting: "Phone Camera — Connecting…",
        error:      "Phone Camera — Offline",
      }[cls] || "Phone Camera";
    }

    /* ── card status ────────────────────────────────────────────── */
    function setCardStatus(card, status) {
      var sb = card.querySelector(".cam-card-status");
      if (!sb) return;
      var cfg = {
        applied:  { cls: "cam-status-applied",  label: "✓ Applied"               },
        ready:    { cls: "cam-status-ready",     label: "Uploaded"                },
        pending:  { cls: "cam-status-pending",   label: "Waiting for Smart Capture" },
        failed:   { cls: "cam-status-failed",    label: "No active target selected" },
      }[status] || { cls: "cam-status-ready", label: "Uploaded" };
      sb.className   = "cam-card-status " + cfg.cls;
      sb.textContent = cfg.label;
    }

    /* ── detect Smart Capture active in DOM ─────────────────────── */
    function isSmartCaptureActive() {
      if (!document.body) return false;
      return (document.body.textContent || "").indexOf("Smart Capture Workflow") !== -1;
    }

    /* ── drain the pending equipment retry queue ─────────────────── */
    /* Called when Smart Capture is detected as active. Injects queued
     * equipment captures one at a time (2 s gap) so React can process
     * each image before the next one is submitted to the drop zone. */
    function drainEquipmentRetries() {
      if (pendingEquipmentRetries.length === 0) return;
      if (!isSmartCaptureActive()) return;

      var queue = pendingEquipmentRetries.slice();
      pendingEquipmentRetries = [];
      var idx = 0;

      function next() {
        if (idx >= queue.length) return;
        var item = queue[idx++];
        if (injectedEventIds.has(item.entry.eventId)) { next(); return; }
        var ok = injectIntoUploadZone(item.entry);
        setCardStatus(item.card, ok ? "applied" : "failed");
        if (ok) {
          injectedEventIds.add(item.entry.eventId);
          showNotify("📷 Equipment photo loaded into Smart Capture!");
        } else {
          pendingEquipmentRetries.push(item); // still failing — keep for next attempt
        }
        if (idx < queue.length) {
          setTimeout(next, 2000); // 2 s gap so React finishes processing each image
        }
      }

      next();
    }

    /* ── build Blob/File from data-URL ──────────────────────────── */
    function dataURLtoFile(dataURL, fileName, mimeType) {
      var parts = dataURL.split(",");
      var mime  = (parts[0].match(/:(.*?);/) || [])[1] || mimeType || "image/jpeg";
      var bstr  = atob(parts[1] || "");
      var arr   = new Uint8Array(bstr.length);
      for (var i = 0; i < bstr.length; i++) arr[i] = bstr.charCodeAt(i);
      return new File([new Blob([arr], { type: mime })], fileName, { type: mime });
    }

    /* ── locate the correct drop zone by captureType ─────────────── */
    /*
     * Drop-zone hints (text nodes inside the border-dashed drop zone element):
     *
     * Equipment → Accountability > Smart Capture
     *   Visible text: "Camera ready when you are"
     *                 "Tap to attach photos, or drag and drop image files here."
     *                 "ATTACH MULTIPLE IMAGES HERE"
     *
     * Ticket → Travel Expense Report > Supporting Document
     *   Visible text: "Drop supporting documents here"
     *                 "Images, PDFs, spreadsheets, and other document files"
     *                 "Saved for upload"
     */
    function findDropZoneForType(captureType) {
      // Equipment: Accountability > Smart Capture drop zone
      var equipHints = [
        "Camera ready when you are",
        "Tap to attach photos, or drag and drop image files here.",
        "ATTACH MULTIPLE IMAGES HERE",
        "Attach multiple images here",
      ];
      // Ticket: Travel Expense Report > Supporting Document drop zone
      var ticketHints = [
        "Drop supporting documents here",
        "Images, PDFs, spreadsheets, and other document files",
        "Saved for upload",
      ];
      var genericHints = [
        "Camera ready when you are",
        "Tap to attach photos, or drag and drop image files here.",
        "Drop supporting documents here",
        "Images, PDFs, spreadsheets, and other document files",
      ];

      var hints = captureType === "equipment" ? equipHints :
                  captureType === "ticket"    ? ticketHints :
                  genericHints;

      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      var node;
      while ((node = walker.nextNode())) {
        var text = (node.nodeValue || "").trim();
        var hit  = false;
        for (var h = 0; h < hints.length; h++) {
          if (text === hints[h] || text.indexOf(hints[h]) !== -1) { hit = true; break; }
        }
        if (!hit) continue;
        var el = node.parentElement;
        for (var depth = 0; el && depth < 10; depth++) {
          var cls = typeof el.className === "string" ? el.className : "";
          if (cls.indexOf("border-dashed") !== -1) return el;
          el = el.parentElement;
        }
      }
      return null;
    }

    /* ── simulate a drag-and-drop on the drop zone ───────────────── */
    function simulateDrop(dropZone, file) {
      try {
        var dt = new DataTransfer();
        dt.items.add(file);
        var opts = { bubbles: true, cancelable: true, dataTransfer: dt };
        dropZone.dispatchEvent(new DragEvent("dragenter", opts));
        dropZone.dispatchEvent(new DragEvent("dragover",  opts));
        dropZone.dispatchEvent(new DragEvent("drop",      opts));
        dropZone.dispatchEvent(new DragEvent("dragleave", opts));
        return true;
      } catch (err) {
        console.warn("[ipas-cam] simulateDrop failed:", err);
        return false;
      }
    }

    /* ── inject into a hidden React image file-input ─────────────── */
    function injectIntoHiddenImageInput(file) {
      var inputs = Array.from(document.querySelectorAll('input[type="file"]'))
        .filter(function (inp) {
          if (inp.disabled) return false;
          var accept = (inp.getAttribute("accept") || "").toLowerCase();
          if (accept.indexOf("image") === -1) return false;
          var style = inp.getAttribute("style") || "";
          if (style.indexOf("pointer-events") !== -1) return false;
          return true;
        });

      var target = inputs.find(function (inp) { return !inp.getAttribute("capture"); })
                || inputs[0];

      if (!target) return false;

      try {
        var dt = new DataTransfer();
        dt.items.add(file);
        var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
        if (nativeSetter && nativeSetter.set) nativeSetter.set.call(target, dt.files);
        else target.files = dt.files;
        target.dispatchEvent(new Event("change", { bubbles: true }));
        target.dispatchEvent(new Event("input",  { bubbles: true }));
        return true;
      } catch (err) {
        console.warn("[ipas-cam] hidden-input inject failed:", err);
        return false;
      }
    }

    function dispatchSmartCaptureHandoff(entry) {
      try {
        var event = new CustomEvent("ipas-smart-capture-capture", {
          detail: entry,
          cancelable: true,
        });
        var notCancelled = window.dispatchEvent(event);
        return !notCancelled || entry.__ipasSmartCaptureHandled === true;
      } catch (_) {
        return false;
      }
    }

    /* ── main injection entry-point (3-tier) ─────────────────────── */
    function injectIntoUploadZone(entry) {
      try {
        window.dispatchEvent(new CustomEvent("ipas-cam-capture", { detail: entry }));
      } catch (_) {}

      var file = null;
      try {
        file = dataURLtoFile(
          entry.imageData,
          entry.fileName || ("capture-" + entry.ts + ".jpg"),
          entry.mimeType
        );
      } catch (err) {
        console.warn("[ipas-cam] dataURLtoFile failed:", err);
        return false;
      }

      var captureType = entry.captureType || "";
      if (captureType === "equipment" && dispatchSmartCaptureHandoff(entry)) {
        console.log("[ipas-cam] handed equipment capture to Smart Capture state");
        return true;
      }

      // Tier 1: drop into the type-specific drop zone
      var dropZone = findDropZoneForType(captureType);
      if (dropZone && simulateDrop(dropZone, file)) {
        console.log("[ipas-cam] injected via drop-zone simulation (type=" + captureType + ")");
        return true;
      }

      if (captureType === "equipment") {
        var bodyText = document.body ? (document.body.textContent || "") : "";
        var smartCaptureActive = bodyText.indexOf("Smart Capture Workflow") !== -1 &&
          (bodyText.indexOf("Captured Images") !== -1 ||
           bodyText.indexOf("Matched Record Details") !== -1 ||
           bodyText.indexOf("Asset Rows") !== -1);
        if (smartCaptureActive && injectIntoHiddenImageInput(file)) {
          console.log("[ipas-cam] injected into Smart Capture hidden image input");
          return true;
        }
        console.log("[ipas-cam] Smart Capture upload target not found; equipment capture was not injected into another tab");
        return false;
      }

      // Tier 2: visible file input
      var visInputs = Array.from(document.querySelectorAll('input[type="file"]'))
        .filter(function (inp) { return !inp.disabled; });
      var visTarget = visInputs.find(function (inp) {
        var r = inp.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }) || visInputs.find(function (inp) { return inp.offsetParent !== null; });

      if (visTarget) {
        try {
          var dtVis = new DataTransfer();
          dtVis.items.add(file);
          var nsSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
          if (nsSetter && nsSetter.set) nsSetter.set.call(visTarget, dtVis.files);
          else visTarget.files = dtVis.files;
          visTarget.dispatchEvent(new Event("change", { bubbles: true }));
          visTarget.dispatchEvent(new Event("input",  { bubbles: true }));
          visTarget.scrollIntoView({ behavior: "smooth", block: "center" });
          console.log("[ipas-cam] injected via visible file-input");
          return true;
        } catch (err) {
          console.warn("[ipas-cam] visible-input inject failed:", err);
        }
      }

      // Tier 3: hidden image input
      if (injectIntoHiddenImageInput(file)) {
        console.log("[ipas-cam] injected via hidden image file-input");
        return true;
      }

      console.log("[ipas-cam] no upload target found on current page");
      return false;
    }

    /* ── add a card (double-deduped) ────────────────────────────── */
    function addCard(entry) {
      if (seenEventIds.has(entry.eventId)) return;

      var fp = fingerprint(entry.imageData);
      if (fp && seenFingerprints.has(fp)) {
        seenEventIds.add(entry.eventId);
        return;
      }

      seenEventIds.add(entry.eventId);
      if (fp) seenFingerprints.add(fp);
      if (entry.ts > lastSeenTs) lastSeenTs = entry.ts;

      if (emptyDiv) emptyDiv.style.display = "none";

      var captureType = entry.captureType || "";
      var typeLabel   = captureType === "equipment" ? "Equipment" :
                        captureType === "ticket"    ? "Ticket"    : "";
      var typeBadgeHtml = typeLabel
        ? '<span class="cam-type-badge cam-type-' + captureType + '">' + typeLabel + '</span>'
        : "";

      var card = document.createElement("div");
      card.className  = "ipas-cam-card";
      card.dataset.id = entry.eventId;
      card.innerHTML =
        '<div class="ipas-cam-thumb">' +
          '<img alt="' + esc(entry.fileName || "capture") + '" loading="lazy">' +
        '</div>' +
        '<div class="ipas-cam-card-info">' +
          '<div class="ipas-cam-card-row-top">' +
            '<span class="ipas-cam-card-name">' + esc(entry.fileName || "capture") + '</span>' +
            (typeBadgeHtml) +
            '<button class="cam-dismiss-btn" type="button" title="Remove from list" aria-label="Remove">' +
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
              ' stroke-width="2.5" stroke-linecap="round">' +
              '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' +
              '</svg>' +
            '</button>' +
          '</div>' +
          '<div class="ipas-cam-card-time-row">' +
            '<span class="ipas-cam-card-time">' + fmtTime(entry.ts) + '</span>' +
            '<span class="cam-card-status cam-status-ready">Uploaded</span>' +
          '</div>' +
        '</div>';

      card.querySelector(".ipas-cam-thumb img").src = entry.imageData;
      panelBody.insertBefore(card, panelBody.firstChild);

      /* thumb → open enhanced lightbox */
      card.querySelector(".ipas-cam-thumb").addEventListener("click", function () {
        openLightbox(entry);
      });

      /* × dismiss */
      card.querySelector(".cam-dismiss-btn").addEventListener("click", function (e) {
        e.stopPropagation();
        fetch("/api/cam/pending/" + encodeURIComponent(entry.eventId) + "?empId=" + encodeURIComponent(currentEmpId), {
          method: "DELETE",
          credentials: "include",
          headers: { Accept: "application/json" },
        }).catch(function () {});
        card.classList.add("cam-card-removing");
        setTimeout(function () {
          if (card.parentNode) card.parentNode.removeChild(card);
          if (!panelBody.querySelector(".ipas-cam-card") && emptyDiv) {
            emptyDiv.style.display = "";
          }
        }, 250);
      });

      /* auto-route then inject after React renders the target tab. */
      if (AUTO_INJECT_ENABLED) {
        if (captureType === "equipment") {
          /* Equipment captures go to Smart Capture.
           *
           * Strategy: always push to the retry queue first.  The
           * MutationObserver drains the queue as soon as Smart Capture
           * becomes (or is already) the active page.  This handles:
           *   • laptop offline during capture → queue drained when
           *     the user manually opens Smart Capture later.
           *   • laptop already on Smart Capture → drain fires in <1 s.
           *   • multiple pending captures → processed one at a time
           *     (2 s gap) so React can handle each image in sequence.
           *
           * We do NOT auto-navigate away from the current page; the
           * previous navigation caused the injection to race with React
           * rendering and lose every time the laptop wasn't already on
           * Smart Capture. */
          if (!injectedEventIds.has(entry.eventId)) {
            pendingEquipmentRetries.push({ entry: entry, card: card });
            setCardStatus(card, "pending");
            /* If Smart Capture is already active, drain right away */
            clearTimeout(smartCaptureRetryTimer);
            smartCaptureRetryTimer = setTimeout(drainEquipmentRetries, 500);
          }
        } else {
          /* Non-equipment (tickets etc.): keep original navigateForCapture flow */
          setTimeout(function () {
            navigateForCapture(captureType, function () {
              var ok = injectIntoUploadZone(entry);
              setCardStatus(card, ok ? "applied" : "failed");
              if (ok) {
                var dest = captureType === "ticket"
                  ? " (Travel Expense Report › Supporting Document)" : "";
                showNotify("📷 Photo routed to" + (dest || " the active form") + "!");
              } else {
                showNotify("📷 Photo received — navigate to the target tab then re-tap the thumbnail to retry.");
              }
            });
          }, 300);
        }
      } else {
        showNotify("📷 Photo received — open the image to fill in details manually.");
      }

      newCount += 1;
      updateBadge();
      if (collapsed) setCollapsed(false);
    }

    /* ── debounced fetchPending ─────────────────────────────────── */
    function scheduleFetch() {
      clearTimeout(fetchDebTimer);
      var now  = Date.now();
      var wait = Math.max(0, FETCH_DEBOUNCE_MS - (now - lastFetchTime));
      fetchDebTimer = setTimeout(function () {
        lastFetchTime = Date.now();
        fetch("/api/cam/pending?empId=" + encodeURIComponent(currentEmpId) + "&since=" + lastSeenTs, {
          credentials: "include",
          headers: { Accept: "application/json" },
        })
          .then(function (r) { return r.ok ? r.json() : { images: [] }; })
          .then(function (data) {
            var images = (data.images || []).slice().sort(function (a, b) { return a.ts - b.ts; });
            images.forEach(addCard);
          })
          .catch(function () {});
      }, wait);
    }

    /* ── polling fallback ───────────────────────────────────────── */
    var pollTimer = null;
    function startPolling() {
      if (pollTimer) return;
      pollTimer = setInterval(scheduleFetch, POLL_FALLBACK_MS);
    }
    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    /* ── SSE connection ─────────────────────────────────────────── */
    var es = null;
    var reconnectDelay = 3000;

    function connectSSE() {
      setStatus("connecting");
      startPolling();
      try { if (es) { es.close(); es = null; } } catch (_) {}

      es = new EventSource(
        "/api/cam/events?empId=" + encodeURIComponent(currentEmpId),
        { withCredentials: true }
      );

      es.onopen = function () {
        setStatus("connected");
        stopPolling();
        reconnectDelay = 3000;
        scheduleFetch();
      };

      es.onmessage = function (e) {
        try {
          var msg = JSON.parse(e.data);
          if (msg.type === "capture") addCard(msg);
        } catch (_) {}
      };

      es.onerror = function () {
        setStatus("error");
        try { es.close(); es = null; } catch (_) {}
        startPolling();
        setTimeout(connectSSE, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      };
    }

    connectSSE();
    scheduleFetch();

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) scheduleFetch();
    });

    /* ── Watch for Smart Capture becoming active ─────────────────── */
    /* Equipment captures queued while Smart Capture was not open are
     * drained here.  The observer fires on every DOM mutation; we gate
     * with isSmartCaptureActive() and a short debounce so we don't
     * call drainEquipmentRetries() hundreds of times during a render. */
    smartCaptureObserver = new MutationObserver(function () {
      if (pendingEquipmentRetries.length === 0) return;
      if (!isSmartCaptureActive()) return;
      clearTimeout(smartCaptureRetryTimer);
      smartCaptureRetryTimer = setTimeout(drainEquipmentRetries, 600);
    });
    smartCaptureObserver.observe(document.body, { childList: true, subtree: true });

    /* ── logout / session-end detection ───────────────────────────
     * Poll /api/auth/me every 45 seconds. If the session ends (401/403),
     * mark the next boot as a fresh session, clear the panel cards, reset
     * all in-memory dedup state, and restart the auth poll so the user
     * can log back in cleanly.
     * ─────────────────────────────────────────────────────────────── */
    var sessionCheckTimer = setInterval(function () {
      if (!initialized) { clearInterval(sessionCheckTimer); return; }
      fetch("/api/auth/me", { credentials: "include", headers: { Accept: "application/json" } })
        .then(function (r) {
          if (r.ok) return; // still logged in — nothing to do
          /* Session ended */
          clearInterval(sessionCheckTimer);
          resetDesktopCameraSession(true);
          /* Restart auth poll for the next login */
          startAuthPoll();
        })
        .catch(function () {}); // ignore network errors — don't treat as logout
    }, 45000);
  }

  /* ── bootstrap ──────────────────────────────────────────────── */
  getUser().then(function (user) {
    if (user && user.employeeId) {
      boot(user);
    } else {
      startAuthPoll();
    }
  });

}());

/* Smart Capture Modify image zoom + pan.
 * Scoped to the runtime-injected modify dialog only. */
(function () {
  "use strict";

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function initModifyPreview(modal) {
    if (!modal || modal.__ipasModifyPreviewReady) return;

    var box = modal.querySelector('[data-role="preview-box"]');
    var img = modal.querySelector('[data-role="preview"]');
    var zoomIn = modal.querySelector('[data-role="zoom-in"]');
    var zoomOut = modal.querySelector('[data-role="zoom-out"]');
    var label = modal.querySelector('[data-role="zoom-label"]');
    if (!box || !img || !zoomIn || !zoomOut) return;

    modal.__ipasModifyPreviewReady = true;

    var rotateButton = modal.querySelector('[data-role="rotate"]');
    if (!rotateButton) {
      rotateButton = document.createElement("button");
      rotateButton.type = "button";
      rotateButton.setAttribute("data-role", "rotate");
      rotateButton.textContent = "Rotate";
      zoomIn.insertAdjacentElement("afterend", rotateButton);
    }

    var zoom = 1;
    var rotation = 0;
    var panX = 0;
    var panY = 0;
    var dragging = false;
    var dragStartX = 0;
    var dragStartY = 0;
    var dragPanX = 0;
    var dragPanY = 0;

    function clampPan() {
      if (zoom <= 1) {
        panX = 0;
        panY = 0;
        return;
      }

      var boxRect = box.getBoundingClientRect();
      var baseWidth = img.offsetWidth || boxRect.width;
      var baseHeight = img.offsetHeight || boxRect.height;
      var maxX = Math.max(0, (baseWidth * zoom - boxRect.width) / 2);
      var maxY = Math.max(0, (baseHeight * zoom - boxRect.height) / 2);

      panX = clamp(panX, -maxX, maxX);
      panY = clamp(panY, -maxY, maxY);
    }

    function applyPreviewTransform() {
      clampPan();
      img.style.transform = "translate(" + panX + "px, " + panY + "px) rotate(" + rotation + "deg) scale(" + zoom + ")";
      box.style.cursor = dragging ? "grabbing" : "grab";
      if (label) label.textContent = Math.round(zoom * 100) + "%";
    }

    function setZoom(nextZoom) {
      zoom = clamp(Math.round(nextZoom * 100) / 100, 0.5, 4);
      if (zoom <= 1) {
        panX = 0;
        panY = 0;
      }
      applyPreviewTransform();
    }

    function handleZoomClick(delta) {
      return function (event) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setZoom(zoom + delta);
      };
    }

    function stopDragging() {
      if (!dragging) return;
      dragging = false;
      applyPreviewTransform();
    }

    zoomIn.addEventListener("click", handleZoomClick(0.25), true);
    zoomOut.addEventListener("click", handleZoomClick(-0.25), true);
    rotateButton.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      rotation = (rotation + 90) % 360;
      panX = 0;
      panY = 0;
      applyPreviewTransform();
    }, true);

    box.addEventListener("mousedown", function (event) {
      if (event.button !== 0 || zoom <= 1) return;
      event.preventDefault();
      dragging = true;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      dragPanX = panX;
      dragPanY = panY;
      applyPreviewTransform();
    });

    document.addEventListener("mousemove", function (event) {
      if (!dragging) return;
      event.preventDefault();
      panX = dragPanX + event.clientX - dragStartX;
      panY = dragPanY + event.clientY - dragStartY;
      applyPreviewTransform();
    });

    document.addEventListener("mouseup", stopDragging);
    box.addEventListener("mouseleave", stopDragging);
    img.addEventListener("dragstart", function (event) {
      event.preventDefault();
    });
    img.addEventListener("load", function () {
      panX = 0;
      panY = 0;
      rotation = 0;
      setZoom(1);
    });

    setZoom(1);
  }

  function initExistingModifyPreviews() {
    document.querySelectorAll('[data-ipas-image-modify="1"]').forEach(initModifyPreview);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initExistingModifyPreviews);
  } else {
    initExistingModifyPreviews();
  }

  new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      mutation.addedNodes.forEach(function (node) {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches('[data-ipas-image-modify="1"]')) initModifyPreview(node);
        node.querySelectorAll && node.querySelectorAll('[data-ipas-image-modify="1"]').forEach(initModifyPreview);
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
}());

/* Smart Capture equipment details table.
 * Displays one saved detail row for each captured image. */
(function () {
  "use strict";

  var tableId = "ipas-smart-capture-equipment-table";
  var rows = new Map();
  var renderScheduled = false;
  var observer = null;
  var saveSequence = 0;

  function textOf(node) {
    return (node && node.textContent || "").replace(/\s+/g, " ").trim();
  }

  function normalizeName(name) {
    return String(name || "").trim();
  }

  function detailKey(detail) {
    return normalizeName(detail.captureId) || normalizeName(detail.sourceName);
  }

  function componentKey(component, fallback) {
    var name = normalizeName(component);
    return name ? "component:" + name.toLowerCase() : "image:" + fallback;
  }

  function mergeDisplayRowsByComponent() {
    var grouped = new Map();
    var savedRows = Array.from(rows.values()).sort(function (a, b) {
      return (a.savedOrder || 0) - (b.savedOrder || 0);
    });

    savedRows.forEach(function (detail) {
      var key = componentKey(detail.components, detailKey(detail));
      var group = grouped.get(key) || {
        components: "",
        description: "",
        hardwareId: "",
        serial: "",
        remarks: ""
      };

      ["components", "description", "hardwareId", "serial", "remarks"].forEach(function (field) {
        var value = normalizeName(detail[field]);
        if (value) group[field] = value;
      });

      grouped.set(key, group);
    });

    return Array.from(grouped.values());
  }

  window.__ipasSmartCaptureGetGroupedRows = function () {
    return mergeDisplayRowsByComponent().map(function (detail, index) {
      return {
        id: "smart-capture-group-" + index,
        sourceName: detail.components || "Smart Capture " + (index + 1),
        components: detail.components || "",
        description: detail.description || "",
        hardwareId: detail.hardwareId || "",
        serial: detail.serial || "",
        remarks: detail.remarks || "",
        notes: ""
      };
    });
  };

  function findCapturedImagesCard() {
    var headings = Array.prototype.slice.call(document.querySelectorAll("p, h1, h2, h3, h4, span"));
    for (var i = 0; i < headings.length; i += 1) {
      if (textOf(headings[i]).toLowerCase() !== "captured images") continue;

      var node = headings[i];
      for (var depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue;
        var cardText = textOf(node);
        if (
          cardText.indexOf("Captured Images") !== -1 &&
          cardText.indexOf("Attach More Images") !== -1 &&
          cardText.indexOf("Add More from Camera") !== -1
        ) {
          return node;
        }
      }
    }
    return null;
  }

  function capturedImageNames() {
    var card = findCapturedImagesCard();
    if (!card) return null;

    var names = new Set();
    card.querySelectorAll('button[aria-label^="Remove "]').forEach(function (button) {
      names.add(normalizeName(button.getAttribute("aria-label").replace(/^Remove\s+/, "")));
    });

    return names;
  }

  function pruneDeletedRows() {
    var names = capturedImageNames();
    if (!names) return;
    if (names.size === 0) {
      rows.clear();
      return;
    }

    rows.forEach(function (row, key) {
      if (row.sourceName && !names.has(row.sourceName)) {
        rows.delete(key);
      }
    });
  }

  function ensureTable() {
    var card = findCapturedImagesCard();
    if (!card) return null;

    var table = document.getElementById(tableId);
    if (!table) {
      table = document.createElement("section");
      table.id = tableId;
      table.className = "ipas-smart-capture-equipment-table";
      table.innerHTML = [
        '<div class="ipas-smart-capture-equipment-scroll">',
        '<table>',
        '<thead><tr>',
        '<th scope="col">Components</th>',
        '<th scope="col">Description</th>',
        '<th scope="col">Hardware ID</th>',
        '<th scope="col">Serial</th>',
        '<th scope="col">Remarks</th>',
        '</tr></thead>',
        '<tbody></tbody>',
        '</table>',
        '</div>'
      ].join("");
    }

    if (table.previousElementSibling !== card) {
      card.insertAdjacentElement("afterend", table);
    }

    return table;
  }

  function appendCell(row, value) {
    var cell = document.createElement("td");
    cell.textContent = value || "";
    row.appendChild(cell);
  }

  function renderTableNow() {
    renderScheduled = false;
    if (observer) observer.disconnect();

    try {
      pruneDeletedRows();

      var table = ensureTable();
      if (!table) return;

      var body = table.querySelector("tbody");
      if (!body) return;

      body.textContent = "";

      var data = mergeDisplayRowsByComponent();
      if (data.length === 0) {
        var emptyRow = document.createElement("tr");
        var emptyCell = document.createElement("td");
        emptyCell.colSpan = 5;
        emptyCell.className = "ipas-smart-capture-equipment-empty";
        emptyCell.textContent = "No saved equipment details yet.";
        emptyRow.appendChild(emptyCell);
        body.appendChild(emptyRow);
        return;
      }

      data.forEach(function (detail) {
        var row = document.createElement("tr");
        appendCell(row, detail.components);
        appendCell(row, detail.description);
        appendCell(row, detail.hardwareId);
        appendCell(row, detail.serial);
        appendCell(row, detail.remarks);
        body.appendChild(row);
      });
    } finally {
      observeRoot();
    }
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    window.requestAnimationFrame(renderTableNow);
  }

  window.addEventListener("ipas-smart-capture-detail-save", function (event) {
    var detail = event.detail || {};
    var key = detailKey(detail);
    if (!key) return;

    rows.set(key, {
      captureId: normalizeName(detail.captureId),
      sourceName: normalizeName(detail.sourceName),
      components: detail.components || "",
      description: detail.description || "",
      hardwareId: detail.hardwareId || "",
      serial: detail.serial || "",
      remarks: detail.remarks || "",
      savedOrder: saveSequence += 1
    });

    scheduleRender();
  });

  document.addEventListener("click", function (event) {
    var target = event.target;
    var button = target && target.closest ? target.closest('button[aria-label^="Remove "]') : null;
    if (!button) return;

    var sourceName = normalizeName(button.getAttribute("aria-label").replace(/^Remove\s+/, ""));
    window.setTimeout(function () {
      rows.forEach(function (row, key) {
        if (row.sourceName === sourceName) {
          rows.delete(key);
        }
      });
      scheduleRender();
    }, 0);
  }, true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduleRender);
  } else {
    scheduleRender();
  }

  function observeRoot() {
    if (!observer) observer = new MutationObserver(scheduleRender);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  observeRoot();
}());
