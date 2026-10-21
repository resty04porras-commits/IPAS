import assert from "node:assert/strict";
import test from "node:test";
import { createLiquidationTextParser } from "../services/liquidationText.js";
import { createOcrRecognizer } from "../services/ocr/recognizer.js";

const parser = createLiquidationTextParser({ getMeaningfulOcrLines: (text) => text.split("\n") });

test("amount normalization preserves supported currency prefixes, thousands separators, and centavos", () => {
  for (const [input, expected] of [["250", "250.00"], ["250.5", "250.50"], ["250.05", "250.05"],
    ["PHP 1,250.50", "1250.50"], ["php 1,250", "1250.00"], ["₱ 85.75", "85.75"],
    ["P 50", "50.00"], ["  0.01  ", "0.01"], ["999999999.99", "999999999.99"]]) {
    assert.equal(parser.normalizeLiquidationAmount(input), expected, input);
  }
});

test("invalid, zero, negative, and out-of-range amounts retain an empty result", () => {
  for (const input of ["", " ", "PHP", "0", "0.00", "-25.00", "1.234", "1.2.3", "NaN", "Infinity",
    "1e3", "TOTAL 250.00", "1000000000", "9999999999.99"]) {
    assert.equal(parser.normalizeLiquidationAmount(input), "", input);
  }
});

test("a labeled payable amount takes precedence over cash, change, VAT, dates and reference numbers", () => {
  const text = ["DATE 2026-10-21", "REFERENCE 999", "TIN 888", "QUANTITY 30", "TOTAL PHP 250.75",
    "CASH TENDERED PHP 500.00", "CHANGE PHP 249.25", "VAT PHP 26.87"].join("\n");
  assert.equal(parser.extractBestLiquidationAmount(text), "250.75");
});

test("comma-separated payable totals preserve centavos", () => {
  assert.equal(parser.extractBestLiquidationAmount("BUS TICKET\nTOTAL AMOUNT PHP 1,250.50\nCASH TENDERED PHP 2,000.00\nCHANGE PHP 749.50"), "1250.50");
});

test("amounts without comma separators retain every digit instead of being split into three-digit chunks", () => {
  for (const [input, expected] of [["2500.00", "2500.00"], ["12500.50", "12500.50"], ["123456.75", "123456.75"],
    ["999999999.99", "999999999.99"], ["250.50", "250.50"]]) {
    assert.equal(parser.extractBestLiquidationAmount(`BUS TICKET\nTOTAL PHP ${input}`), expected, input);
  }
});

test("plain and comma-separated amounts produce the same payable value", () => {
  for (const [plain, grouped] of [["1250.50", "1,250.50"], ["12500.50", "12,500.50"], ["1234567.89", "1,234,567.89"]]) {
    assert.equal(parser.extractBestLiquidationAmount(`TOTAL PHP ${plain}`), parser.extractBestLiquidationAmount(`TOTAL PHP ${grouped}`));
  }
});

test("out-of-range unseparated amounts do not create smaller false candidates", () => {
  for (const input of ["1000000000", "9999999999.99"]) {
    assert.equal(parser.extractBestLiquidationAmount(`TOTAL PHP ${input}`), "", input);
  }
});

test("equal-scored amount candidates retain the existing higher-value tie break", () => {
  assert.equal(parser.extractBestLiquidationAmount("FARE PHP 250.00\nTOTAL PHP 350.00"), "350.00");
});

test("the existing lower-receipt preference is retained for otherwise comparable totals", () => {
  const text = ["FARE PHP 900.00", ...Array.from({ length: 8 }, () => "RECEIPT INFORMATION"), "TOTAL PHP 250.00"].join("\n");
  assert.equal(parser.extractBestLiquidationAmount(text), "250.00");
});

test("text without any positive amount retains an empty amount", () => {
  for (const text of ["", "BUS TICKET", "TOTAL PHP 0.00", "NO READABLE AMOUNT"]) {
    assert.equal(parser.extractBestLiquidationAmount(text), "", text);
  }
});

test("route extraction retains uppercase output and multi-word place names", () => {
  assert.deepEqual(parser.inferLiquidationRouteFromText("PASSENGER TICKET\nIloilo City - Roxas City"), { from: "ILOILO CITY", to: "ROXAS CITY" });
  assert.deepEqual(parser.inferLiquidationRouteFromText("CEBU   -   MANILA"), { from: "CEBU", to: "MANILA" });
});

