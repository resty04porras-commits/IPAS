import type { IntakeRecord } from "../types/accountability.js";

export const EQUIPMENT_TYPES = ["Laptop", "Laptop Adapter", "Laptop Bag", "CPU", "Monitor", "Monitor Adapter", "CPU Adapter", "Printer", "Scanner", "Keyboard", "Mouse", "UPS", "Speaker", "Webcam", "External Drive", "Flashdrive", "Fan", "IP Phone", "Modem", "Tp-link"] as const;
export function equipmentCaptureSelection(value: { equipmentType?: unknown; equipmentUnitId?: unknown }): { equipmentType: string; equipmentUnitId: string } | undefined {
  const equipmentType = typeof value?.equipmentType === "string" ? EQUIPMENT_TYPES.find(type => type.toLowerCase() === value.equipmentType!.toString().trim().toLowerCase()) : undefined;
  const equipmentUnitId = typeof value?.equipmentUnitId === "string" ? value.equipmentUnitId.trim() : "";
  return equipmentType && /^[a-z\d][a-z\d-]{15,79}$/i.test(equipmentUnitId) ? { equipmentType, equipmentUnitId } : undefined;
}

export function canonicalEquipmentComponent(value: string): string {
  const name = String(value || "").trim();
  return /^(?:CPU\s+ADAPT(?:ER|OR)|LAPTOP\s+ADAPT(?:ER|OR)|NOTEBOOK\s+ADAPT(?:ER|OR)|(?:LAPTOP\s+|CPU\s+)?CHARGER|(?:AC\s*[/-]?\s*|POWER\s+)ADAPT(?:ER|OR)|LAD)$/i.test(name)
    ? "LAPTOP ADAPTER" : name;
}
const norm = (value: string) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
function identifier(value: string, hardwareId = ""): string {
  const token = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9/-]/g, "");
  return token.length >= 5 && token.length <= 64 && /\d/.test(token) && norm(token) !== norm(hardwareId)
    && !/^[A-Z]{1,8}[/-](?:19|20)\d{2}[/-]/.test(token) && !/^(?:MODEL|VERSION|UNKNOWN|UNREADABLE|SERIAL|NUMBER|SNID|NOTVISIBLE|NOTREADABLE)$/i.test(token)
    && (/[A-Z]/.test(token) || /^\d{7,}$/.test(token)) ? token : "";
}
export function labeledSerialValues(text: string): { manufacturer: string[]; snid: string[] } {
  const collect = (pattern: RegExp) => [...new Set(Array.from(String(text || "").matchAll(pattern), match => identifier(match[1])).filter(Boolean))];
  return {
    manufacturer: collect(/\b(?:SERIAL(?:\s*(?:NUMBER|NO\.?))?|SER\.?\s*NO\.?|S\.?[ \t]*[\/\\.-]?[ \t]*N\.?)(?![A-Z])[\s:#.,=-]*([A-Z0-9][A-Z0-9/-]{4,})\b/gi),
    snid: collect(/\bSNID\b[\s:#.,=-]*([A-Z0-9][A-Z0-9/-]{4,})\b/gi).filter(value => /^\d{7,16}$/.test(value)),
  };
}
export function hasManufacturerSerialLabel(text: string): boolean {
  return /\b(?:SERIAL(?:\s*(?:NO\.?|NUMBER))?|S\s*\/\s*N|SN)\b/i.test(text);
}
function modelIdentifierValues(text: string): string[] {
  const lines = String(text || "").split(/\r?\n/).map(line => line.trim().toUpperCase());
  const find = (pattern: RegExp) => {
    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(pattern); if (!match) continue;
      const value = (match[1] || lines[index + 1] || "").split(/\b(?:SERIAL|SNID|S\s*\/\s*N|INPUT|OUTPUT|VERSION|REVISION)\b/i)[0]
        .replace(/^[\s:#.,=-]+|[\s:#.,=-]+$/g, "").trim();
      if (value && /\d/.test(value)) return value;
    }
    return "";
  };
  const model = find(/\b(?:MODEL(?:[ \t]*(?:NUMBER|NO\.?))?|M\/N)[ \t:#.,=-]*(.*)$/i);
  // A version can be a letter, so keep the directly labeled suffix too.
  const versionMatch = lines.map(line => line.match(/\b(?:VERSION|VER\.?|REVISION|REV\.?)[ \t:#.,=-]*(.*)$/i)).find(Boolean);
  const version = versionMatch?.[1]?.split(/\b(?:SERIAL|SNID|INPUT|OUTPUT)\b/i)[0].trim() || "";
  return [model, version, model && version ? model + " " + version : ""].filter(Boolean).map(norm);
}
export function chooseLabeledSerial(text: string, current: string, hardwareId = ""): { value: string; source: "manufacturer" | "snid" | "unknown"; conflict: boolean } {
  const labels = labeledSerialValues(text);
  const original = identifier(current, hardwareId);
  const manufacturers = labels.manufacturer.filter(value => norm(value) !== norm(hardwareId));
  if (manufacturers.length) {
    return { value: manufacturers.length === 1 ? manufacturers[0] : manufacturers.find(value => norm(value) === norm(original)) || "",
      source: "manufacturer", conflict: manufacturers.length > 1 };
  }
  const snids = labels.snid.filter(value => norm(value) !== norm(hardwareId));
  if (original && !snids.some(value => norm(value) === norm(original))) return { value: original, source: "unknown", conflict: false };
  return { value: snids.length === 1 ? snids[0] : snids.find(value => norm(value) === norm(original)) || original,
    source: snids.length ? "snid" : "unknown", conflict: snids.length > 1 };
}

const useless = /^(?:NO\.?|NUMBER|MODEL|MODEL NO\.?|VERSION|UNKNOWN|UNREADABLE|N\/?A|NONE|NOT VISIBLE|NOT READABLE)$/i;
export function equipmentDescription(text: string, current: string, brands: readonly string[], identifiers: readonly string[] = []): string {
  const lines = String(text || "").split(/\r?\n/).map(line => line.trim().toUpperCase()).filter(Boolean);
  const safe = (value: string) => value.replace(/\b(?:S\s*\/\s*N|SERIAL|SNID|INPUT|OUTPUT|RATING|EAN|UPC|BARCODE)\b.*$/i, "")
    .replace(/^[\s:#.,=-]+|[\s:#.,=-]+$/g, "").replace(/\s+/g, " ").trim();
  const valid = (value: string) => value && value.length <= 100 && !useless.test(value) && !identifiers.some(id => id && norm(id) === norm(value));
  const joined = lines.join("\n");
  const brand = brands.find(value => new RegExp("\\b" + value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(joined)) || "";
  function label(pattern: RegExp): string {
    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(pattern);
      if (!match) continue;
      let value = safe(match[1] || "");
      if (!value || useless.test(value)) value = safe(lines[index + 1] || "");
      value = value.split(/\b(?:VERSION|VER\.?|REVISION|REV\.?)\b/i)[0].trim();
      if (valid(value) && !/^(?:BRAND|MANUFACTURER|MODEL|VERSION|SERIAL|SNID|INPUT|OUTPUT)\b/i.test(value)) return value;
    }
    return "";
  }
  const model = label(/\b(?:MODEL(?:[ \t]*(?:NUMBER|NO\.?))?|M\/N)[ \t:#.,=-]*(.*)$/i);
  let version = label(/\b(?:VERSION|VER\.?|REVISION|REV\.?)(?:[ \t]*(?:NUMBER|NO\.?))?[ \t:#.,=-]*(.*)$/i);
  if (model && norm(version).startsWith(norm(model)) && version.length > model.length) version = version.slice(model.length).trim();
  const existing = safe(current || "");
  let description = model ? [brand, model].filter(Boolean).join(" ") : valid(existing) ? existing : brand;
  if (brand && description && !new RegExp("\\b" + brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(description)) description = brand + " " + description;
  if (version && !description.toUpperCase().includes("VERSION " + version)) description = [description, "VERSION " + version].filter(Boolean).join(" ");
  return valid(description) ? description : "";
}

/** Read hardware fields only; never infer a company tag or manual Remarks. */
export function applyEquipmentLabelRules(record: IntakeRecord, text: string, brands: readonly string[]): IntakeRecord {
  const selected = chooseLabeledSerial(text, record.serial, record.hardwareId);
  const modelAsSerial = selected.source === "unknown" && selected.value && modelIdentifierValues(text).includes(norm(selected.value));
  const serial = modelAsSerial ? "" : selected.value;
  const existingNotes = selected.source === "manufacturer" ? (record.notes || "").replace(/SNID fallback:[^.]*\./gi, "").trim() : record.notes || "";
  const notes = [existingNotes, selected.source === "snid" && !/SNID fallback/i.test(existingNotes) ? "SNID fallback: no readable manufacturer S/N was found." : "",
    selected.source === "manufacturer" && serial && !/Manufacturer S\/N label read/i.test(existingNotes) ? "Manufacturer S/N label read." : "",
    modelAsSerial ? "A model/version token was excluded from the serial field." : "",
    selected.conflict ? "Conflicting labeled identifiers need manual review." : ""].filter(Boolean).join(" ");
  return { ...record, components: canonicalEquipmentComponent(record.components), serial,
    description: equipmentDescription(text, record.description, brands, [record.hardwareId, serial, ...labeledSerialValues(text).snid]), notes };
}

export function selectMissingFieldProbes<T extends { purpose: string; rectangle?: { left: number; top: number; width: number; height: number } }>(probes: T[], record: Pick<IntakeRecord, "hardwareId" | "description" | "serial">, brands: readonly string[] = []): T[] {
  const missing = new Set([!record.hardwareId ? "property" : "", !record.description || brands.includes(record.description.toUpperCase()) ? "label" : "", !record.serial ? "serial" : ""]);
  const selected: T[] = [];
  for (const probe of probes) {
    if (!missing.has(probe.purpose)) continue;
    if (!probe.rectangle) continue;
    const equivalent = selected.find(other => {
      const a = probe.rectangle, b = other.rectangle;
      if (!a || !b) return false;
      const overlap = Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
        Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
      return overlap / Math.max(1, a.width * a.height + b.width * b.height - overlap) > 0.9;
    });
    if (equivalent) {
      // A label snapshot participates in both property and serial parsing.
      // Keep a shared crop usable by both fields rather than dropping evidence.
      if (equivalent.purpose !== probe.purpose) equivalent.purpose = "label";
      continue;
    }
    selected.push({ ...probe });
  }
  return selected;
}
