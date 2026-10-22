export type CompareRecord = {
  sn: string;
  district: string;
  branch: string;
  components: string;
  description: string;
  hardwareId: string;
  serial: string;
  remarks: string;
};

export type CompareResult = {
  doc: CompareRecord;
  img: CompareRecord;
  status: "match" | "mismatch" | "missing";
  mismatchedFields: string[];
  fieldNotes?: Partial<Record<ComparisonField, string>>;
  notes?: string;
};

export type ExtractedCompareRecord = CompareRecord & {
  notes?: string;
};

export type ComparisonField = "components" | "description" | "hardwareId" | "serial";

export function normalizeRecord(record: Partial<CompareRecord> | undefined): CompareRecord {
  return {
    sn: record?.sn || "",
    district: record?.district || "",
    branch: record?.branch || "",
    components: record?.components || "",
    description: record?.description || "",
    hardwareId: record?.hardwareId || "",
    serial: record?.serial || "",
    remarks: record?.remarks || "",
  };
}

export function normalizeExtractedRecord(record: Partial<ExtractedCompareRecord> | undefined): ExtractedCompareRecord {
  return {
    ...normalizeRecord(record),
    notes: typeof record?.notes === "string" ? record.notes : "",
  };
}

export function dedupePreserveOrder(values: string[]): string[] {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

export function normalizeGeneral(value: string): string {
  return value
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/[.,/#!$%^&*;:{}=_`~()]/g, "")
    .trim();
}

export function normalizeIdentifier(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeOcrIdentifier(value: string): string {
  return normalizeIdentifier(value)
    .replace(/O/g, "0")
    .replace(/I/g, "1")
    .replace(/L/g, "1")
    .replace(/S/g, "5")
    .replace(/B/g, "8")
    .replace(/Z/g, "2")  // Z ↔ 2 is a common OCR confusion
    .replace(/G/g, "6")  // G ↔ 6 on worn or small labels
    .replace(/T/g, "7"); // T ↔ 7 in compressed fonts
}

function getComparisonFieldLabel(field: ComparisonField): string {
  const labels: Record<ComparisonField, string> = {
    components: "Component",
    description: "Description",
    hardwareId: "Hardware ID",
    serial: "Serial",
  };

  return labels[field];
}

function normalizeComponentForComparison(value: string): string {
  const condensed = normalizeGeneral(value)
    .replace(/\bADAPTOR\b/g, "ADAPTER")       // normalise British/local spelling
    .replace(/\bDESKTOP COMPUTER\b/g, "SYSTEM UNIT")
    .replace(/\bCPU\b/g, "SYSTEM UNIT")
    .replace(/\s+/g, "");

  const aliases: Record<string, string> = {
    // System unit variants
    SYSTEMUNIT: "SYSTEMUNIT",
    DESKTOP: "SYSTEMUNIT",
    THINCLIENT: "SYSTEMUNIT",
    MINIPC: "SYSTEMUNIT",
    OPTIPLEX: "SYSTEMUNIT",
    ELITEDESK: "SYSTEMUNIT",
    // Monitor variants
    MONITOR: "MONITOR",
    DISPLAY: "MONITOR",
    LCD: "MONITOR",
    LEDMONITOR: "MONITOR",
    // Printer variants
    PRINTER: "PRINTER",
    LASERJET: "PRINTER",
    INKJET: "PRINTER",
    MULTIFUNCTION: "PRINTER",
    MFP: "PRINTER",
    // Laptop variants
    LAPTOP: "LAPTOP",
    NOTEBOOK: "LAPTOP",
    THINKPAD: "LAPTOP",
    ELITEBOOK: "LAPTOP",
    PAVILION: "LAPTOP",
    INSPIRON: "LAPTOP",
    // Input devices
    KEYBOARD: "KEYBOARD",
    MOUSE: "MOUSE",
    // Power
    UPS: "UPS",
    // Adapter variants — both CPU and Laptop normalize to CPUADAPTER for
    // comparison purposes (they are separate fields on forms but compare alike)
    CPUADAPTER: "CPUADAPTER",
    CPUADAPTOR: "CPUADAPTER",
    CPADAPTER: "CPUADAPTER",
    POWERADAPTER: "CPUADAPTER",
    ADAPTER: "CPUADAPTER",
    LAPTOPADADAPTER: "LAPTOPADAPTER",
    LAPTOPADAPTER: "LAPTOPADAPTER",
    LAPTOPADAPTOR: "LAPTOPADAPTER",
    // Webcam
    WEBCAM: "WEBCAM",
    CAMERA: "WEBCAM",
    // Scanner
    SCANNER: "SCANNER",
    SCANSNAP: "SCANNER",
    DOCUMENTSCANNER: "SCANNER",
    // Network
    ROUTER: "ROUTER",
    SWITCH: "SWITCH",
    NETWORKSWITCH: "SWITCH",
  };

  return aliases[condensed] || condensed;
}

function getDescriptionComparisonTokens(value: string): string[] {
  const stopWords = new Set([
    "MONITOR",
    "DISPLAY",
    "PRINTER",
    "KEYBOARD",
    "MOUSE",
    "SYSTEM",
    "UNIT",
    "UPS",
    "ADAPTER",
    "WEBCAM",
    "SCANNER",
    "ROUTER",
    "SWITCH",
    "DEVICE",
    "MODEL",
    "SERIES",
  ]);

  return dedupePreserveOrder(
    normalizeGeneral(value)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !stopWords.has(token))
  );
}

function descriptionsSubstantivelyMatch(expectedValue: string, observedValue: string): boolean {
  const expectedTokens = getDescriptionComparisonTokens(expectedValue);
  const observedTokens = getDescriptionComparisonTokens(observedValue);

  if (expectedTokens.length === 0 || observedTokens.length === 0) {
    return false;
  }

  const expectedSet = new Set(expectedTokens);
  const observedSet = new Set(observedTokens);
  const overlap = expectedTokens.filter((token) => observedSet.has(token));
  const smallerCount = Math.min(expectedSet.size, observedSet.size);

  if (smallerCount === 0) {
    return false;
  }

  const smallerHasModelLikeToken = [...expectedSet, ...observedSet].some((token) => /\d/.test(token));

  return overlap.length === smallerCount && (smallerCount >= 2 || smallerHasModelLikeToken);
}

function getMismatchReason(field: ComparisonField): string {
  switch (field) {
    case "serial":
      return "Verify the S/N label on the physical device matches the accountability form.";
    case "hardwareId":
      return "Check the property sticker on the equipment matches the asset tag in the form.";
    case "components":
      return "The equipment type recorded in the document differs from what is visible in the evidence photo. Verify the correct item was photographed.";
    case "description":
      return "The brand/model in the document differs from what is readable in the evidence photo.";
  }
}

export function compareField(field: ComparisonField, expectedValue: string, observedValue: string): { matches: boolean; note?: string } {
  const expected = expectedValue || "";
  const observed = observedValue || "";
  const label = getComparisonFieldLabel(field);

  // Both empty = match
  if (!expected && !observed) {
    return { matches: true };
  }

  // One is empty, one has value = mismatch
  if (!expected || !observed) {
    if (!expected && observed) {
      return {
        matches: false,
        note: `${label} "${observed}" was found in the evidence but is NOT recorded in the document. This item may be unregistered or was added after the form was filed.`,
      };
    }
    if (expected && !observed) {
      return {
        matches: false,
        note: `${label} "${expected}" is in the document but was NOT found in the evidence. The item may be missing from the photos, the label is not visible, or the equipment is absent.`,
      };
    }
  }

  // Both have values - compare them
  const isIdentifierField = field === "hardwareId" || field === "serial";
  const normalizedExpected = isIdentifierField
    ? normalizeIdentifier(expected)
    : field === "components"
      ? normalizeComponentForComparison(expected)
      : normalizeGeneral(expected);
  const normalizedObserved = isIdentifierField
    ? normalizeIdentifier(observed)
    : field === "components"
      ? normalizeComponentForComparison(observed)
      : normalizeGeneral(observed);

  if (normalizedExpected === normalizedObserved) {
    return { matches: true };
  }

  if (field === "description" && descriptionsSubstantivelyMatch(expected, observed)) {
    return { matches: true };
  }

  // Check for common OCR errors in identifiers
  if (isIdentifierField && normalizeOcrIdentifier(expected) === normalizeOcrIdentifier(observed)) {
    return {
      matches: false,
      note: `${label} likely has an OCR scan error — document: "${expected}", evidence: "${observed}". Characters that are commonly confused: 0/O, 1/I/L, 5/S, 8/B. Please verify the physical label manually.`,
    };
  }

  // Check for partial match or similar values
  if (normalizedExpected && normalizedObserved) {
    const similarity = calculateSimilarity(normalizedExpected, normalizedObserved);
    if (similarity > 0.8) {
      return {
        matches: false,
        note: `${label} is close but does not match exactly — document: "${expected}", evidence: "${observed}". ${getMismatchReason(field)}`,
      };
    }
  }

  // Complete mismatch
  return {
    matches: false,
    note: `${label} does not match — document: "${expected}", evidence: "${observed}". ${getMismatchReason(field)}`,
  };
}

function calculateSimilarity(str1: string, str2: string): number {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  
  if (longer.length === 0) return 1.0;
  
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(s1: string, s2: string): number {
  const costs: number[] = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

export function compareExtractedRecords(
  expectedRecords: ExtractedCompareRecord[],
  observedRecords: ExtractedCompareRecord[]
): CompareResult[] {
  const criticalFields: ComparisonField[] = ["components", "description", "hardwareId", "serial"];

  return expectedRecords.map((expected, index) => {
    const observed = normalizeExtractedRecord(observedRecords[index]);
    const mismatchedFields: string[] = [];
    const fieldNotes: Partial<Record<ComparisonField, string>> = {};

    const visibleObservedCritical = criticalFields.filter((field) => Boolean((observed[field] || "").trim()));
    const statusBase = visibleObservedCritical.length === 0 ? "missing" : "match";

    for (const field of criticalFields) {
      const comparison = compareField(field, expected[field], observed[field]);
      if (!comparison.matches) {
        mismatchedFields.push(field);
        if (comparison.note) {
          fieldNotes[field] = comparison.note;
        }
      }
    }

    const expectedHardwareId = normalizeIdentifier(expected.hardwareId || "");
    const expectedSerial = normalizeIdentifier(expected.serial || "");
    const observedHardwareId = normalizeIdentifier(observed.hardwareId || "");
    const observedSerial = normalizeIdentifier(observed.serial || "");

    if (
      expectedHardwareId
      && expectedHardwareId === observedSerial
      && expectedHardwareId !== observedHardwareId
      && !fieldNotes.hardwareId
    ) {
      fieldNotes.hardwareId = "Hardware ID appears to have been read into the evidence Serial field instead of the Hardware ID field.";
      if (!mismatchedFields.includes("hardwareId")) {
        mismatchedFields.push("hardwareId");
      }
    }

    if (
      expectedSerial
      && expectedSerial === observedHardwareId
      && expectedSerial !== observedSerial
      && !fieldNotes.serial
    ) {
      fieldNotes.serial = "Serial appears to have been read into the evidence Hardware ID field instead of the Serial field.";
      if (!mismatchedFields.includes("serial")) {
        mismatchedFields.push("serial");
      }
    }

    const finalStatus = statusBase === "missing" ? "missing" : mismatchedFields.length > 0 ? "mismatch" : "match";

    // Build per-field notes, always with a fallback reason for each mismatch field
    const fieldNoteLines = mismatchedFields.map((field) => {
      const existing = fieldNotes[field as ComparisonField];
      if (existing) return existing;
      const label = getComparisonFieldLabel(field as ComparisonField);
      return `${label} value could not be confirmed from the evidence — manual verification required.`;
    });

    const finalNotes = [
      ...fieldNoteLines,
      finalStatus === "missing"
        ? (observed.notes || "No evidence values were extracted for this record. The equipment may not have been photographed or the image is unclear.")
        : (finalStatus === "mismatch" && observed.notes ? `Evidence note: ${observed.notes}` : ""),
    ]
      .filter(Boolean)
      .join(" | ");

    return {
      doc: normalizeRecord(expected),
      img: normalizeRecord(observed),
      status: finalStatus,
      mismatchedFields,
      fieldNotes,
      notes: finalStatus === "match" ? undefined : (finalNotes || undefined),
    };
  });
}
