import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import {
  normalizeLiquidationRecord,
  buildManualLiquidationFallback,
  dedupeLiquidationRecords,
  sanitizeLiquidationPayload,
  parseCurrencyNumber,
  calculateLiquidationTotals,
  type LiquidationRecord,
  type LiquidationFormPayload,
} from "../services/liquidationRecords.js";

const row = (fields: Partial<LiquidationRecord> = {}) => normalizeLiquidationRecord(fields);

test("missing record fields retain blank strings, including notes", () => {
  assert.deepEqual(row(), {
    sourceName: "", transactionDate: "", time: "", from: "", to: "", modeOfTransportation: "",
    amount: "", perDiem: "", breakfast: "", lunch: "", dinner: "", others: "", remarks: "", notes: "",
  });
});

test("record preparation preserves existing strings and creates an independent object", () => {
  const original = Object.freeze({ sourceName: " Ticket.JPG ", transactionDate: "Oct 21, 2026", time: "8 AM",
    from: "Iloilo", to: "Roxas", modeOfTransportation: "Bus", amount: "PHP 2,500.50", perDiem: "500.00",
    breakfast: "50", lunch: "75", dinner: "100", others: "10.25", remarks: "Bus Fare", notes: "Review receipt" });
  const result = normalizeLiquidationRecord(original);
  assert.deepEqual(result, original);
  assert.notEqual(result, original);
});

test("non-string record values are left blank rather than silently becoming new amounts", () => {
  const result = normalizeLiquidationRecord({ sourceName: 123, amount: 2500, notes: false, time: null,
    others: { value: "100" }, unrecognized: "ignored" } as unknown as LiquidationRecord);
  assert.deepEqual(result, row());
  assert.equal("unrecognized" in result, false);
});

test("manual fallback keeps its source and diagnostic without inventing receipt values", () => {
  assert.deepEqual(buildManualLiquidationFallback("blurred.jpg", "Amount needs review"), {
    ...row(), sourceName: "blurred.jpg", remarks: "Receipt/Ticket", notes: "Amount needs review",
  });
});

test("form preparation retains header fields and normalizes rows without mutating the caller", () => {
  const item = Object.freeze({ sourceName: "bus.jpg", amount: "2500.00" });
  const input = Object.freeze({ employeeName: " Resty ", reportDate: "2026-10-21", designation: "Engineer", base: "Iloilo",
    purpose: "Site visit", cashAdvance: "PHP 3,000.00", preparedByName: "Prepared", preparedByTitle: "FE",
    checkedByName: "Checked", checkedByTitle: "SFE", reviewedByName: "Reviewed", reviewedByTitle: "Manager",
    notedByName: "Noted", notedByTitle: "Head", approvedByName: "Approved", approvedByTitle: "Director",
    items: Object.freeze([item]) });
  const result = sanitizeLiquidationPayload(input as unknown as LiquidationFormPayload);
  assert.deepEqual(result, { ...input, items: [row(item)], preparedBySignature: undefined });
  assert.notEqual(result.items, input.items);
  assert.notEqual(result.items[0], item);
  assert.equal(item.amount, "2500.00");
});

test("missing or non-array items retain the existing empty form result", () => {
  for (const value of [undefined, {}, { items: null }, { items: "not rows" }, { items: 4 }]) {
    assert.deepEqual(sanitizeLiquidationPayload(value as Partial<LiquidationFormPayload>), sanitizeLiquidationPayload(undefined));
  }
  assert.equal(sanitizeLiquidationPayload({ cashAdvance: 2500, employeeName: false } as unknown as LiquidationFormPayload).cashAdvance, "");
});

test("form preparation retains repeated rows and their original order", () => {
  const first = row({ sourceName: "same.jpg", amount: "100", notes: "first" });
  const second = row({ sourceName: "same.jpg", amount: "100", notes: "second" });
  const prepared = sanitizeLiquidationPayload({ items: [first, second] });
  assert.deepEqual(prepared.items, [first, second]);
  assert.equal(calculateLiquidationTotals(prepared.items, "500").totalExpenses, 200);
});

test("supported signature data URLs retain their original value", () => {
  for (const type of ["png", "jpeg", "jpg", "gif", "webp"]) {
    const signature = `data:image/${type};base64,YQ==`;
    assert.equal(sanitizeLiquidationPayload({ preparedBySignature: signature }).preparedBySignature, signature);
  }
});

test("unsupported or malformed signature fields retain an undefined signature", () => {
  for (const value of ["", "https://example.invalid/sig.png", "data:image/svg+xml;base64,YQ==",
    "data:image/png;base64,", "data:image/png;base64,***", "data:image/png;base64,YQ==\n", 123, null]) {
    assert.equal(sanitizeLiquidationPayload({ preparedBySignature: value } as unknown as LiquidationFormPayload).preparedBySignature, undefined);
  }
});

test("currency conversion retains comma, prefix, numeric and negative-value handling", () => {
  for (const [input, expected] of [["PHP 2,500.50", 2500.5], ["₱ 1,000", 1000], ["-25.75", -25.75],
    [".50", 0.5], [123.45, 123.45], ["0", 0]] as const) {
    assert.equal(parseCurrencyNumber(input), expected);
  }
});

test("empty, non-finite and malformed currency values retain a zero contribution", () => {
  for (const input of [undefined, null, "", "PHP", "1.2.3", "--25", "Infinity", Number.POSITIVE_INFINITY, NaN]) {
    assert.equal(parseCurrencyNumber(input), 0);
  }
});

