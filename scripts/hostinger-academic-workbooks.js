'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const readExcelFile = require('read-excel-file/node').default;
const { parseWorkbookRows, validateWorkbookContext } = require('../src/services/gradeImportService');

const TEMPLATE_PATH = path.join(__dirname, '../tests/fixtures/grade-import/corrected-mini.xlsx');
const INITIAL_STRINGS = [
  'Input Data Sheet for Electronic-Class Record (ECR)', '2026', '2026_v1.0', 'LRN', 'FINAL GRADES',
  'Strengthened Senior High School Class Record', '2026–2027', 'FIRST TERM', 'SECOND TERM', 'THIRD TERM'
];
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readZipEntries(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('Workbook template is not a readable ZIP package.');
  const entryCount = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Workbook template has an invalid ZIP directory.');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Workbook template has an invalid ZIP entry.');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? Buffer.from(compressed)
      : method === 8 ? zlib.inflateRawSync(compressed)
        : null;
    if (!data) throw new Error('Workbook template uses an unsupported ZIP compression method.');
    entries.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function writeZipEntries(entries) {
  const localRecords = [];
  const directoryRecords = [];
  let localOffset = 0;
  for (const [name, rawValue] of entries) {
    const filename = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(rawValue) ? rawValue : Buffer.from(rawValue, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x5021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    filename.copy(local, 30);
    localRecords.push(local, data);

    const directory = Buffer.alloc(46 + filename.length);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0x5021, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE(0, 38);
    directory.writeUInt32LE(localOffset, 42);
    filename.copy(directory, 46);
    directoryRecords.push(directory);
    localOffset += local.length + data.length;
  }
  const directoryOffset = localOffset;
  const directoryBytes = Buffer.concat(directoryRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(directoryRecords.length, 8);
  end.writeUInt16LE(directoryRecords.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(directoryOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localRecords, directoryBytes, end]);
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function sharedStringsXml(values) {
  const items = values.map((value) => `<si><t xml:space="preserve">${xmlEscape(value)}</t></si>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${values.length}" uniqueCount="${values.length}">${items}</sst>`;
}

function stringCell(reference, index) {
  return `<c r="${reference}" t="s"><v>${index}</v></c>`;
}

function numberCell(reference, value) {
  const number = Number(value);
  return `<c r="${reference}"><f>${number}</f><v>${number}</v></c>`;
}

function worksheetXml(rows) {
  const grouped = new Map();
  for (const { number, cells } of rows) grouped.set(number, [...(grouped.get(number) || []), ...cells]);
  const xmlRows = [...grouped.entries()].sort(([left], [right]) => left - right)
    .map(([number, cells]) => `<row r="${number}">${cells.join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xmlRows}</sheetData></worksheet>`;
}

function cleanCellName(name) {
  return String(name).normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
}

function buildWorkbook({ gradeLevel, sectionName, subjectName, students }) {
  if (!Array.isArray(students) || students.length !== 30) throw new Error('Each class workbook must contain exactly 30 students.');
  const values = [...INITIAL_STRINGS, String(gradeLevel), sectionName, subjectName];
  const indexByValue = new Map(values.map((value, index) => [value, index]));
  const addString = (value) => {
    const text = String(value);
    if (!indexByValue.has(text)) {
      indexByValue.set(text, values.length);
      values.push(text);
    }
    return indexByValue.get(text);
  };
  const inputRows = [
    { number: 3, cells: [stringCell('D3', 0)] },
    { number: 10, cells: [stringCell('N10', 3), stringCell('R10', 3)] },
    { number: 16, cells: [stringCell('F16', 1)] },
    { number: 64, cells: [stringCell('T64', 2)] }
  ];
  const finalRows = [
    { number: 2, cells: [stringCell('B2', 4)] },
    { number: 3, cells: [stringCell('B3', 5)] },
    { number: 6, cells: [stringCell('I6', 6)] },
    { number: 9, cells: [`<c r="D9"><v>${Number(String(gradeLevel).match(/\d+$/)?.[0])}</v></c>`, stringCell('G9', addString(subjectName))] },
    { number: 10, cells: [stringCell('D10', addString(sectionName))] },
    { number: 15, cells: [stringCell('E15', 7), stringCell('F15', 8), stringCell('G15', 9)] }
  ];
  students.forEach((student, index) => {
    const inputRow = index + 11;
    const finalRow = index + 17;
    const lrnIndex = addString(student.lrn);
    const nameIndex = addString(`${student.firstName} ${student.lastName}`);
    inputRows.push({ number: inputRow, cells: [stringCell(`N${inputRow}`, lrnIndex), stringCell(`O${inputRow}`, nameIndex)] });
    const grades = student.grades;
    finalRows.push({
      number: finalRow,
      cells: [stringCell(`C${finalRow}`, lrnIndex), stringCell(`D${finalRow}`, nameIndex),
        numberCell(`E${finalRow}`, grades[0]), numberCell(`F${finalRow}`, grades[1]),
        numberCell(`G${finalRow}`, grades[2]), numberCell(`H${finalRow}`, grades[3])]
    });
  });
  const entries = readZipEntries(fs.readFileSync(TEMPLATE_PATH));
  entries.set('xl/sharedStrings.xml', sharedStringsXml(values));
  entries.set('xl/worksheets/sheet2.xml', worksheetXml(inputRows.sort((a, b) => a.number - b.number)));
  entries.set('xl/worksheets/sheet6.xml', worksheetXml(finalRows.sort((a, b) => a.number - b.number)));
  const buffer = writeZipEntries(entries);
  const filename = `SSHS-2026-2027-Term-2-${cleanCellName(sectionName)}-${cleanCellName(subjectName)}.xlsx`;
  return { filename, buffer };
}

async function parseWorkbook(buffer) {
  const workbook = await readExcelFile(buffer);
  const byName = new Map(workbook.map(({ sheet, data }) => [sheet, data]));
  const input = byName.get('INPUT DATA');
  const finalGrades = byName.get('FINAL GRADES');
  if (!input || !finalGrades || workbook.length !== 7) throw new Error('Generated workbook is missing a corrected SSHS sheet.');
  return { context: validateWorkbookContext(input, finalGrades), rows: parseWorkbookRows(input, finalGrades) };
}

module.exports = { buildWorkbook, parseWorkbook, readZipEntries, writeZipEntries, cleanCellName };