test("the first explicit route remains selected when several route lines are present", () => {
  assert.deepEqual(parser.inferLiquidationRouteFromText("CEBU - MANILA\nILOILO - ROXAS"), { from: "CEBU", to: "MANILA" });
});

test("missing route evidence does not invent origin or destination", () => {
  for (const text of ["", "TOTAL PHP 250.00", "FROM: ILOILO\nTO: ROXAS", "DATE 2026-10-21"]) {
    assert.deepEqual(parser.inferLiquidationRouteFromText(text), { from: "", to: "" });
  }
});

test("receipt remarks retain their existing keyword labels and default", () => {
  for (const [text, expected] of [["terminal fee", "Terminal Fee"], ["vehicle pass", "Vehicle Pass"],
    ["passenger ticket", "Passenger Ticket"], ["ticket invoice", "Ticket"], ["shipping", "Ferry Fare"],
    ["bus ticket", "Bus Fare"], ["OFFICIAL RECEIPT", "Receipt/Ticket"], ["", "Receipt/Ticket"]]) {
    assert.equal(parser.inferLiquidationRemarksFromText(text), expected, text);
  }
});

test("remarks preserve the current precedence when several receipt keywords occur", () => {
  assert.equal(parser.inferLiquidationRemarksFromText("TERMINAL FEE SHIPPING BUS"), "Terminal Fee");
  assert.equal(parser.inferLiquidationRemarksFromText("VEHICLE PASS PASSENGER TICKET SHIPPING"), "Vehicle Pass");
  assert.equal(parser.inferLiquidationRemarksFromText("PASSENGER TICKET SHIPPING"), "Passenger Ticket");
  assert.equal(parser.inferLiquidationRemarksFromText("TICKET INVOICE BUS"), "Ticket");
});

test("transport labels and their existing precedence remain compatible", () => {
  for (const [text, expected] of [["shipping", "Ferry"], ["bus", "Bus"], ["vehicle pass", "Vehicle Pass"],
    ["SHIPPING BUS VEHICLE PASS", "Ferry"], ["BUS VEHICLE PASS", "Bus"], ["OFFICIAL RECEIPT", ""], ["", ""]]) {
    assert.equal(parser.inferLiquidationTransportMode(text), expected, text);
  }
});

test("amount and route interpretation continue using the shared line provider supplied by the caller", () => {
  const calls: string[] = [];
  const lines = ["TOTAL PHP 50.00", "CEBU - MANILA"];
  const shared = createLiquidationTextParser({ getMeaningfulOcrLines(text) { calls.push(text); return lines; } });
  assert.equal(shared.extractBestLiquidationAmount("source text"), "50.00");
  assert.deepEqual(shared.inferLiquidationRouteFromText("source text"), { from: "CEBU", to: "MANILA" });
  assert.deepEqual(calls, ["source text", "SOURCE TEXT"]);
  assert.deepEqual(lines, ["TOTAL PHP 50.00", "CEBU - MANILA"]);
});

test("text-source recognition integrates with receipt interpretation without starting an OCR engine", async () => {
  const unexpected = async () => { throw new Error("An OCR engine should not be invoked for text content"); };
  const recognizer = createOcrRecognizer({ engine: "easyocr", requestService: unexpected, requestWorker: unexpected,
    probeTimeoutMs: 1000, logger: { log() {}, warn() {} } });
  const { snapshot } = await recognizer.recognizeOcrDetailed({ name: "ticket.xlsx", kind: "excel", contentType: "text",
    mimeType: "application/json", content: "SHIPPING\nPASSENGER TICKET\nCEBU - MANILA\nTOTAL PHP 1,250.50" });
  assert.equal(parser.extractBestLiquidationAmount(snapshot.text), "1250.50");
  assert.deepEqual(parser.inferLiquidationRouteFromText(snapshot.text), { from: "CEBU", to: "MANILA" });
  assert.equal(parser.inferLiquidationRemarksFromText(snapshot.text), "Passenger Ticket");
  assert.equal(parser.inferLiquidationTransportMode(snapshot.text), "Ferry");
});
