import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseXlsx, sheetNames, colRefToIndex, readZipEntries, readZipFile } from '../src/lib/xlsx.mjs';
import { VEGETAN_FIXTURES_DIR } from '../src/lib/paths.mjs';

function fixtureFiles() {
  try {
    return fs
      .readdirSync(VEGETAN_FIXTURES_DIR)
      .filter((f) => f.endsWith('.xlsx'))
      .map((f) => path.join(VEGETAN_FIXTURES_DIR, f));
  } catch {
    return [];
  }
}

function fixture(suffix) {
  const hit = fixtureFiles().find((f) => f.endsWith(suffix));
  return hit ? fs.readFileSync(hit) : null;
}

test('colRefToIndex maps A/Z/AA/AB correctly', () => {
  assert.equal(colRefToIndex('A'), 0);
  assert.equal(colRefToIndex('Z'), 25);
  assert.equal(colRefToIndex('AA'), 26);
  assert.equal(colRefToIndex('AB'), 27);
  assert.equal(colRefToIndex('A1'), 0); // full cell ref tolerated
});

test('parseXlsx rejects non-ZIP input', () => {
  assert.throws(() => parseXlsx(Buffer.from('this is not a zip file, padded to be long enough for the EOCD scan')), /ZIP/);
});

// Round-trip: every committed .xlsx fixture must parse via the central
// directory, expose sheet names, and yield non-empty grids.
test('all committed xlsx fixtures round-trip through the parser', (t) => {
  const files = fixtureFiles();
  if (files.length === 0) {
    t.skip('no xlsx fixtures in data/raw-samples/files/ (probe not run)');
    return;
  }
  for (const f of files) {
    const buf = fs.readFileSync(f);
    const wb = parseXlsx(buf);
    assert.ok(wb.sheetNames.length >= 1, `${path.basename(f)}: has sheets`);
    let cells = 0;
    for (const name of wb.sheetNames) {
      const grid = wb.sheet(name);
      assert.ok(Array.isArray(grid), `${path.basename(f)}/${name}: grid is array`);
      for (const row of grid) for (const c of row || []) if (c != null) cells++;
    }
    assert.ok(cells > 0, `${path.basename(f)}: contains at least one non-empty cell`);
  }
});

test('ZIP central directory drives entry extraction (workbook.xml present)', (t) => {
  const buf = fixture('_wp-content_uploads_tomato.xlsx.xlsx');
  if (!buf) {
    t.skip('tomato monthly fixture missing');
    return;
  }
  const entries = readZipEntries(buf);
  assert.ok(entries.has('xl/workbook.xml'), 'central directory lists xl/workbook.xml');
  const xml = readZipFile(buf, entries.get('xl/workbook.xml')).toString('utf8');
  assert.match(xml, /<workbook/);
});

test('daily book exposes item sheet names with shared strings decoded', (t) => {
  const buf = fixture('_kakakugurafu_kasai.xlsx.xlsx');
  if (!buf) {
    t.skip('kasai daily fixture missing');
    return;
  }
  const names = sheetNames(buf);
  assert.ok(names.includes('トマト'), `expected トマト in ${names}`);
  assert.ok(names.includes('きゅうり'));
});

test('parses known cell values from the tomato monthly fixture', (t) => {
  const buf = fixture('_wp-content_uploads_tomato.xlsx.xlsx');
  if (!buf) {
    t.skip('tomato monthly fixture missing');
    return;
  }
  const wb = parseXlsx(buf);
  const grid = wb.sheet('Sheet１');
  // Row 1 col 1: item name; row 3 ("1月") first data col: 744 (2005-01).
  assert.match(String(grid[1][1]), /トマト/);
  assert.match(String(grid[3][1]), /^1月/);
  assert.equal(grid[3][2], 744);
});

test('unknown sheet name throws a clear error', (t) => {
  const buf = fixture('_wp-content_uploads_tomato.xlsx.xlsx');
  if (!buf) {
    t.skip('tomato monthly fixture missing');
    return;
  }
  const wb = parseXlsx(buf);
  assert.throws(() => wb.sheet('存在しないシート'), /no such sheet/);
});
