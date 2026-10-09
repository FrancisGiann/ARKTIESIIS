'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deflateRawSync, inflateRawSync } = require('node:zlib');
const readExcelFile = require('read-excel-file/node').default;
const {
  MAX_XLSX_ARCHIVE_ENTRIES,
  MAX_XLSX_ENTRY_EXPANDED_BYTES,
  MAX_XLSX_TOTAL_EXPANDED_BYTES,
  XlsxArchiveError,
  inspectXlsxArchive
} = require('../src/utils/inspectXlsxArchive');
const { GradeImportError, createGradeImportService } = require('../src/services/gradeImportService');

const FIXTURE = path.join(__dirname, 'fixtures/grade-import/corrected-mini.xlsx');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extractEntries(buffer) {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  assert.notEqual(eocd, -1);
  const count = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const filenameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + filenameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.push({ name, data: method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed) });
    cursor += 46 + filenameLength + extraLength + commentLength;
  }
  return entries;
}

function makeZip(entries, { method = 8, descriptor = false, descriptorSignature = true, extraFields = new Map() } = {}) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;
  let centralSize = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const expanded = Buffer.from(entry.data);
    const compressed = method === 0 ? expanded : deflateRawSync(expanded);
    const checksum = crc32(expanded);
    const flags = descriptor ? 0x0008 : 0;
    const extra = extraFields.get(entry.name) || Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(descriptor ? 0 : checksum, 14);
    local.writeUInt32LE(descriptor ? 0 : compressed.length, 18);
    local.writeUInt32LE(descriptor ? 0 : expanded.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const dataDescriptor = descriptor
      ? (() => {
        const result = Buffer.alloc(descriptorSignature ? 16 : 12);
        let offset = 0;
        if (descriptorSignature) { result.writeUInt32LE(0x08074b50, offset); offset += 4; }
        result.writeUInt32LE(checksum, offset);
        result.writeUInt32LE(compressed.length, offset + 4);
        result.writeUInt32LE(expanded.length, offset + 8);
        return result;
      })()
      : Buffer.alloc(0);
    const localRecord = Buffer.concat([local, name, extra, compressed, dataDescriptor]);
    localRecords.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(expanded.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(localOffset, 42);
    const centralRecord = Buffer.concat([central, name, extra]);
    centralRecords.push(centralRecord);
    localOffset += localRecord.length;
    centralSize += centralRecord.length;
  }
  const centralOffset = localOffset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localRecords, ...centralRecords, end]);
}

