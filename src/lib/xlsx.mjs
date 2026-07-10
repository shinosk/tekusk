// Dependency-free .xlsx reader. An .xlsx file is a ZIP archive of XML parts;
// this module unzips the entries we need with node:zlib (inflateRawSync) and
// does a minimal, tolerant parse of:
//   * xl/workbook.xml            (sheet name -> sheetId / r:id)
//   * xl/_rels/workbook.xml.rels (r:id -> worksheet part path)
//   * xl/sharedStrings.xml       (shared string table)
//   * xl/worksheets/sheet*.xml   (cell grid)
//
// Design notes:
//   * ZIP parsing is driven by the CENTRAL DIRECTORY (authoritative), not by
//     scanning local file headers. We read the End-Of-Central-Directory
//     record, walk each central-directory entry, then seek to each entry's
//     local header only to skip past its (possibly different) name/extra
//     fields to the compressed bytes.
//   * Only STORE (0) and DEFLATE (8) compression are supported — the two
//     methods Excel/LibreOffice actually emit. inflateRawSync handles the
//     raw DEFLATE stream stored in ZIP entries.
//   * Zero external dependencies; only node:zlib.

import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50; // End of central directory
const SIG_EOCD64 = 0x06064b50; // Zip64 EOCD (tolerated, not required here)
const SIG_CEN = 0x02014b50; // Central directory file header
const SIG_LOC = 0x04034b50; // Local file header

// ---- ZIP: central-directory-driven entry table --------------------------

function findEocd(buf) {
  // EOCD is at the end, before an optional comment (<= 0xffff bytes). Scan
  // backwards for its signature.
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error('xlsx: not a ZIP (no End-Of-Central-Directory record found)');
}

