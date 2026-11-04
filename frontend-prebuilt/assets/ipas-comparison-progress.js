/* Comparison-only progress adapter for the recovered frontend. The existing
 * result table, history and export handlers continue to receive their array. */
(function () {
  "use strict";
  if (window.__ipasComparisonProgressInstalled) return;
  window.__ipasComparisonProgressInstalled = true;
  var nativeFetch = window.fetch.bind(window), activeJob = null, panel = null;
  window.__ipasComparisonGetResults = function () { return activeJob?.results && owner() === activeJob.owner ? {results:activeJob.results,owner:activeJob.owner} : null; };
  function publishResults() { window.dispatchEvent(new CustomEvent("ipas:comparison-results",{detail:window.__ipasComparisonGetResults()})); }
  function active() { return document.querySelector("#root header h2")?.textContent.trim() === "Comparison Tools"; }
  function owner() { try { return String(JSON.parse(localStorage.getItem("icc_user") || "null")?.employeeId || ""); } catch (_) { return ""; } }
  function node(tag, text, className) { var result = document.createElement(tag); if (text !== undefined) result.textContent = text; if (className) result.className = className; return result; }
  var style = node("style");
  style.textContent = '#ipas-comparison-progress{box-sizing:border-box;max-width:100%;padding:18px;margin:0 0 24px;border:1px solid #bfdbfe;border-radius:14px;background:#fff;color:#0f172a;font:inherit}#ipas-comparison-progress *{box-sizing:border-box}#ipas-comparison-progress .comparison-top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}#ipas-comparison-progress p{font-size:14px;line-height:1.5;margin:8px 0;color:#475569}#ipas-comparison-progress button{min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;background:#fff;border-radius:8px;cursor:pointer;font:inherit;font-size:13px}#ipas-comparison-progress progress{width:100%;height:12px;margin-top:12px}#ipas-comparison-progress summary{cursor:pointer;font-weight:600;padding:12px 0}#ipas-comparison-progress .comparison-scroll{overflow-x:auto;max-width:100%}#ipas-comparison-progress table{border-collapse:collapse;min-width:620px;width:100%;font-size:13px}#ipas-comparison-progress th,#ipas-comparison-progress td{border:1px solid #e2e8f0;text-align:left;padding:9px;vertical-align:top;overflow-wrap:anywhere}#ipas-comparison-progress th{background:#f8fafc}#ipas-comparison-progress h4{margin:16px 0 8px;font-size:14px}#ipas-comparison-progress .comparison-note{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}';
  document.head.appendChild(style);
  function removePanel() { panel?.remove(); panel = null; }
  function ensurePanel() {
    if (!active() || !activeJob) return;
    var button = Array.from(document.querySelectorAll("#root button")).find(button => /^(?:Compare Documents|Analyzing Data\.\.\.)$/.test(button.textContent.trim()));
    if (!button) return;
    if (!panel) {
      panel = node("section"); panel.id = "ipas-comparison-progress"; panel.setAttribute("aria-label", "Comparison progress");
      var top = node("div", undefined, "comparison-top"), heading = node("strong", "Comparison in progress"), cancel = node("button", "Cancel comparison");
      cancel.type = "button"; cancel.onclick = () => { if (activeJob?.running) { activeJob.reason = "Comparison cancelled. The selected files were kept."; activeJob.controller.abort(); } };
      top.append(heading,cancel); panel.append(top,node("p", "Preparing comparison…"));
      var bar = node("progress"); bar.max = 1; bar.value = 0; bar.setAttribute("aria-label", "Evidence reading progress"); panel.append(bar,node("p", "Elapsed: 0:00"));
    }
    if (!panel.isConnected) button.parentElement.insertAdjacentElement("afterend",panel);
  }
  function paint(job) {
    if (activeJob !== job || !active()) return;
    ensurePanel(); if (!panel) return;
    var top = panel.querySelector(".comparison-top"); top.querySelector("strong").textContent = job.running ? "Comparison in progress" : job.failed ? "Comparison stopped" : "Comparison complete";
    top.querySelector("button").hidden = !job.running;
    panel.querySelector("p").textContent = job.message || "Preparing comparison…";
    var bar = panel.querySelector("progress"); bar.max = job.total || 1; bar.value = job.completed || 0;
    var elapsed = Math.max(0,Math.floor((Date.now() - job.started) / 1000));
    panel.querySelectorAll("p")[1].textContent = "Elapsed: " + Math.floor(elapsed/60) + ":" + String(elapsed%60).padStart(2,"0");
  }
  function showAll(job, results) {
    paint(job); if (!panel || activeJob !== job || !active()) return;
    panel.querySelector("details")?.remove();
    var expected = results.filter(row => ["components","description","hardwareId","serial"].some(field => row.doc?.[field]));
    var extra = results.length - expected.length;
    job.message = "Document rows: " + expected.length + ". Matches: " + expected.filter(row => row.status === "match").length +
      "; differences: " + expected.filter(row => row.status === "mismatch").length + "; missing: " + expected.filter(row => row.status === "missing").length +
      (extra ? "; unassigned evidence items: " + extra : "") + ". Review the readable values against the original files.";
    paint(job);
    job.results = results; publishResults();
  }
  function finish(job, error, results) {
    if (!job.running) return;
    job.running = false; job.failed = Boolean(error); clearTimeout(job.deadline); clearInterval(job.clock);
    if (error) job.message = job.failureMessage = error.message || "Comparison could not finish. The selected files were kept.";
    if (Array.isArray(results)) showAll(job,results); else paint(job);
  }
  function urlOf(input) { try { return new URL(typeof input === "string" || input instanceof URL ? input : input.url,location.href); } catch (_) { return null; } }
  async function includeOriginalPdfs(body) {
    if (typeof body !== "string") return body;
    var data; try { data = JSON.parse(body); } catch (_) { return body; }
    if (!data.source1 || !Array.isArray(data.source2)) return body;
    var inputs = Array.from(document.querySelectorAll('#root input[type="file"]'));
    async function original(source, file) {
      if (source?.kind !== "pdf" || !file || file.name !== source.name || !(file.type === "application/pdf" || /\.pdf$/i.test(file.name))) return source;
      if (file.size > 20 * 1024 * 1024) throw new Error("The selected PDF exceeds the 20 MB local-reading limit.");
      var bytes = new Uint8Array(await file.arrayBuffer()), binary = "";
      for (var start = 0; start < bytes.length; start += 16384) binary += String.fromCharCode.apply(null,bytes.subarray(start,start+16384));
      return { ...source, contentType: "inlineData", mimeType: "application/pdf", content: btoa(binary) };
    }
    data.source1 = await original(data.source1,inputs[0]?.files?.[0]);
    for (var index = 0; index < data.source2.length; index++) data.source2[index] = await original(data.source2[index],inputs[1]?.files?.[index]);
    return JSON.stringify(data);
  }
  window.fetch = async function (input, init) {
    var url = urlOf(input), method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!active() || !url || url.origin !== location.origin || !["/api/compare","/api/compare-upload"].includes(url.pathname) || method !== "POST") return nativeFetch(input,init);
    if (activeJob?.running) throw new Error("A comparison is already running.");
    var job = { running: true, failed: false, started: Date.now(), owner: owner(), controller: new AbortController(), message: "Preparing the selected files…", completed: 0, total: 1 };
    activeJob = job; publishResults(); removePanel(); paint(job);
    job.clock = setInterval(() => paint(job),1000);
    job.deadline = setTimeout(() => { job.reason = "Comparison reached its time limit. The selected files were kept."; job.controller.abort(); },15*60000);
    var originalSignal = init?.signal || (input instanceof Request ? input.signal : null);
    var abort = () => { job.reason ||= "Comparison stopped. The selected files were kept."; job.controller.abort(); };
    originalSignal?.addEventListener("abort",abort,{once:true});
    if (originalSignal?.aborted) abort();
    var headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined)); headers.set("Accept","application/x-ndjson");
    try {
      // Keep the original PDF geometry; the recovered frontend's flattened text
      // loses column positions. Other document types and endpoints stay intact.
      var body = url.pathname === "/api/compare" ? await includeOriginalPdfs(init?.body) : init?.body;
      var response = await nativeFetch(input,{ ...init, ...(body !== undefined ? {body} : {}), headers, signal: job.controller.signal });
      // Headers arrive before OCR. Returning the response now lets the existing
      // caller clear its 90-second timer while the JSON body continues reading.
      if (!response.ok || !String(response.headers.get("Content-Type") || "").includes("application/x-ndjson")) {
        response.clone().json().then(data => finish(job,response.ok ? null : new Error(data.error || "Comparison failed."),Array.isArray(data) ? data : data.results)).catch(error => finish(job,error)).finally(() => originalSignal?.removeEventListener("abort",abort));
        return response;
      }
      var reader = response.body.getReader(), decoder = new TextDecoder();
      var stream = new ReadableStream({
        async start(controller) {
          var buffer = "", completed = false;
          function line(text) {
            if (!text.trim()) return;
            var update = JSON.parse(text);
            if (owner() !== job.owner || !active()) throw new Error("Comparison stopped after leaving this account or tool.");
            if (update.stage === "progress") { Object.assign(job,update.progress); paint(job); }
            if (update.stage === "error") { job.protocolError = update.error || "Comparison could not finish. The selected files were kept."; throw new Error(job.protocolError); }
            if (update.stage === "final") {
              if (!Array.isArray(update.results)) throw new Error("Comparison returned incomplete results.");
              completed = true; finish(job,null,update.results); controller.enqueue(new TextEncoder().encode(JSON.stringify(update.results)));
            }
          }
          try {
            for (;;) {
              var chunk = await reader.read(); buffer += decoder.decode(chunk.value || new Uint8Array(),{stream:!chunk.done});
              if (buffer.length > 5 * 1024 * 1024) throw new Error("Comparison returned an oversized response.");
              var split; while ((split = buffer.indexOf("\n")) !== -1) { line(buffer.slice(0,split)); buffer = buffer.slice(split+1); }
              if (chunk.done) break;
            }
            if (buffer.trim()) line(buffer);
            if (!completed) throw new Error("Comparison stopped before completion. The selected files were kept.");
            controller.close();
          } catch (error) {
            var problem = new Error(job.reason || error.message || "Comparison could not finish."); finish(job,problem); controller.error(problem);
          } finally { reader.releaseLock(); originalSignal?.removeEventListener("abort",abort); }
        },
        cancel() { abort(); finish(job,new Error(job.reason)); },
      });
      var outputHeaders = new Headers(response.headers); outputHeaders.set("Content-Type","application/json; charset=utf-8"); outputHeaders.delete("Content-Length");
      var output = new Response(stream,{status:response.status,statusText:response.statusText,headers:outputHeaders});
      var readJson = output.json.bind(output);
      // Some browser/transport combinations reduce a stream error to "Failed
      // to fetch". Retain the explicit server reason for the existing caller.
      output.json = async function () {
        try { return await readJson(); }
        catch (error) { throw new Error(job.protocolError || job.reason || job.failureMessage || error.message || "Comparison could not finish."); }
      };
      return output;
    } catch (error) {
      originalSignal?.removeEventListener("abort",abort); finish(job,new Error(job.reason || error.message)); throw error;
    }
  };
  new MutationObserver(() => {
    if (activeJob?.running && (!active() || owner() !== activeJob.owner)) { activeJob.reason = "Comparison stopped after leaving this account or tool."; activeJob.controller.abort(); }
    if (!active()) removePanel(); else if (activeJob) ensurePanel();
  }).observe(document.documentElement,{childList:true,subtree:true});
  document.addEventListener("click",event => {
    var button = event.target?.closest?.("#root button");
    if (active() && !activeJob?.running && button && ["Reset All","Clear All"].includes(button.textContent.trim())) { activeJob = null; publishResults(); removePanel(); }
  },true);
})();
