/* Editable Smart Capture camera controls for the recovered IPAS frontend. */
(function () {
  "use strict";
  var tagName = "ipas-smart-capture-camera";
  if (customElements.get(tagName)) return;
  var isPhone = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // Use the same employee channel, push API, and desktop receiver as Equipment.
  // Keep originals in the form; never remove a photo because sending failed.
  var sendQueue = [];
  var sending = false;
  var sendState = { text: "Photos are sent to the same account on your laptop.", error: false };
  var queuedFiles = new WeakSet();

  function sendMessage(text, error) {
    sendState = { text: text, error: Boolean(error) };
    window.dispatchEvent(new CustomEvent("ipas-smart-capture-send-status"));
  }

  async function requestJSON(url, options) {
    var controller = new AbortController();
    var timer = setTimeout(() => controller.abort(), 30000);
    try {
      var response = await fetch(url, Object.assign({
        credentials: "include", headers: { Accept: "application/json" },
      }, options || {}, { signal: controller.signal }));
      var body = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error("Sign in with the account that captured these photos, then retry.");
        if (response.status === 413) throw new Error("The photo is too large. Choose a smaller image.");
        throw new Error("The server could not save the photo. Check the connection and retry.");
      }
      return body;
    } finally { clearTimeout(timer); }
  }

  function readPhoto(file) {
    return new Promise((resolve, reject) => {
      var reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("The photo could not be read. Attach it again."));
      reader.onabort = reader.onerror;
      reader.readAsDataURL(file);
    });
  }

  // Match Equipment's 1600 px / JPEG 0.82 photo preparation. Keep the original
  // File in React; only the transmitted copy is resized. Preserve PNG alpha.
  async function preparePhoto(file) {
    var original = { imageData: await readPhoto(file), mimeType: file.type || "image/jpeg" };
    if (/image\/(?:gif|svg\+xml)/i.test(file.type)) return original;
    return new Promise((resolve) => {
      var image = new Image();
      image.onerror = () => resolve(original);
      image.onload = () => {
        try {
          var scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
          var canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
          var mimeType = file.type === "image/png" ? "image/png" : "image/jpeg";
          var imageData = canvas.toDataURL(mimeType, 0.82);
          // Small images may already be more efficient in their original format.
          resolve(imageData.length < original.imageData.length ? { imageData: imageData, mimeType: mimeType } : original);
        } catch (_) { resolve(original); }
      };
      image.src = original.imageData;
    });
  }

  async function flushPhotos() {
    if (sending || !sendQueue.length) return;
    sending = true;
    sendMessage("Sending " + sendQueue.length + " photo(s) to your account…", false);
    try {
      while (sendQueue.length) {
        var job = sendQueue[0];
        if (!job.empId) throw new Error("Sign in, then attach the photo again to send it.");
        // Reuse identical prepared bytes on retry for server deduplication.
        if (!job.prepared) job.prepared = await preparePhoto(job.file);
        var result = await requestJSON("/api/cam/push", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            empId: job.empId, imageData: job.prepared.imageData, fileName: job.file.name,
            mimeType: job.prepared.mimeType, captureType: "equipment",
          }),
        });
        if (!result || result.success !== true || !result.eventId) {
          throw new Error("The server did not confirm saving the photo. Retry Send.");
        }
        sendQueue.shift();
      }
      sendMessage("Saved on the server. Open Smart Capture on your laptop using the same account.", false);
    } catch (error) {
      var message = error && error.name === "AbortError"
        ? "Sending timed out. Check the connection and choose Retry Send."
        : error.message || "Sending failed. Check the connection and choose Retry Send.";
      sendMessage("The photo remains in this phone's form. " + message, true);
    } finally {
      sending = false;
      window.dispatchEvent(new CustomEvent("ipas-smart-capture-send-status"));
    }
  }

  // Resolve the current server session before associating a batch with an account.
  // Serialize batches as well as uploads so rapid captures cannot race persistence.
  var pendingBatches = Promise.resolve();
  function sendPhotos(files) {
    var fresh = files.filter((file) => !queuedFiles.has(file));
    if (!fresh.length) return;
    fresh.forEach((file) => queuedFiles.add(file));
    pendingBatches = pendingBatches.then(async () => {
      try {
        sendMessage("Preparing photo for sending…", false);
        // Decode/resize while the session check is in flight, rather than after it.
        var results = await Promise.all([requestJSON("/api/auth/me"), preparePhoto(fresh[0])]);
        var user = results[0];
        if (!user || !user.employeeId) throw new Error("Sign in, then attach the photo again to send it.");
        fresh.forEach((file, index) => sendQueue.push({
          file: file, empId: String(user.employeeId), prepared: index === 0 ? results[1] : null,
        }));
        await flushPhotos();
      } catch (error) {
        fresh.forEach((file) => queuedFiles.delete(file));
        sendMessage("Photo kept in this phone's form. Check your connection and sign-in, then attach it again to send.", true);
      }
    });
  }

  function isSmartCapture() {
    var heading = document.querySelector("#root header h2");
    return heading && heading.textContent.trim() === "Smart Capture Workflow";
  }

  class SmartCaptureCamera extends HTMLElement {
    constructor() {
      super();
      this.stream = null;
      this.opening = false;
      this.capturing = false;
      this.serial = 0;
      this.inputs = null;
      this.attachShadow({ mode: "open" }).innerHTML = `
        <style>
          :host { display:block; min-width:0; max-width:100%; contain:inline-size; margin:0 0 1.5rem; color:#111827; font-family:inherit; }
          * { box-sizing:border-box; }
          section { padding:1.5rem; border:1px solid #e5e7eb; border-radius:1.5rem; background:#fff; box-shadow:0 1px 2px #0000000d; }
          h3 { margin:0 0 .4rem; font-size:1.2rem; font-weight:800; }
          p { margin:0; color:#64748b; font-size:.9rem; line-height:1.5; }
          .buttons { display:flex; flex-wrap:wrap; gap:.6rem; margin-top:1rem; }
          button { min-height:44px; padding:.7rem 1rem; border:1px solid #cbd5e1; border-radius:.8rem; background:#fff; color:#334155; font:inherit; font-weight:600; font-size:.9rem; cursor:pointer; }
          button:first-child { color:white; background:#2563eb; border-color:#2563eb; }
          button:hover:not(:disabled) { filter:brightness(.96); }
          button:focus-visible { outline:3px solid #93c5fd; outline-offset:3px; }
          button:disabled { opacity:.45; cursor:not-allowed; }
          [hidden] { display:none !important; }
          video { display:block; min-width:0; width:100%; max-height:420px; margin-top:1rem; background:#0f172a; border-radius:1rem; object-fit:contain; }
          .status { margin-top:.8rem; }
          .status.error { padding:.75rem; border:1px solid #fcd34d; border-radius:.75rem; background:#fffbeb; color:#92400e; }
          [data-action="phone"] { order:-1; background:#2563eb; border-color:#2563eb; color:#fff; }
          .connection-link { display:inline-block; margin-top:.8rem; color:#1d4ed8; font-weight:600; text-underline-offset:3px; }
          @media (max-width:600px) { section { padding:1rem; } .buttons { display:grid; grid-template-columns:1fr 1fr; } button { width:100%; } }
        </style>
        <section aria-label="Smart Capture camera">
          <h3>Capture Asset Photos</h3>
          <p>Capture a clear photo of the asset tag and serial label, or upload an existing photo.</p>
          <div class="buttons">
            <button type="button" data-action="open">Open Camera</button>
            <button type="button" data-action="capture" disabled>Capture Photo</button>
            <button type="button" data-action="upload">Upload Photos</button>
            <button type="button" data-action="phone" hidden>Use Phone Camera</button>
            <button type="button" data-action="stop" hidden>Stop Camera</button>
          </div>
          <video autoplay playsinline muted hidden aria-label="Camera preview"></video>
          <p class="status" role="status" aria-live="polite" aria-atomic="true">Choose Open Camera or Upload Photos to begin.</p>
          <a class="connection-link" href="http://localhost:3001" target="_blank" rel="noopener" hidden>Open IPAS on this laptop for live camera</a>
          <p class="send-status status" role="status" aria-live="polite" hidden></p>
          <button type="button" data-action="retry" hidden>Retry Send</button>
        </section>`;
      this.video = this.shadowRoot.querySelector("video");
      this.status = this.shadowRoot.querySelector(".status");
      this.button = (action) => this.shadowRoot.querySelector('[data-action="' + action + '"]');
      this.button("open").addEventListener("click", () => this.open());
      this.button("capture").addEventListener("click", () => this.capture());
      this.button("upload").addEventListener("click", () => this.chooseFile(false));
      this.button("phone").addEventListener("click", () => this.chooseFile(true));
      this.button("stop").addEventListener("click", () => this.stop("Camera stopped."));
      this.button("retry").addEventListener("click", () => flushPhotos());
      this.video.addEventListener("loadeddata", () => this.refreshButtons());
      this.onVisibility = () => {
        if (document.hidden && (this.stream || this.opening)) this.stop("Camera paused. Choose Open Camera to resume.");
      };
      this.onSendStatus = () => {
        var status = this.shadowRoot.querySelector(".send-status");
        status.hidden = !isPhone;
        status.textContent = sendState.text;
        status.classList.toggle("error", sendState.error);
        this.button("retry").hidden = !isPhone || !sendState.error || !sendQueue.length;
        this.button("retry").disabled = sending;
      };
      this.onFileChange = (event) => {
        if (!isPhone || !this.active() || !this.inputs) return;
        if (event.target !== this.inputs.camera && event.target !== this.inputs.upload) return;
        // Capture phase: React clears input.value in its own change handler.
        var files = Array.from(event.target.files || []).filter((file) =>
          file.type.startsWith("image/") || /\.(?:jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(file.name));
        if (!files.length) return;
        this.message("Photo added to Captured Images on this phone.", false);
        sendPhotos(files);
      };
    }

    connectedCallback() {
      // Keep the existing wide equipment table inside its own scroll container.
      this.column = this.parentElement;
      this.previousMinWidth = this.column.style.minWidth;
      this.column.style.minWidth = "0";
      document.addEventListener("visibilitychange", this.onVisibility);
      document.addEventListener("change", this.onFileChange, true);
      window.addEventListener("ipas-smart-capture-send-status", this.onSendStatus);
      this.button("phone").hidden = !(
        (window.matchMedia && window.matchMedia("(pointer: coarse)").matches)
        || /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent)
      );
      if (isPhone && !window.isSecureContext) {
        this.button("open").hidden = true;
        this.button("capture").hidden = true;
        this.message("Choose Use Phone Camera or Upload Photos. Photos are also sent to Smart Capture on your laptop.", false);
      } else if (!window.isSecureContext) {
        this.shadowRoot.querySelector(".connection-link").hidden = false;
        this.message("Live camera preview needs HTTPS or localhost. Keep your laptop camera connection running, then open the laptop link below. Upload Photos remains available here.", false);
      }
      this.onSendStatus();
      this.refreshButtons();
    }

    disconnectedCallback() {
      document.removeEventListener("visibilitychange", this.onVisibility);
      document.removeEventListener("change", this.onFileChange, true);
      window.removeEventListener("ipas-smart-capture-send-status", this.onSendStatus);
      this.stop();
      if (this.column && this.column.style.minWidth === "0px") {
        this.column.style.minWidth = this.previousMinWidth;
      }
    }

    active() {
      return this.isConnected && isSmartCapture() && this.inputs && this.inputs.upload.isConnected;
    }

    message(text, error) {
      this.status.textContent = text;
      this.status.classList.toggle("error", Boolean(error));
    }

    refreshButtons() {
      this.button("open").disabled = this.opening || Boolean(this.stream);
      this.button("capture").disabled = this.capturing || !this.stream || this.video.readyState < 2 || !this.video.videoWidth;
      this.button("stop").hidden = !this.opening && !this.stream;
    }

    stop(text) {
      this.serial++;
      var stream = this.stream;
      this.stream = null;
      this.opening = false;
      this.video.pause();
      this.video.srcObject = null;
      this.video.hidden = true;
      if (stream) stream.getTracks().forEach((track) => track.stop());
      this.refreshButtons();
      if (text) this.message(text, false);
    }

    async open() {
      if (!this.active() || this.opening || this.stream) return;
      if (!window.isSecureContext) {
        this.message("Live camera preview needs HTTPS or localhost. Upload Photos remains available; on a phone, you can also use Use Phone Camera.", true);
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.message("This browser cannot open a live camera. Use Upload Photos or your phone camera instead.", true);
        return;
      }
      var serial = ++this.serial;
      this.opening = true;
      this.refreshButtons();
      this.message("Waiting for camera permission…", false);
      try {
        var stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
          });
        } catch (error) {
          if (!error || !["OverconstrainedError", "NotFoundError"].includes(error.name)) throw error;
          if (serial !== this.serial || !this.active()) return;
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        if (serial !== this.serial || !this.active()) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        this.stream = stream;
        stream.getTracks().forEach((track) => track.addEventListener("ended", () => {
          if (this.stream === stream) this.stop("Camera stopped. Choose Open Camera to try again.");
        }));
        this.video.srcObject = stream;
        this.video.hidden = false;
        await this.video.play();
        if (serial === this.serial && this.active()) this.message("Camera ready. Choose Capture Photo to add an image.", false);
      } catch (error) {
        if (serial !== this.serial || !this.active()) return;
        this.stop();
        var messages = {
          NotAllowedError: "Camera permission was denied. Allow camera access in your browser, then choose Open Camera again.",
          NotFoundError: "No camera was found. Connect a camera or choose Upload Photos.",
          NotReadableError: "The camera may be in use by another app. Close that app and try again.",
        };
        this.message(messages[error && error.name] || "Unable to open the camera. Choose Upload Photos or try again.", true);
      } finally {
        if (serial === this.serial) {
          this.opening = false;
          this.refreshButtons();
        }
      }
    }

    chooseFile(phone) {
      if (!this.active()) return;
      this.stop();
      var input = phone ? this.inputs.camera : this.inputs.upload;
      input.value = "";
      input.click();
    }

    async capture() {
      if (!this.active() || this.button("capture").disabled) return;
      var serial = this.serial;
      this.capturing = true;
      this.refreshButtons();
      try {
        var canvas = document.createElement("canvas");
        canvas.width = this.video.videoWidth;
        canvas.height = this.video.videoHeight;
        canvas.getContext("2d").drawImage(this.video, 0, 0);
        var blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
        if (!blob) throw new Error("No image was captured.");
        if (serial !== this.serial || !this.active()) return;
        var file = new File([blob], "capture-" + Date.now() + ".jpg", { type: "image/jpeg" });
        var transfer = new DataTransfer();
        transfer.items.add(file);
        this.inputs.upload.files = transfer.files;
        this.inputs.upload.dispatchEvent(new Event("change", { bubbles: true }));
        this.message("Photo added to Captured Images.", false);
      } catch (error) {
        if (this.active()) this.message("The photo could not be attached. Try again or choose Upload Photos.", true);
      } finally {
        this.capturing = false;
        this.refreshButtons();
      }
    }
  }

  customElements.define(tagName, SmartCaptureCamera);

  function sync() {
    var existing = document.querySelector(tagName);
    if (!isSmartCapture()) {
      if (existing) existing.remove();
      return;
    }
    var label = Array.from(document.querySelectorAll("#root p")).find((node) => node.textContent.trim() === "Captured Images");
    var card = label && label.closest("div.bg-white");
    if (!card) return;
    var scope = card.parentElement;
    var upload, camera;
    while (scope && scope.id !== "root") {
      upload = scope.querySelector('input[type="file"]:not([capture])');
      camera = scope.querySelector('input[type="file"][capture]');
      if (upload && camera) break;
      scope = scope.parentElement;
    }
    if (!upload || !camera) return;
    if (!existing) {
      existing = document.createElement(tagName);
      existing.inputs = { upload: upload, camera: camera };
      card.parentElement.insertBefore(existing, card);
    } else {
      existing.inputs = { upload: upload, camera: camera };
    }
  }

  var scheduled = false;
  var observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; sync(); });
  });
  var root = document.getElementById("root");
  if (root) observer.observe(root, { childList: true, subtree: true });
  sync();
}());
