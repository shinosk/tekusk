import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseXlsx } from '../src/lib/xlsx.mjs';
import {
  parseFiscalYear,
  parseRetailSheet,
  parseRetailWorkbook,
  normalizeRetail,
  latestChange,
  monthsAcross,
  cityOf,
} from '../src/lib/retail.mjs';
import { VEGETAN_FIXTURES_DIR, CONFIG_DIR } from '../src/lib/paths.mjs';

function fixture(suffix) {
  try {
    const files = fs.readdirSync(VEGETAN_FIXTURES_DIR);
    const hit = files.find((f) => f.endsWith(suffix));
    return hit ? fs.readFileSync(path.join(VEGETAN_FIXTURES_DIR, hit)) : null;
  } catch {
    return null;
  }
}

function loadCatalog() {
  return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'items.json'), 'utf8'));
}

// ---- fiscal-year parsing (handles fullwidth digits + 年度) -------------------

test('parseFiscalYear reads 令和/平成 年度 and western years', () => {
  assert.equal(parseFiscalYear('トマトの小売価格等の状況（令和８年度）'), 2026); // fullwidth
  assert.equal(parseFiscalYear('令和8年度'), 2026);
  assert.equal(parseFiscalYear('令和元年度'), 2019);
  assert.equal(parseFiscalYear('平成30年度'), 2018);
  assert.equal(parseFiscalYear('2026年度'), 2026);
  assert.equal(parseFiscalYear('小売価格（円/kg）'), null);
});

// ---- sheet parsing (synthetic grid; documented from fixtures) ---------------

const syntheticRetail = [
  [null, '提出様式2-2'],
  [null, 'テストの小売価格等の状況（令和８年度）'],
  [null, '小売価格（円/kg）'],
  // header row: leading unlabeled 4月 column (col2), then ５月, ６月, ...
  [null, 49, null, '５月', '６月', '７月'],
  [null, '札幌市', 400, 410, 420, null],
  [null, '東京23区', 500, 510, null, null],
  [null, '全国', 450, 460, 470, null],
  [null, '（次のブロック）'],
];

test('parseRetailSheet recovers the unlabeled 4月 column and dates by fiscal year', () => {
  const rows = parseRetailSheet(syntheticRetail);
  assert.equal(rows.length, 3); // stops at the non-city row (next block)
  const sapporo = rows.find((r) => r.cityName === '札幌市');
  assert.deepEqual(
    sapporo.series.map((p) => p.date),
    ['2026-04-01', '2026-05-01', '2026-06-01']
  );
  assert.equal(sapporo.series[0].price, 400); // the unlabeled leading column = 4月
  // Empty cells are skipped, not emitted.
  const tokyo = rows.find((r) => r.cityName === '東京23区');
  assert.equal(tokyo.series.length, 2);
});

test('parseRetailSheet honors an explicit fiscalYear override (Jan-Mar roll)', () => {
  const grid = [
    [null, 'x', null, '１月', '２月', '３月'], // fiscal months in the next calendar year
    [null, '大阪市', null, 100, 110, 120], // data aligned under the labeled columns
  ];
  // With no 4月 to the left, all three are Jan/Feb/Mar of fiscalYear+1.
  const rows = parseRetailSheet(grid, { fiscalYear: 2025 });
  assert.deepEqual(
    rows[0].series.map((p) => p.date),
    ['2026-01-01', '2026-02-01', '2026-03-01']
  );
});

// ---- real fixture parsing ---------------------------------------------------

test('parseRetailWorkbook extracts 9 cities + 全国 from the tomato fixture', (t) => {
  const buf = fixture('_kouri_cyousa_tomato.xlsx.xlsx');
  if (!buf) return t.skip('retail tomato fixture missing');
  const cfg = loadCatalog();
  const cityMap = cfg.retail.cities;
  const cities = parseRetailWorkbook(parseXlsx(buf), { sheetName: 'トマト', cityMap });

  assert.equal(cities.length, 10, '9 survey cities + 全国');
  const slugs = cities.map((c) => c.citySlug);
  assert.ok(slugs.includes('sapporo'));
  assert.ok(slugs.includes('tokyo'));
  assert.ok(slugs.includes('national'));

  const sapporo = cities.find((c) => c.citySlug === 'sapporo');
  assert.equal(sapporo.cityName, '札幌市');
  assert.equal(sapporo.series.length, 3); // Apr/May/Jun of the fiscal year
  assert.equal(sapporo.series[0].date, '2026-04-01');
  assert.equal(Math.round(sapporo.series[0].price), 708); // verified against the raw sheet
  // dates strictly ascending, month-start
  for (const c of cities) {
    for (let i = 1; i < c.series.length; i++) assert.ok(c.series[i - 1].date < c.series[i].date);
    for (const p of c.series) assert.match(p.date, /^\d{4}-\d{2}-01$/);
  }
});

test('parseRetailWorkbook picks the 白ねぎ sheet for the negi book', (t) => {
  const buf = fixture('_kouri_cyousa_negi.xlsx.xlsx');
  if (!buf) return t.skip('retail negi fixture missing');
  const wb = parseXlsx(buf);
  assert.deepEqual(wb.sheetNames, ['白ねぎ', '青ねぎ']);
  const cities = parseRetailWorkbook(wb, { sheetName: '白ねぎ', cityMap: loadCatalog().retail.cities });
  assert.ok(cities.find((c) => c.citySlug === 'sapporo').series.length >= 1);
});

// ---- end-to-end normalization across every retail item ----------------------

test('normalizeRetail yields all 15 catalog retail items with mapped city slugs', (t) => {
  const cfg = loadCatalog();
  const catalogItems = cfg.items.filter((it) => it.retailKey);
  const books = {};
  for (const it of catalogItems) {
    const buf = fixture(`_kouri_cyousa_${it.retailKey}.xlsx.xlsx`);
    if (buf) books[it.retailKey] = buf;
  }
  if (Object.keys(books).length === 0) return t.skip('retail fixtures missing');

  const { items, missing } = normalizeRetail(books, catalogItems, cfg.retail.cities);
  assert.equal(missing.length, 0, `missing: ${missing}`);
  assert.equal(items.length, 15);

  for (const it of items) {
    assert.ok(it.cities.length >= 9, `${it.slug} has ${it.cities.length} cities`);
    // Every emitted city carries a known slug (nothing silently dropped).
    for (const c of it.cities) assert.ok(c.citySlug && c.series.length);
    assert.ok(cityOf(it, 'national'), `${it.slug} keeps the 全国 aggregate`);
  }

  // Cross-tabulated shape: item × city × month is intact for tomato.
  const tomato = items.find((i) => i.slug === 'tomato');
  const sapporo = cityOf(tomato, 'sapporo');
  assert.equal(sapporo.cityName, '札幌市');
  assert.equal(sapporo.series.length, 3);
});

// ---- view helpers -----------------------------------------------------------

test('latestChange returns latest point and 前月比', () => {
  assert.equal(latestChange([]), null);
  const lc = latestChange([
    { date: '2026-05-01', price: 100 },
    { date: '2026-06-01', price: 110 },
  ]);
  assert.equal(lc.price, 110);
  assert.ok(Math.abs(lc.momPct - 10) < 1e-9);
});

test('monthsAcross returns sorted unique months, most recent last', () => {
  const months = monthsAcross([
    [{ date: '2026-04-01', price: 1 }, { date: '2026-05-01', price: 2 }],
    [{ date: '2026-05-01', price: 3 }, { date: '2026-06-01', price: 4 }],
  ]);
  assert.deepEqual(months, ['2026-04-01', '2026-05-01', '2026-06-01']);
});
