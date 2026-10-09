'use strict';

const { inflateRawSync } = require('node:zlib');

const MAX_XLSX_ARCHIVE_ENTRIES = 128;
const MAX_XLSX_ENTRY_EXPANDED_BYTES = 8 * 1024 * 1024;
const MAX_XLSX_TOTAL_EXPANDED_BYTES = 32 * 1024 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

class XlsxArchiveError extends Error {
  constructor(message = 'The workbook archive is invalid or exceeds the supported expanded size.') {
    super(message);
    this.name = 'XlsxArchiveError';
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function validateExtraFields(buffer, start, length) {
  const end = start + length;
  if (end > buffer.length) throw new XlsxArchiveError();
  let cursor = start;
  while (cursor < end) {
    if (cursor + 4 > end) throw new XlsxArchiveError();
    const identifier = buffer.readUInt16LE(cursor);
    const fieldLength = buffer.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + fieldLength > end || identifier === 0x0001) throw new XlsxArchiveError();
    cursor += fieldLength;
  }
  if (cursor !== end) throw new XlsxArchiveError();
}

function inspectXlsxArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new XlsxArchiveError('Upload a valid .xlsx workbook.');
  }
  const minimumEocdOffset = Math.max(0, buffer.length - 65_557);
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= minimumEocdOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0 || eocdOffset + 22 > buffer.length) throw new XlsxArchiveError();

  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(eocdOffset + 6);
  const diskEntries = buffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryBytes = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const commentLength = buffer.readUInt16LE(eocdOffset + 20);
  if (eocdOffset + 22 + commentLength !== buffer.length
    || diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntries !== totalEntries
    || totalEntries < 1 || totalEntries > MAX_XLSX_ARCHIVE_ENTRIES
    || totalEntries === 0xffff || centralDirectoryBytes === 0xffffffff
    || centralDirectoryOffset === 0xffffffff
    || centralDirectoryOffset + centralDirectoryBytes !== eocdOffset) {
    throw new XlsxArchiveError('The workbook contains an unsupported or oversized archive.');
  }

  const archiveEntries = [];
  let cursor = centralDirectoryOffset;
  let totalExpandedBytes = 0;
  const ranges = [];
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocdOffset || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new XlsxArchiveError();
    const flags = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedBytes = buffer.readUInt32LE(cursor + 20);
    const expandedBytes = buffer.readUInt32LE(cursor + 24);
    const filenameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const fileCommentLength = buffer.readUInt16LE(cursor + 32);
    const startDisk = buffer.readUInt16LE(cursor + 34);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + filenameLength + extraLength + fileCommentLength;
    if (!filenameLength || recordEnd > eocdOffset || expandedBytes === 0xffffffff
      || compressedBytes === 0xffffffff || localOffset === 0xffffffff || startDisk !== 0) {
      throw new XlsxArchiveError('The workbook contains an unsupported archive entry.');
    }
    const filenameBytes = buffer.subarray(cursor + 46, cursor + 46 + filenameLength);
    const filename = filenameBytes.toString('utf8');
    validateExtraFields(buffer, cursor + 46 + filenameLength, extraLength);
    if (!filename || filename.startsWith('/') || filename.includes('\\') || filename.includes('\0')
      || filename.split('/').includes('..')) throw new XlsxArchiveError();
    if ((flags & ~0x080e) !== 0 || (compressionMethod !== 0 && compressionMethod !== 8)
      || ((flags & 0x0006) !== 0 && compressionMethod !== 8)) {
      throw new XlsxArchiveError('The workbook uses an unsupported or encrypted archive entry.');
    }
    if (expandedBytes > MAX_XLSX_ENTRY_EXPANDED_BYTES
      || totalExpandedBytes + expandedBytes > MAX_XLSX_TOTAL_EXPANDED_BYTES) {
      throw new XlsxArchiveError('The workbook expands beyond the 8 MiB per-entry or 32 MiB total limit.');
    }
    if (compressionMethod === 0 && compressedBytes !== expandedBytes) throw new XlsxArchiveError();

    const localHeaderEnd = localOffset + 30;
    if (localHeaderEnd > centralDirectoryOffset || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new XlsxArchiveError();
    }
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc = buffer.readUInt32LE(localOffset + 14);
    const localCompressedBytes = buffer.readUInt32LE(localOffset + 18);
    const localExpandedBytes = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localHeaderEnd + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedBytes;
    if (localFlags !== flags || localMethod !== compressionMethod || dataStart > centralDirectoryOffset
      || dataEnd > centralDirectoryOffset || localNameLength !== filenameLength
      || !buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(filenameBytes)) {
      throw new XlsxArchiveError();
    }
    validateExtraFields(buffer, localHeaderEnd + localNameLength, localExtraLength);
    const hasDataDescriptor = (flags & 0x0008) !== 0;
    let descriptorBytes = 0;
    if (hasDataDescriptor) {
      if ((localCrc !== 0 && localCrc !== expectedCrc)
        || (localCompressedBytes !== 0 && localCompressedBytes !== compressedBytes)
        || (localExpandedBytes !== 0 && localExpandedBytes !== expandedBytes)) throw new XlsxArchiveError();
    } else if (localCrc !== expectedCrc || localCompressedBytes !== compressedBytes || localExpandedBytes !== expandedBytes) {
      throw new XlsxArchiveError();
    }

    let expanded;
    try {
      const compressed = buffer.subarray(dataStart, dataEnd);
      expanded = compressionMethod === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: MAX_XLSX_ENTRY_EXPANDED_BYTES });
    } catch {
      throw new XlsxArchiveError('The workbook contains an invalid or oversized archive entry.');
    }
    if (expanded.length !== expandedBytes || crc32(expanded) !== expectedCrc) throw new XlsxArchiveError();
    if (hasDataDescriptor) {
      const hasSignature = dataEnd + 4 <= centralDirectoryOffset && buffer.readUInt32LE(dataEnd) === DATA_DESCRIPTOR_SIGNATURE;
      const descriptorStart = dataEnd + (hasSignature ? 4 : 0);
      descriptorBytes = hasSignature ? 16 : 12;
      if (descriptorStart + 12 > centralDirectoryOffset
        || buffer.readUInt32LE(descriptorStart) !== expectedCrc
        || buffer.readUInt32LE(descriptorStart + 4) !== compressedBytes
        || buffer.readUInt32LE(descriptorStart + 8) !== expandedBytes) throw new XlsxArchiveError();
    }

    const localRecordEnd = dataEnd + descriptorBytes;
    if (ranges.some(([start, end]) => localOffset < end && localRecordEnd > start)) throw new XlsxArchiveError();
    ranges.push([localOffset, localRecordEnd]);
    totalExpandedBytes += expandedBytes;
    archiveEntries.push({ filename, compressedBytes, expandedBytes });
    cursor = recordEnd;
  }
  if (cursor !== centralDirectoryOffset + centralDirectoryBytes) throw new XlsxArchiveError();
  return { entryCount: totalEntries, totalExpandedBytes, entries: archiveEntries };
}

module.exports = {
  MAX_XLSX_ARCHIVE_ENTRIES,
  MAX_XLSX_ENTRY_EXPANDED_BYTES,
  MAX_XLSX_TOTAL_EXPANDED_BYTES,
  XlsxArchiveError,
  inspectXlsxArchive
};
