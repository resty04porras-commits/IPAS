interface LiquidationTextDependencies {
  getMeaningfulOcrLines: (text: string) => string[];
}

/** Receipt-text interpretation only; OCR, fallback and record persistence remain with their callers. */
export function createLiquidationTextParser(dependencies: LiquidationTextDependencies) {
  const { getMeaningfulOcrLines } = dependencies;

  function normalizeLiquidationAmount(value: string): string {
    const cleaned = (value || "")
      .replace(/php/gi, "")
      .replace(/[p₱]/gi, "")
      .replace(/[, ]+/g, "")
      .trim();

    if (!cleaned || !/^\d+(?:\.\d{1,2})?$/.test(cleaned)) {
      return "";
    }

    const numeric = Number.parseFloat(cleaned);
    if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 1_000_000_000) {
      return "";
    }

    return numeric.toFixed(2);
  }

  function scoreLiquidationAmountCandidate(line: string, rawAmount: string): number {
    const normalizedLine = line.toUpperCase();
    let score = 0;

    if (/(GRAND\s+TOTAL|TOTAL\s+AMOUNT|TOTAL\s+DUE|AMOUNT\s+DUE|TOTAL|FARE|AMOUNT|PAID|PRICE)/i.test(normalizedLine)) {
      score += 40;
    }

    if (/(CASH\s+TENDERED|CHANGE|VAT|TIN|QTY|QUANTITY|PHONE|REFERENCE|REF\.?|AUTH|TRACE|BILL\s+TO|DISCOUNT)/i.test(normalizedLine)) {
      score -= 24;
    }

    if (/[.:]\s*$/.test(normalizedLine)) {
      score += 4;
    }

    if (/\.\d{2}\b/.test(rawAmount)) {
      score += 8;
    }

    const numeric = Number.parseFloat(rawAmount.replace(/,/g, ""));
    if (Number.isFinite(numeric)) {
      if (numeric >= 10) {
        score += 6;
      }
      if (numeric >= 1000) {
        score += 2;
      }
    }

    return score;
  }

  function extractBestLiquidationAmount(text: string): string {
    const lines = getMeaningfulOcrLines(text);
    const candidates: Array<{ value: string; score: number }> = [];

    lines.forEach((line, index) => {
      const matches = line.match(/(?:PHP|[P₱])?\s*\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|(?:PHP|[P₱])?\s*\d+(?:\.\d{1,2})?/gi) || [];
      for (const match of matches) {
        const normalized = normalizeLiquidationAmount(match);
        if (!normalized) {
          continue;
        }

        const edgeBonus = index >= Math.max(0, lines.length - 6) ? 4 : 0;
        candidates.push({
          value: normalized,
          score: scoreLiquidationAmountCandidate(line, normalized) + edgeBonus,
        });
      }
    });

    candidates.sort((left, right) => right.score - left.score || Number.parseFloat(right.value) - Number.parseFloat(left.value));
    return candidates[0]?.value || "";
  }

  function inferLiquidationRouteFromText(text: string): { from: string; to: string } {
    const normalizedLines = getMeaningfulOcrLines(text.toUpperCase());

    for (const line of normalizedLines) {
      const routeMatch = line.match(/\b([A-Z][A-Z .]{2,30})\s*-\s*([A-Z][A-Z .]{2,30})\b/);
      if (routeMatch) {
        return {
          from: routeMatch[1].trim().replace(/\s+/g, " "),
          to: routeMatch[2].trim().replace(/\s+/g, " "),
        };
      }
    }

    return { from: "", to: "" };
  }

  function inferLiquidationRemarksFromText(text: string): string {
    const upper = text.toUpperCase();

    if (upper.includes("TERMINAL FEE")) {
      return "Terminal Fee";
    }
    if (upper.includes("VEHICLE PASS")) {
      return "Vehicle Pass";
    }
    if (upper.includes("PASSENGER TICKET")) {
      return "Passenger Ticket";
    }
    if (upper.includes("TICKET INVOICE")) {
      return "Ticket";
    }
    if (upper.includes("SHIPPING")) {
      return "Ferry Fare";
    }
    if (upper.includes("BUS")) {
      return "Bus Fare";
    }

    return "Receipt/Ticket";
  }

  function inferLiquidationTransportMode(text: string): string {
    const upper = text.toUpperCase();

    if (upper.includes("SHIPPING")) {
      return "Ferry";
    }
    if (upper.includes("BUS")) {
      return "Bus";
    }
    if (upper.includes("VEHICLE PASS")) {
      return "Vehicle Pass";
    }

    return "";
  }

  return {
    normalizeLiquidationAmount,
    extractBestLiquidationAmount,
    inferLiquidationRouteFromText,
    inferLiquidationRemarksFromText,
    inferLiquidationTransportMode,
  };
}
