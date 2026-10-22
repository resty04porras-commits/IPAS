import * as XLSX from "xlsx";
import type { AccountabilityFormPayload } from "../types/accountability.js";

export function buildSmartCaptureExportRows(payload: AccountabilityFormPayload): string[][] {
  const formRows = [
    ["Name", payload.employeeName, "ID No.", payload.employeeId],
    ["Designation", payload.designation, "Department", payload.department],
    ["Effective Date", payload.effectiveDate, "Processed By", payload.processedBy],
    ["Processed Date", payload.processedDate, "Checked By", payload.checkedBy],
    ["Checked Date", payload.checkedDate, "Verified By", payload.verifiedBy],
    ["Verified Title", payload.verifiedTitle, "Verified Date", payload.verifiedDate],
    ["Noted By", payload.notedBy, "Noted Title", payload.notedTitle],
    ["Noted Date", payload.notedDate, "", ""],
  ];

  return [
    ["Smart Capture Workflow"],
    [],
    ["Equipment Details"],
    ["Components", "Description", "Hardware ID", "Serial", "Remarks"],
    ...payload.items.map((item) => [
      item.components,
      item.description,
      item.hardwareId,
      item.serial,
      item.remarks,
    ]),
    [],
    ["Form Details"],
    ...formRows,
    [],
    ["Processed Signature", payload.signatureDataUrl ? "Attached" : payload.signature || ""],
  ];
}

export function generateSmartCaptureExcelExport(payload: AccountabilityFormPayload): Buffer {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(buildSmartCaptureExportRows(payload));

  worksheet["!cols"] = [
    { wch: 24 },
    { wch: 30 },
    { wch: 22 },
    { wch: 24 },
    { wch: 30 },
  ];

  XLSX.utils.book_append_sheet(workbook, worksheet, "Smart Capture");
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}
