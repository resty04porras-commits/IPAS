/** Liquidation record preparation and totals; persistence and export rendering stay with callers. */
export type LiquidationRecord = {
  sourceName: string;
  transactionDate: string;
  time: string;
  from: string;
  to: string;
  modeOfTransportation: string;
  amount: string;
  perDiem: string;
  breakfast: string;
  lunch: string;
  dinner: string;
  others: string;
  remarks: string;
  notes?: string;
};

export type LiquidationFormPayload = {
  employeeName: string;
  reportDate: string;
  designation: string;
  base: string;
  purpose: string;
  cashAdvance: string;
  preparedByName: string;
  preparedByTitle: string;
  checkedByName: string;
  checkedByTitle: string;
  reviewedByName: string;
  reviewedByTitle: string;
  notedByName: string;
  notedByTitle: string;
  approvedByName: string;
  approvedByTitle: string;
  items: LiquidationRecord[];
  preparedBySignature?: string;
};

export function normalizeLiquidationRecord(record: Partial<LiquidationRecord> | undefined): LiquidationRecord {
  return {
    sourceName: typeof record?.sourceName === "string" ? record.sourceName : "",
    transactionDate: typeof record?.transactionDate === "string" ? record.transactionDate : "",
    time: typeof record?.time === "string" ? record.time : "",
    from: typeof record?.from === "string" ? record.from : "",
    to: typeof record?.to === "string" ? record.to : "",
    modeOfTransportation: typeof record?.modeOfTransportation === "string" ? record.modeOfTransportation : "",
    amount: typeof record?.amount === "string" ? record.amount : "",
    perDiem: typeof record?.perDiem === "string" ? record.perDiem : "",
    breakfast: typeof record?.breakfast === "string" ? record.breakfast : "",
    lunch: typeof record?.lunch === "string" ? record.lunch : "",
    dinner: typeof record?.dinner === "string" ? record.dinner : "",
    others: typeof record?.others === "string" ? record.others : "",
    remarks: typeof record?.remarks === "string" ? record.remarks : "",
    notes: typeof record?.notes === "string" ? record.notes : "",
  };
}

export function buildManualLiquidationFallback(sourceName: string, note: string): LiquidationRecord {
  return {
    sourceName,
    transactionDate: "",
    time: "",
    from: "",
    to: "",
    modeOfTransportation: "",
    amount: "",
    perDiem: "",
    breakfast: "",
    lunch: "",
    dinner: "",
    others: "",
    remarks: "Receipt/Ticket",
    notes: note,
  };
}

export function dedupeLiquidationRecords(records: LiquidationRecord[]): LiquidationRecord[] {
  const seen = new Set<string>();

  return records.filter((record) => {
    const normalized = normalizeLiquidationRecord(record);
    const key = [
      normalized.sourceName.trim().toUpperCase(),
      normalized.transactionDate.trim().toUpperCase(),
      normalized.amount.trim().toUpperCase(),
      normalized.remarks.trim().toUpperCase(),
    ].join("|");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

export function sanitizeLiquidationPayload(payload: Partial<LiquidationFormPayload> | undefined): LiquidationFormPayload {
  const normalizedItems = Array.isArray(payload?.items) ? payload.items.map(normalizeLiquidationRecord) : [];

  return {
    employeeName: typeof payload?.employeeName === "string" ? payload.employeeName : "",
    reportDate: typeof payload?.reportDate === "string" ? payload.reportDate : "",
    designation: typeof payload?.designation === "string" ? payload.designation : "",
    base: typeof payload?.base === "string" ? payload.base : "",
    purpose: typeof payload?.purpose === "string" ? payload.purpose : "",
    cashAdvance: typeof payload?.cashAdvance === "string" ? payload.cashAdvance : "",
    preparedByName: typeof payload?.preparedByName === "string" ? payload.preparedByName : "",
    preparedByTitle: typeof payload?.preparedByTitle === "string" ? payload.preparedByTitle : "",
    checkedByName: typeof payload?.checkedByName === "string" ? payload.checkedByName : "",
    checkedByTitle: typeof payload?.checkedByTitle === "string" ? payload.checkedByTitle : "",
    reviewedByName: typeof payload?.reviewedByName === "string" ? payload.reviewedByName : "",
    reviewedByTitle: typeof payload?.reviewedByTitle === "string" ? payload.reviewedByTitle : "",
    notedByName: typeof payload?.notedByName === "string" ? payload.notedByName : "",
    notedByTitle: typeof payload?.notedByTitle === "string" ? payload.notedByTitle : "",
    approvedByName: typeof payload?.approvedByName === "string" ? payload.approvedByName : "",
    approvedByTitle: typeof payload?.approvedByTitle === "string" ? payload.approvedByTitle : "",
    items: normalizedItems,
    preparedBySignature: (
      typeof payload?.preparedBySignature === "string" &&
      /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(payload.preparedBySignature)
    ) ? payload.preparedBySignature : undefined,
  };
}

export function parseCurrencyNumber(value: unknown): number {
  const normalized = String(value || "").replace(/[^\d.-]+/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

export function calculateLiquidationTotals(items: LiquidationRecord[], cashAdvanceValue: unknown) {
  const columnTotals = items.reduce((sum, item) => ({
    amount: sum.amount + parseCurrencyNumber(item.amount),
    perDiem: sum.perDiem + parseCurrencyNumber(item.perDiem),
    breakfast: sum.breakfast + parseCurrencyNumber(item.breakfast),
    lunch: sum.lunch + parseCurrencyNumber(item.lunch),
    dinner: sum.dinner + parseCurrencyNumber(item.dinner),
    others: sum.others + parseCurrencyNumber(item.others),
  }), { amount: 0, perDiem: 0, breakfast: 0, lunch: 0, dinner: 0, others: 0 });
  const totalExpenses = columnTotals.amount
    + columnTotals.perDiem
    + columnTotals.breakfast
    + columnTotals.lunch
    + columnTotals.dinner
    + columnTotals.others;
  const cashAdvance = parseCurrencyNumber(cashAdvanceValue);
  const settlement = cashAdvance - totalExpenses;

  return {
    ...columnTotals,
    totalExpenses,
    cashAdvance,
    settlement,
  };
}
