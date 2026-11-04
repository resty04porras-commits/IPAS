/* Five-column comparison view. The recovered frontend keeps its result state,
 * source selection, history, Clear All and Proceed to Upload handlers. */
(function () {
  "use strict";
  if (window.__ipasComparisonReportInstalled) return;
  window.__ipasComparisonReportInstalled = true;
  var report = null, current = null, exportJob = null;
  var keys = ["components","description","hardwareId","serial","remarks"];
  function active() { return document.querySelector("#root header h2")?.textContent.trim() === "Comparison Tools"; }
  function owner() { try { return String(JSON.parse(localStorage.getItem("icc_user") || "null")?.employeeId || ""); } catch (_) { return ""; } }
  function node(tag,text) { var value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; }
  var style = node("style");
  style.textContent = '[data-ipas-comparison-field-table]{display:none!important}#ipas-comparison-equipment-report{width:100%;overflow-x:auto}#ipas-comparison-equipment-report table{border-collapse:collapse;table-layout:fixed;width:100%;min-width:960px;background:#fff;color:#0f172a;font-size:13px}#ipas-comparison-equipment-report th,#ipas-comparison-equipment-report td{border:1px solid #111;padding:9px 8px;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}#ipas-comparison-equipment-report th{text-align:center;font-weight:700;background:#fff}#ipas-comparison-equipment-report td{text-align:left;font-weight:400}#ipas-comparison-equipment-report col:nth-child(1){width:15%}#ipas-comparison-equipment-report col:nth-child(2){width:23%}#ipas-comparison-equipment-report col:nth-child(3){width:16%}#ipas-comparison-equipment-report col:nth-child(4){width:20%}#ipas-comparison-equipment-report col:nth-child(5){width:26%}#ipas-comparison-report-message{padding:12px 20px;color:#334155;font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}#ipas-comparison-report-message[data-error]{color:#b91c1c}';
  document.head.appendChild(style);
  function clear() {
    report?.remove(); report = null; current = null;
    document.querySelectorAll("[data-ipas-comparison-field-table]").forEach(table => table.removeAttribute("data-ipas-comparison-field-table"));
    document.getElementById("ipas-comparison-report-message")?.remove();
  }
  function card() {
    if (!active()) return null;
    var heading = Array.from(document.querySelectorAll("#root h2")).find(value => value.textContent.trim() === "Comparison Results");
    return heading?.parentElement?.parentElement?.parentElement || null;
  }
  function message(text,error) {
    var container = card(); if (!container) return;
    var element = document.getElementById("ipas-comparison-report-message");
    if (!element) { element = node("p"); element.id = "ipas-comparison-report-message"; element.setAttribute("role",error ? "alert" : "status"); container.append(element); }
    element.setAttribute("role",error ? "alert" : "status"); element.textContent = text; element.toggleAttribute("data-error",Boolean(error));
  }
  function snapshot() { return window.__ipasComparisonGetResults?.(); }
  function update() {
    var data = snapshot(), container = card();
    if (!active() || !data || data.owner !== owner() || !container) { if (report) clear(); return; }
    if (current === data.results && report?.isConnected) return;
    var legacy = Array.from(container.querySelectorAll("table")).find(table => table.id !== "ipas-comparison-report-table" && table.querySelector("th")?.textContent.trim() === "Field Name");
    // The renderer waits for the updated server's report rows; no partial or
    // guessed fallback view is created while application files are being copied.
    if (!legacy || !Array.isArray(data.results) || !data.results.every(result => result.reportRow && keys.every(key => typeof result.reportRow[key] === "string"))) return;
    clear(); current = data.results;
    report = node("div"); report.id = "ipas-comparison-equipment-report"; report.setAttribute("role","region"); report.setAttribute("aria-label","Equipment comparison results"); report.tabIndex = 0;
    var table = node("table"); table.id = "ipas-comparison-report-table";
    var cols = node("colgroup"); keys.forEach(() => cols.append(node("col"))); table.append(cols);
    var head = node("thead"), header = node("tr"); ["Components","Description","Hardware ID","Serial","Remarks"].forEach(label => {var th=node("th",label);th.scope="col";header.append(th);}); head.append(header); table.append(head);
    var body = node("tbody"); data.results.forEach(result => {var row=node("tr");keys.forEach(key=>row.append(node("td",result.reportRow[key])));body.append(row);}); table.append(body); report.append(table);
    legacy.setAttribute("data-ipas-comparison-field-table",""); legacy.parentElement.insertBefore(report,legacy);
  }
  async function exportReport(format,button) {
    var data = snapshot(); if (!data || data.owner !== owner() || exportJob) return;
    var job = {controller:new AbortController(),owner:data.owner,results:data.results}; exportJob = job;
    message("Preparing " + (format === "pdf" ? "PDF" : "Excel") + " report…"); button.setAttribute("aria-busy","true");
    try {
      var response = await fetch("/api/compare/export",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json","Accept":format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},body:JSON.stringify({results:data.results,format}),signal:job.controller.signal});
      if (!response.ok) {var failure=await response.json().catch(()=>null);throw new Error(failure?.error || "The comparison report could not be exported.");}
      var blob = await response.blob(); if (!active() || owner() !== job.owner || snapshot()?.results !== job.results) return;
      var url = URL.createObjectURL(blob), anchor = node("a"); anchor.href = url; anchor.download = "comparison-results." + format; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(()=>URL.revokeObjectURL(url),60000);
      message("Report downloaded.");
    } catch (error) { if (active() && owner() === job.owner && !job.controller.signal.aborted) message(error.message || "The comparison report could not be exported.",true); }
    finally { button.removeAttribute("aria-busy"); if (exportJob === job) exportJob = null; }
  }
  document.addEventListener("click",function(event) {
    var button = event.target?.closest?.("button"), container = card();
    if (!button || !container?.contains(button) || !report?.isConnected || !active()) return;
    var label = button.textContent.trim();
    if (["Export Excel","Export PDF"].includes(label)) { event.preventDefault();event.stopImmediatePropagation();void exportReport(label === "Export PDF" ? "pdf" : "xlsx",button); }
  },true);
  window.addEventListener("ipas:comparison-results",update);
  new MutationObserver(function() {
    if (exportJob && (!active() || owner() !== exportJob.owner || snapshot()?.results !== exportJob.results)) exportJob.controller.abort();
    update();
  }).observe(document.documentElement,{childList:true,subtree:true});
  update();
})();