function corruptUncompressedSize(buffer, value) {
  const copy = Buffer.from(buffer);
  let eocd = -1;
  for (let offset = copy.length - 22; offset >= Math.max(0, copy.length - 65_557); offset -= 1) {
    if (copy.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  const centralOffset = copy.readUInt32LE(eocd + 16);
  const localOffset = copy.readUInt32LE(centralOffset + 42);
  copy.writeUInt32LE(value, centralOffset + 24);
  copy.writeUInt32LE(value, localOffset + 22);
  return copy;
}

function mutateFirstEntry(buffer, { centralOffset: centralField, localOffset: localField, value }) {
  const copy = Buffer.from(buffer);
  let eocd = -1;
  for (let offset = copy.length - 22; offset >= Math.max(0, copy.length - 65_557); offset -= 1) {
    if (copy.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  const central = copy.readUInt32LE(eocd + 16);
  const local = copy.readUInt32LE(central + 42);
  if (centralField !== undefined) copy.writeUInt16LE(value, central + centralField);
  if (localField !== undefined) copy.writeUInt16LE(value, local + localField);
  return copy;
}

async function assertRejectedBeforeWorkbookReader(buffer, parserInvocations, service) {
  await assert.rejects(service.createPreview({
    actorId: 7, sessionId: 'test-session', buffer, contextKey: 'unused', originalFilename: 'unsafe.xlsx'
  }), (error) => error instanceof GradeImportError && /archive|expands|oversized|unsupported|valid \.xlsx/i.test(error.message));
  assert.equal(parserInvocations.count, 0, 'invalid or oversized archives are rejected before read-excel-file runs');
}

test('ZIP bounds preserve corrected workbook parsing with stored, deflated, and data-descriptor entries', async () => {
  const fixtureEntries = extractEntries(fs.readFileSync(FIXTURE));
  for (const options of [
    { method: 0 },
    { method: 8 },
    { method: 0, descriptor: true, descriptorSignature: true },
    { method: 8, descriptor: true, descriptorSignature: true }
  ]) {
    const archive = makeZip(fixtureEntries, options);
    const bounds = inspectXlsxArchive(archive);
    assert.equal(bounds.entryCount, fixtureEntries.length);
    assert.ok(bounds.totalExpandedBytes < MAX_XLSX_TOTAL_EXPANDED_BYTES);
    let workbook;
    try { workbook = await readExcelFile(archive); }
    catch (error) { error.message += ` (${JSON.stringify(options)})`; throw error; }
    assert.deepEqual(workbook.map(({ sheet }) => sheet), [
      'INSTRUCTIONS', 'INPUT DATA', 'Term 1', 'Term 2', 'Term 3', 'FINAL GRADES', 'HELPER'
    ]);
  }
  const unsignedDescriptorArchive = makeZip(fixtureEntries, {
    method: 8, descriptor: true, descriptorSignature: false
  });
  const unsignedDescriptorBounds = inspectXlsxArchive(unsignedDescriptorArchive);
  assert.equal(unsignedDescriptorBounds.entryCount, fixtureEntries.length,
    'the bounded preflight accepts ZIP data descriptors with or without their optional signature');
  assert.ok(inspectXlsxArchive(fs.readFileSync(FIXTURE)).totalExpandedBytes > 0);
});

test('malformed and resource-heavy XLSX archives are rejected before the workbook parser', async () => {
  const parserInvocations = { count: 0 };
  const service = createGradeImportService({
    workbookReader: async () => { parserInvocations.count += 1; return []; },
    getPool: async () => { throw new Error('pool must not be requested during archive validation'); }
  });
  const tiny = [{ name: 'xl/worksheets/sheet1.xml', data: Buffer.from('<worksheet/>') }];
  const normal = makeZip(tiny);
  const tooLargeEntry = makeZip([{
    name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(MAX_XLSX_ENTRY_EXPANDED_BYTES + 1, 0x41)
  }]);
  const falseSmallExpandedSize = corruptUncompressedSize(tooLargeEntry, MAX_XLSX_ENTRY_EXPANDED_BYTES);
  const totalExpansion = makeZip(Array.from({ length: 5 }, (_, index) => ({
    name: `xl/worksheets/sheet${index + 1}.xml`, data: Buffer.alloc(7 * 1024 * 1024, index)
  })));
  const tooManyEntries = makeZip(Array.from({ length: MAX_XLSX_ARCHIVE_ENTRIES + 1 }, (_, index) => ({
    name: `empty/${index}.xml`, data: Buffer.alloc(0)
  })), { method: 0 });
  const encrypted = mutateFirstEntry(normal, { centralOffset: 8, localOffset: 6, value: 0x0001 });
  const unsupportedCompression = mutateFirstEntry(normal, { centralOffset: 10, localOffset: 8, value: 12 });
  const zip64Extra = makeZip(tiny, {
    extraFields: new Map([['xl/worksheets/sheet1.xml', Buffer.from([1, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0])]])
  });
  const falseMetadata = corruptUncompressedSize(normal, 1);
  const truncated = normal.subarray(0, normal.length - 5);

  assert.ok(totalExpansion.length < 5 * 1024 * 1024, 'the high-ratio fixture stays small on disk');
  for (const archive of [
    Buffer.from('not a zip archive'), tooLargeEntry, falseSmallExpandedSize, totalExpansion, tooManyEntries,
    encrypted, unsupportedCompression, zip64Extra, falseMetadata, truncated
  ]) {
    await assertRejectedBeforeWorkbookReader(archive, parserInvocations, service);
  }
  assert.equal(MAX_XLSX_ENTRY_EXPANDED_BYTES, 8 * 1024 * 1024);
  assert.equal(MAX_XLSX_TOTAL_EXPANDED_BYTES, 32 * 1024 * 1024);
});