test("all six expense columns contribute to the total and cash settlement", () => {
  const items = [row({ amount: "PHP 2,500.50", perDiem: "500", breakfast: "50.25", lunch: "100", dinner: "150", others: "25" }),
    row({ amount: "100", perDiem: "50", breakfast: "25", lunch: "75", dinner: "100", others: "-5" })];
  assert.deepEqual(calculateLiquidationTotals(items, "PHP 4,000.00"), {
    amount: 2600.5, perDiem: 550, breakfast: 75.25, lunch: 175, dinner: 250, others: 20,
    totalExpenses: 3670.75, cashAdvance: 4000, settlement: 329.25,
  });
});

test("settlement preserves negative and zero values when expenses reach or exceed the advance", () => {
  assert.equal(calculateLiquidationTotals([row({ amount: "1200.50" })], "1000").settlement, -200.5);
  assert.equal(calculateLiquidationTotals([row({ amount: "1000" })], "1000").settlement, 0);
  assert.deepEqual(calculateLiquidationTotals([], ""), {
    amount: 0, perDiem: 0, breakfast: 0, lunch: 0, dinner: 0, others: 0,
    totalExpenses: 0, cashAdvance: 0, settlement: 0,
  });
});

test("totals retain existing decimal arithmetic and do not rewrite the source amounts", () => {
  const first = Object.freeze(row({ amount: "0.1", others: "unreadable" }));
  const second = Object.freeze(row({ amount: "0.2" }));
  const result = calculateLiquidationTotals([first, second], 1);
  assert.equal(result.amount, 0.1 + 0.2);
  assert.equal(result.others, 0);
  assert.equal(result.settlement, 1 - (0.1 + 0.2));
  assert.equal(first.amount, "0.1");
});

test("the standalone deduplication helper retains the first original row for its existing key", () => {
  const first = row({ sourceName: " Ticket.JPG ", transactionDate: " OCT 21 ", amount: " 100.00 ", remarks: " Bus Fare ", from: "ILOILO" });
  const duplicate = row({ sourceName: "ticket.jpg", transactionDate: "oct 21", amount: "100.00", remarks: "bus fare", from: "ROXAS" });
  const different = row({ sourceName: "ticket.jpg", transactionDate: "oct 21", amount: "150.00", remarks: "bus fare" });
  const result = dedupeLiquidationRecords([first, duplicate, different]);
  assert.deepEqual(result, [first, different]);
  assert.equal(result[0], first);
  assert.equal(first.sourceName, " Ticket.JPG ");
  assert.deepEqual(sanitizeLiquidationPayload({ items: [first, duplicate] }).items, [first, duplicate]);
});

test("distinct source, date and remarks retain separate rows in the standalone helper", () => {
  const common = { sourceName: "ticket.jpg", transactionDate: "2026-10-21", amount: "100", remarks: "Bus Fare" };
  const items = [row(common), row({ ...common, sourceName: "other.jpg" }), row({ ...common, transactionDate: "2026-10-22" }), row({ ...common, remarks: "Terminal Fee" })];
  assert.deepEqual(dedupeLiquidationRecords(items), items);
});

test("existing export controller receives prepared rows and totals and retains empty-row validation", async (t) => {
  // The controller imports the DB module, although its export handler makes no
  // DB request. Give that unused pool isolated settings rather than loading any
  // real credentials, then restore the test process's environment.
  const settings = { DB_HOST: "127.0.0.1", DB_PORT: "1", DB_NAME: "unused_export_test",
    DB_USER: "unused_export_test", DB_PASSWORD: "unused_export_test" };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  let createTerLiquidationController: typeof import("../controllers/terController.js").createTerLiquidationController;
  try {
    Object.assign(process.env, settings);
    ({ createTerLiquidationController } = await import("../controllers/terController.js"));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const { db } = await import("../database/postgres.js");
  t.after(() => db.end());
  const captured: Array<{ payload: LiquidationFormPayload; format: string }> = [];
  const unused = async (): Promise<never> => { throw new Error("Not used by export"); };
  const controller = createTerLiquidationController({
    prepareUploadedFileForComparison: unused, extractLiquidationRecordsFromEvidence: unused,
    isInvalidStructuredResponse: () => false, isGeminiUnavailable: () => false,
    extractUpstreamErrorMessage: () => "", sanitizeLiquidationPayload,
    getLiquidationExportFormat: (value) => value === "pdf" ? "pdf" : "xlsx",
    async generateLiquidationExport(payload, format) {
      captured.push({ payload, format });
      return { buffer: Buffer.from(JSON.stringify(calculateLiquidationTotals(payload.items, payload.cashAdvance))),
        contentType: "application/json", extension: format };
    },
  });
  const app = express(); app.use(express.json()); app.post("/export", controller.exportLiquidation);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/export`;
  const input = { employeeName: "Test Employee", cashAdvance: "3000", items: [{ sourceName: "receipt.jpg", amount: "2500.50", lunch: "100" }] };
  for (const format of ["xlsx", "pdf"]) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, format }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-disposition"), `attachment; filename="test-employee-liquidation-form.${format}"`);
    assert.equal((await response.json()).settlement, 399.5);
  }
  assert.deepEqual(captured.map(({ format }) => format), ["xlsx", "pdf"]);
  assert.deepEqual(captured[0].payload.items, [row(input.items[0])]);
  const empty = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { error: "At least one liquidation row is required before export." });
  assert.equal(captured.length, 2);
});