// Returns a Map<entryName, {method, compSize, uncompSize, localHeaderOffset}>
export function readZipEntries(buf) {
  const eocd = findEocd(buf);
  let cdCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // Minimal Zip64 support: if the 32-bit fields are saturated, read the
  // Zip64 EOCD locator/record for the real values. (Our fixtures don't need
  // this, but it keeps the parser honest for larger books.)
  if (cdOffset === 0xffffffff || cdCount === 0xffff) {
    const locPos = eocd - 20;
    if (locPos >= 0 && buf.readUInt32LE(locPos) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(locPos + 8));
      if (buf.readUInt32LE(z64) === SIG_EOCD64) {
        cdCount = Number(buf.readBigUInt64LE(z64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(p) !== SIG_CEN) {
      throw new Error(`xlsx: bad central directory entry #${i} at ${p}`);
    }
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // Handle a Zip64 extra field for saturated sizes/offset.
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      const extraStart = p + 46 + nameLen;
      let ep = extraStart;
      const extraEnd = extraStart + extraLen;
      while (ep + 4 <= extraEnd) {
        const tag = buf.readUInt16LE(ep);
        const size = buf.readUInt16LE(ep + 2);
        let fp = ep + 4;
        if (tag === 0x0001) {
          if (uncompSize === 0xffffffff) { uncompSize = Number(buf.readBigUInt64LE(fp)); fp += 8; }
          if (compSize === 0xffffffff) { compSize = Number(buf.readBigUInt64LE(fp)); fp += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(buf.readBigUInt64LE(fp)); fp += 8; }
        }
        ep += 4 + size;
      }
    }

    entries.set(name, { method, compSize, uncompSize, localHeaderOffset: localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Extract and decompress a single entry to a Buffer.
export function readZipFile(buf, entry) {
  if (buf.readUInt32LE(entry.localHeaderOffset) !== SIG_LOC) {
    throw new Error('xlsx: bad local file header');
  }
  const nameLen = buf.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return Buffer.from(data); // stored
  if (entry.method === 8) return inflateRawSync(data); // deflate
  throw new Error(`xlsx: unsupported ZIP compression method ${entry.method}`);
}

function readEntryText(buf, entries, name) {
  const entry = entries.get(name);
  if (!entry) return null;
  return readZipFile(buf, entry).toString('utf8');
}

// ---- XML helpers (tolerant, regex-based; these parts are machine-emitted) --

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // last, so "&amp;lt;" survives correctly
}

// Concatenate the text of all <t>…</t> nodes inside a shared-string <si>.
// Excel splits styled runs across multiple <r><t> nodes; joining yields the
// full logical string. Honors xml:space by simply keeping the raw text.
function siText(siXml) {
  let out = '';
  const re = /<t[^>]*>([\s\S]*?)<\/t>|<t[^>]*\/>/g;
  let m;
  while ((m = re.exec(siXml))) {
    if (m[1] != null) out += decodeXmlEntities(m[1]);
  }
  return out;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    strings.push(m[1] != null ? siText(m[1]) : '');
  }
  return strings;
}

// column reference letters ("A", "AB") -> zero-based column index
export function colRefToIndex(ref) {
  const letters = String(ref).match(/^[A-Z]+/i);
  if (!letters) return 0;
  let n = 0;
  const up = letters[0].toUpperCase();
  for (let i = 0; i < up.length; i++) n = n * 26 + (up.charCodeAt(i) - 64);
  return n - 1;
}

// Parse a worksheet XML part into a dense 2D array. Cells are strings or
// numbers; empty/absent cells are null. Row/col positions come from each
// cell's r="A1" reference so gaps are preserved.
function parseSheet(xml, sharedStrings) {
  const grid = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g;
  let rowM;
  let autoRow = 0;
  while ((rowM = rowRe.exec(xml))) {
    autoRow += 1;
    const attrs = rowM[1] || rowM[3] || '';
    const rMatch = attrs.match(/\br="(\d+)"/);
    const rowIndex = rMatch ? parseInt(rMatch[1], 10) - 1 : autoRow - 1;
    const inner = rowM[2] || '';
    const cells = [];
    let autoCol = 0;
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cm;
    while ((cm = cellRe.exec(inner))) {
      const cAttrs = cm[1] || cm[3] || '';
      const body = cm[2] || '';
      const refM = cAttrs.match(/\br="([A-Z]+)\d+"/i);
      const colIndex = refM ? colRefToIndex(refM[1]) : autoCol;
      autoCol = colIndex + 1;
      const typeM = cAttrs.match(/\bt="([^"]+)"/);
      const type = typeM ? typeM[1] : 'n';
      let value = null;
      if (type === 'inlineStr') {
        value = siText(body);
      } else {
        const vM = body.match(/<v[^>]*>([\s\S]*?)<\/v>/);
        if (vM) {
          const raw = decodeXmlEntities(vM[1]);
          if (type === 's') {
            const idx = parseInt(raw, 10);
            value = sharedStrings[idx] != null ? sharedStrings[idx] : '';
          } else if (type === 'str' || type === 'e') {
            value = raw;
          } else {
            const num = Number(raw);
            value = Number.isFinite(num) ? num : raw;
          }
        }
      }
      cells[colIndex] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = null;
    grid[rowIndex] = cells;
  }
  for (let i = 0; i < grid.length; i++) if (grid[i] === undefined) grid[i] = [];
  return grid;
}

// Map sheet display names -> worksheet part path via workbook.xml + rels.
function sheetPartMap(buf, entries) {
  const wbXml = readEntryText(buf, entries, 'xl/workbook.xml') || '';
  const relsXml = readEntryText(buf, entries, 'xl/_rels/workbook.xml.rels') || '';

  const relTarget = new Map(); // rId -> target path (normalized under xl/)
  const relRe = /<Relationship\b([^>]*)\/>|<Relationship\b([^>]*)>[\s\S]*?<\/Relationship>/g;
  let rm;
  while ((rm = relRe.exec(relsXml))) {
    const a = rm[1] || rm[2] || '';
    const id = (a.match(/\bId="([^"]+)"/) || [])[1];
    let target = (a.match(/\bTarget="([^"]+)"/) || [])[1];
    if (!id || !target) continue;
    if (!target.startsWith('/')) {
      target = target.replace(/^\.\//, '');
      target = target.startsWith('xl/') ? target : `xl/${target}`;
    } else {
      target = target.replace(/^\//, '');
    }
    relTarget.set(id, target);
  }

  const sheets = []; // { name, path }
  const sheetRe = /<sheet\b([^>]*)\/>|<sheet\b([^>]*)>[\s\S]*?<\/sheet>/g;
  let sm;
  let fallbackSeq = 0;
  while ((sm = sheetRe.exec(wbXml))) {
    fallbackSeq += 1;
    const a = sm[1] || sm[2] || '';
    const name = decodeXmlEntities((a.match(/\bname="([^"]*)"/) || [])[1] || `Sheet${fallbackSeq}`);
    const rid = (a.match(/r:id="([^"]+)"/) || a.match(/\bid="([^"]+)"/) || [])[1];
    let partPath = rid ? relTarget.get(rid) : null;
    if (!partPath) partPath = `xl/worksheets/sheet${fallbackSeq}.xml`;
    sheets.push({ name, path: partPath });
  }
  return sheets;
}

// ---- Public API ----------------------------------------------------------

// Parse an .xlsx Buffer into a workbook object with lazy per-sheet grids.
export function parseXlsx(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const entries = readZipEntries(buf);
  const sharedStrings = parseSharedStrings(readEntryText(buf, entries, 'xl/sharedStrings.xml'));
  const sheetDefs = sheetPartMap(buf, entries);

  const cache = new Map();
  const getRows = (name) => {
    if (cache.has(name)) return cache.get(name);
    const def = sheetDefs.find((s) => s.name === name);
    if (!def) throw new Error(`xlsx: no such sheet "${name}"`);
    const xml = readEntryText(buf, entries, def.path);
    if (xml == null) throw new Error(`xlsx: worksheet part missing: ${def.path}`);
    const grid = parseSheet(xml, sharedStrings);
    cache.set(name, grid);
    return grid;
  };

  return {
    sheetNames: sheetDefs.map((s) => s.name),
    sheet: getRows, // (name) -> 2D array
  };
}

// Convenience: list sheet names without materializing any grid.
export function sheetNames(buf) {
  return parseXlsx(buf).sheetNames;
}
