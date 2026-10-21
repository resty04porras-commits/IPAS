/** In-memory ZIP helpers used by workbook exports and embedded template logos. */
import { deflateRawSync, inflateRawSync } from "node:zlib";

export type XlsxZipEntry = {
  name: string;
  data: Buffer;
};

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function extractZipEntryBuffer(zipBuffer: Buffer, entryName: string): Buffer | null {
  let offset = 0;

  while (offset < zipBuffer.length - 30) {
    if (zipBuffer.readUInt32LE(offset) !== 0x04034b50) {
      offset += 1;
      continue;
    }

    const flags = zipBuffer.readUInt16LE(offset + 6);
    const method = zipBuffer.readUInt16LE(offset + 8);
    const compressedSize = zipBuffer.readUInt32LE(offset + 18);
    const fileNameLength = zipBuffer.readUInt16LE(offset + 26);
    const extraLength = zipBuffer.readUInt16LE(offset + 28);
    const fileNameStart = offset + 30;
    const fileNameEnd = fileNameStart + fileNameLength;
    const dataStart = fileNameEnd + extraLength;

    if (fileNameEnd > zipBuffer.length || dataStart > zipBuffer.length) return null;

    const fileName = zipBuffer.slice(fileNameStart, fileNameEnd).toString("utf8");
    if ((flags & 0x08) !== 0 || compressedSize === 0) {
      offset = dataStart;
      continue;
    }

    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zipBuffer.length) return null;

    if (fileName === entryName) {
      const compressed = zipBuffer.slice(dataStart, dataEnd);
      if (method === 0) return compressed;
      if (method === 8) return inflateRawSync(compressed);
      return null;
    }

    offset = dataEnd;
  }

  return null;
}

export function readZipEntries(zipBuffer: Buffer): XlsxZipEntry[] {
  let eocdOffset = -1;
  for (let offset = zipBuffer.length - 22; offset >= 0; offset -= 1) {
    if (zipBuffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("Invalid XLSX template: ZIP directory not found.");

  const entryCount = zipBuffer.readUInt16LE(eocdOffset + 10);
  let centralOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
  const entries: XlsxZipEntry[] = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (zipBuffer.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error("Invalid XLSX template: corrupt ZIP central directory.");
    }

    const method = zipBuffer.readUInt16LE(centralOffset + 10);
    const compressedSize = zipBuffer.readUInt32LE(centralOffset + 20);
    const fileNameLength = zipBuffer.readUInt16LE(centralOffset + 28);
    const extraLength = zipBuffer.readUInt16LE(centralOffset + 30);
    const commentLength = zipBuffer.readUInt16LE(centralOffset + 32);
    const localOffset = zipBuffer.readUInt32LE(centralOffset + 42);
    const nameStart = centralOffset + 46;
    const name = zipBuffer.slice(nameStart, nameStart + fileNameLength).toString("utf8");

    if (zipBuffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Invalid XLSX template: local ZIP header missing for ${name}.`);
    }
    const localNameLength = zipBuffer.readUInt16LE(localOffset + 26);
    const localExtraLength = zipBuffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = zipBuffer.slice(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(compressed);
    } else if (method === 8) {
      data = inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported XLSX compression method ${method} for ${name}.`);
    }

    entries.push({ name, data });
    centralOffset = nameStart + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

export function writeZipEntries(entries: XlsxZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function updateZipEntry(entries: XlsxZipEntry[], name: string, updater: (data: Buffer) => Buffer | null): XlsxZipEntry[] {
  return entries.flatMap((entry) => {
    if (entry.name !== name) return [entry];
    const updated = updater(entry.data);
    return updated === null ? [] : [{ ...entry, data: updated }];
  });
}
