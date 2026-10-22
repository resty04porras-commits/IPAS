export type IntakeRecord = {
  sourceName: string;
  components: string;
  description: string;
  hardwareId: string;
  serial: string;
  remarks: string;
  notes?: string;
};

export type AccountabilityFormPayload = {
  employeeName: string;
  employeeId: string;
  designation: string;
  department: string;
  effectiveDate: string;
  signature: string;
  signatureDataUrl?: string;
  processedBy: string;
  processedDate: string;
  checkedBy: string;
  checkedDate: string;
  verifiedBy: string;
  verifiedTitle: string;
  verifiedDate: string;
  notedBy: string;
  notedTitle: string;
  notedDate: string;
  items: IntakeRecord[];
};

export type AccountabilityExportFormat = "xlsx" | "pdf";
