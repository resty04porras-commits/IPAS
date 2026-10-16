(function () {
  var root = document.getElementById("root");
  if (!root) return;

  var html = document.documentElement;
  var button = document.createElement("button");
  var backdrop = document.createElement("div");

  button.type = "button";
  button.className = "ipas-mobile-menu";
  button.setAttribute("aria-label", "Open navigation menu");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = "<span aria-hidden=\"true\"></span>";

  backdrop.className = "ipas-sidebar-backdrop";
  backdrop.setAttribute("aria-hidden", "true");

  /* ── sidebar open / close helpers ─────────────────────────────── */
  function closeSidebar() {
    html.classList.remove("ipas-sidebar-open");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "Open navigation menu");
  }

  function openSidebar() {
    html.classList.add("ipas-sidebar-open");
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("aria-label", "Close navigation menu");
  }

  function toggleSidebar() {
    if (html.classList.contains("ipas-sidebar-open")) {
      closeSidebar();
    } else {
      openSidebar();
    }
  }

  /* ── DOM wiring ─────────────────────────────────────────────────── */
  function findShell() {
    var child = root.firstElementChild;
    if (!child) return null;
    var aside = child.querySelector("aside");
    if (!aside) return null;
    return { shell: child, aside: aside };
  }

  var currentAside = null; // track which aside we have wired

  function wireLayout() {
    var found = findShell();
    if (!found) {
      html.classList.remove("ipas-has-sidebar", "ipas-sidebar-open");
      currentAside = null;
      return;
    }

    html.classList.add("ipas-has-sidebar");
    found.shell.classList.add("ipas-shell");
    found.aside.classList.add("ipas-sidebar");

    var content = found.aside.nextElementSibling;
    if (content) content.classList.add("ipas-content");

    if (!button.isConnected)   document.body.appendChild(button);
    if (!backdrop.isConnected) document.body.appendChild(backdrop);

    // Wire the "tap a nav item → close sidebar" behaviour only once per aside
    if (found.aside !== currentAside) {
      currentAside = found.aside;
      wireAsideNavClose(found.aside);
    }
  }

  /*
   * Auto-close sidebar when the user taps any link or button inside the
   * <aside>.  We attach a single delegated listener so it works even when
   * React re-renders nav items inside the aside.
   */
  function wireAsideNavClose(aside) {
    aside.addEventListener("click", function (event) {
      if (window.innerWidth >= 1024) return; // desktop — do nothing
      var target = event.target;
      while (target && target !== aside) {
        if (target.tagName === "BUTTON" || target.tagName === "A") {
          // Small delay so React can process the click before we animate
          setTimeout(closeSidebar, 80);
          break;
        }
        target = target.parentElement;
      }
    }, { passive: true });
  }

  /* ── swipe gesture (open / close sidebar) ─────────────────────── */
  /*
   * On mobile:
   *   • Swipe right from the left edge (within 30 px) → open sidebar
   *   • Swipe left while sidebar is open → close sidebar
   *
   * We track touch start/end only — no drag animation — to keep the code
   * simple and avoid interfering with scrolling.
   */
  (function initSwipe() {
    var swipeStartX = null;
    var swipeStartY = null;
    var EDGE_THRESHOLD = 30;   // px from left edge to trigger open swipe
    var SWIPE_MIN_X   = 50;   // minimum horizontal distance to count as swipe
    var SWIPE_MAX_Y   = 80;   // maximum vertical drift before we ignore the gesture

    document.addEventListener("touchstart", function (e) {
      var t = e.touches[0];
      swipeStartX = t.clientX;
      swipeStartY = t.clientY;
    }, { passive: true });

    document.addEventListener("touchend", function (e) {
      if (swipeStartX === null) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - swipeStartX;
      var dy = Math.abs(t.clientY - swipeStartY);

      swipeStartX = null;
      swipeStartY = null;

      if (window.innerWidth >= 1024) return; // only on mobile/tablet
      if (dy > SWIPE_MAX_Y) return;          // too much vertical movement

      var isSidebarOpen = html.classList.contains("ipas-sidebar-open");

      // Swipe right from left edge → open
      if (!isSidebarOpen && dx > SWIPE_MIN_X && (t.clientX - dx) < EDGE_THRESHOLD) {
        openSidebar();
        return;
      }

      // Swipe left while open → close
      if (isSidebarOpen && dx < -SWIPE_MIN_X) {
        closeSidebar();
      }
    }, { passive: true });
  }());

  /* ── Smart Capture match-record detail text replacements ────────── */
  var smartCaptureText = new Map([
    ["Asset Rows", "Matched Record Details"],
    ["Review and adjust the scanned values before exporting the default form.", "Review the existing record found from the barcode. Manual fields remain available when no match is found."],
    ["Scan your captured photos and the extracted component, description, hardware ID, and serial fields will appear here.", "Scan a barcode image and matching existing details will appear here."],
    ["Scanning captured images and preparing asset rows...", "Scanning barcode and searching existing records..."],
    ["The extracted component, description, hardware ID, and serial fields will appear here as soon as the scan completes.", "Barcode lookup results will appear here as soon as the scan completes."],
  ]);

  function rewriteSmartCaptureText() {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var value = node.nodeValue || "";
      var trimmed = value.trim();
      if (!smartCaptureText.has(trimmed)) continue;
      node.nodeValue = value.replace(trimmed, smartCaptureText.get(trimmed));
    }
  }

  /* ── auth / history helpers ────────────────────────────────────── */
  var cachedUserPromise    = null;
  var cachedHistoryPromise = null;

  function parseStoredUser() {
    var keys = ["icc_user", "ipas_user", "user"];
    for (var i = 0; i < keys.length; i += 1) {
      try {
        var raw = localStorage.getItem(keys[i]);
        if (!raw) continue;
        var user = JSON.parse(raw);
        if (user && typeof user === "object") return user;
      } catch { continue; }
    }
    return null;
  }

  function getCurrentUser() {
    var stored = parseStoredUser();
    if (stored) return Promise.resolve(stored);

    if (!cachedUserPromise) {
      cachedUserPromise = fetch("/api/auth/me", {
        credentials: "include",
        headers: { Accept: "application/json" },
      })
        .then(function (response) {
          if (!response.ok) return null;
          return response.json();
        })
        .catch(function () { return null; });
    }
    return cachedUserPromise;
  }

  function isSuperAdmin(user) {
    var role        = String(user && user.role        ? user.role        : "").toUpperCase();
    var designation = String(user && user.designation ? user.designation : "");
    return (
      role === "SUPER_ADMIN" ||
      designation === "Administrator" ||
      designation === "System Admin"
    );
  }

  function getHistoryEntries() {
    if (!cachedHistoryPromise) {
      cachedHistoryPromise = fetch("/api/history", {
        credentials: "include",
        headers: { Accept: "application/json" },
      })
        .then(function (response) {
          if (!response.ok) return [];
          return response.json();
        })
        .then(function (entries) {
          return Array.isArray(entries) ? entries : [];
        })
        .catch(function () { return []; });
    }
    return cachedHistoryPromise;
  }

  function clearHistoryCache() {
    cachedHistoryPromise = null;
  }

  function findEntryForRow(row, entries, fallbackIndex) {
    var cells = row.querySelectorAll("td");
    if (cells.length < 4) return null;

    var rowDate  = cells[0].textContent.trim();
    var rowType  = cells[1].textContent.trim();
    var rowFiles = cells[2].textContent.trim();
    var rowMatch = cells[3].textContent.trim();

    for (var i = 0; i < entries.length; i += 1) {
      var entry     = entries[i];
      var entryDate = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "";
      var entryType = entry.status ? "Upload: " + entry.status : "Comparison";
      var entryFile1 = String(entry.file1 || "");
      var entryFile2 = String(entry.file2 || "");
      var entryMatch = Number(entry.mismatches || 0) > 0
        ? String(entry.mismatches) + " Mismatches"
        : "Match";

      if (
        rowDate === entryDate &&
        rowType === entryType &&
        rowFiles.indexOf(entryFile1) !== -1 &&
        (!entryFile2 || rowFiles.indexOf(entryFile2) !== -1) &&
        rowMatch.indexOf(entryMatch) !== -1
      ) {
        return entry;
      }
    }
    return entries[fallbackIndex] || null;
  }

  /* ── delete-form action (super admin only) ─────────────────────── */
  window.deleteForm = async function (id) {
    var user = await getCurrentUser();
    if (!isSuperAdmin(user)) {
      alert("Access denied: only Super Admin users can delete forms.");
      return;
    }

    if (!window.confirm(
      "SUPER ADMIN ACTION:\n\nPermanently delete this form history entry?\n\nThis action cannot be undone."
    )) {
      return;
    }

    try {
      var response = await fetch("/api/forms/" + encodeURIComponent(id), {
        method: "DELETE",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      var data = await response.json().catch(function () { return {}; });

      if (!response.ok) {
        alert("Delete failed: " + (data.error || data.detail || "Unable to delete form."));
        return;
      }

      clearHistoryCache();
      alert(data.message || "Form deleted successfully.");
      window.location.reload();
    } catch {
      alert("Connection failed while deleting the form.");
    }
  };

  function addSuperAdminDeleteButtons() {
    getCurrentUser().then(function (user) {
      if (!isSuperAdmin(user)) return;

      getHistoryEntries().then(function (entries) {
        var tables = root.querySelectorAll("table");
        tables.forEach(function (table) {
          var headers = Array.from(table.querySelectorAll("thead th")).map(function (th) {
            return th.textContent.trim();
          });
          if (headers.indexOf("Mismatches") === -1) return;

          var headerRow = table.querySelector("thead tr");
          if (headerRow && !headerRow.querySelector(".ipas-delete-form-header")) {
            var th = document.createElement("th");
            th.className = "px-5 py-3 font-bold text-gray-500 uppercase tracking-wider text-[10px] whitespace-nowrap ipas-delete-form-header";
            th.textContent = "Actions";
            headerRow.appendChild(th);
          }

          var rows = table.querySelectorAll("tbody tr");
          rows.forEach(function (row, index) {
            if (row.querySelector(".ipas-delete-form-cell")) return;

            var entry = findEntryForRow(row, entries, index);
            if (!entry || entry.id === undefined || entry.id === null) return;

            var td = document.createElement("td");
            td.className = "px-5 py-4 ipas-delete-form-cell";

            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "min-h-[44px] rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-600 shadow-sm transition-colors hover:bg-red-100";
            btn.textContent = "Delete";
            btn.addEventListener("click", function (event) {
              event.stopPropagation();
              window.deleteForm(entry.id);
            });

            td.appendChild(btn);
            row.appendChild(td);
          });
        });
      });
    });
  }

  /* ── global event listeners ────────────────────────────────────── */
  button.addEventListener("click",  toggleSidebar);
  backdrop.addEventListener("click", closeSidebar);

  // Close sidebar when window is resized to desktop width
  window.addEventListener("resize", function () {
    if (window.innerWidth >= 1024) closeSidebar();
  });

  // Close sidebar on orientation change (landscape ↔ portrait)
  window.addEventListener("orientationchange", function () {
    // Give the browser a frame to settle the new dimensions first
    setTimeout(function () {
      if (window.innerWidth >= 1024) closeSidebar();
    }, 100);
  });

  // Close sidebar with the keyboard Escape key
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeSidebar();
  });

  /* ── bootstrap ─────────────────────────────────────────────────── */
  wireLayout();
  rewriteSmartCaptureText();
  addSuperAdminDeleteButtons();

  // Re-wire whenever React re-renders the tree
  new MutationObserver(function () {
    wireLayout();
    rewriteSmartCaptureText();
    addSuperAdminDeleteButtons();
  }).observe(root, { childList: true, subtree: true });
}());
