import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseXlsx } from '../src/lib/xlsx.mjs';
import { parseDailySheet, parseMonthlyWorkbook, normalizeVegetan } from '../src/lib/vegetan.mjs';
import { mergeByDate } from '../src/lib/normalize.mjs';
import { computeItemStats, BUY_RATIO_THRESHOLD } from '../src/lib/stats.mjs';
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

// ---- daily parsing (synthetic grid; format documented from fixtures) ------

const syntheticDaily = [
  ['　1．「テスト」の卸売数量と価格の推移', '(8.6/1～)'],
  ['　　（東京都中央卸売市場）'],
  [],
  // date row: Excel serial for 2026-06-29 anchor, labels cross into July
  [46202, '6/29', '30', '7/2', '3'],
  ['入荷量ニュウカ', 100, 110, null, 130],
  ['卸売価格オロシウリ', 200, 210, '#N/A', 230],
  ['平均価格ヘイキン', 220, 220, 220, 220],
  ['平年比ヘイネンヒ', 0.909, 0.954, null, 1.045],
];

test('parseDailySheet reads the first block, skips #N/A, rolls months', () => {
  const pts = parseDailySheet(syntheticDaily);
  assert.equal(pts.length, 3); // the "#N/A" day is dropped
  assert.deepEqual(pts.map((p) => p.date), ['2026-06-29', '2026-06-30', '2026-07-03']);
  assert.equal(pts[0].price, 200);
  assert.equal(pts[0].arrival, 100);
  assert.equal(pts[0].normalPrice, 220);
  assert.equal(pts[0].normalRatio, 0.909);
  assert.equal(pts[2].price, 230);
});

test('parseDailySheet returns [] for a grid without a date row', () => {
  assert.deepEqual(parseDailySheet([['タイトルだけ'], []]), []);
});

test('parseDailySheet rolls the year across a Dec->Jan wrap', () => {
  const dec = [
    [46357, '12/30', '31', '1/2'], // 46357 = 2026-12-01 anchor
    ['入荷量', 1, 1, 1],
    ['卸売価格', 10, 11, 12],
    ['平均価格', 10, 10, 10],
    ['平年比', 1, 1.1, 1.2],
  ];
  const pts = parseDailySheet(dec);
  assert.deepEqual(pts.map((p) => p.date), ['2026-12-30', '2026-12-31', '2027-01-02']);
});

// ---- daily parsing (real fixture) ------------------------------------------

test('parseDailySheet extracts the Tokyo block from the kasai fixture (トマト)', (t) => {
  const buf = fixture('_kakakugurafu_kasai.xlsx.xlsx');
  if (!buf) return t.skip('kasai fixture missing');
  const wb = parseXlsx(buf);
  const grid = wb.sheet('トマト');
  // The first block's title names the Tokyo market — that is the one we take.
  assert.match(String(grid[1][0]), /東京都中央卸売市場/);
  const pts = parseDailySheet(grid);
  assert.ok(pts.length >= 20, `expected >=20 days, got ${pts.length}`);
  const first = pts[0];
  assert.equal(first.date, '2026-06-01');
  assert.equal(first.price, 390); // verified against the raw sheet
  assert.equal(first.normalPrice, 317);
  assert.ok(Math.abs(first.normalRatio - 390 / 317) < 1e-9);
  // Labels cross from June into July within one row.
  assert.ok(pts.some((p) => p.date.startsWith('2026-07-')));
});

// ---- monthly parsing --------------------------------------------------------

test('parseMonthlyWorkbook maps wareki/western year columns and skips 平年値', (t) => {
  const buf = fixture('_wp-content_uploads_tomato.xlsx.xlsx');
  if (!buf) return t.skip('tomato monthly fixture missing');
  const m = parseMonthlyWorkbook(parseXlsx(buf));
  assert.ok(m.length >= 240, `expected >=240 points, got ${m.length}`);
  const byDate = new Map(m.map((p) => [p.date, p.price]));
  assert.equal(byDate.get('2005-01-01'), 744); // unlabeled leading column
  assert.equal(byDate.get('2006-01-01'), 640); // 平成18年
  assert.equal(byDate.get('2008-01-01'), 685); // 2008年 (western)
  assert.equal(byDate.get('2025-01-01'), 1022);
  assert.ok(!m.some((p) => Number(p.date.slice(0, 4)) > 2100), 'no bogus years');
  // strictly ascending, unique dates
  for (let i = 1; i < m.length; i++) assert.ok(m[i - 1].date < m[i].date);
});

// ---- end-to-end normalization ------------------------------------------------

async function loadVegCatalog() {
  const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'items.json'), 'utf8'));
  return cfg.items.filter((it) => it.source === 'vegetan');
}

test('normalizeVegetan yields all 19 catalog items from fixtures', async (t) => {
  const daily = {};
  for (const key of ['youkeisai', 'kasai', 'konsai', 'imo']) {
    const buf = fixture(`_kakakugurafu_${key}.xlsx.xlsx`);
    if (buf) daily[key] = buf;
  }
  const catalog = await loadVegCatalog();
  const monthly = {};
  for (const it of catalog) {
    const buf = fixture(`_wp-content_uploads_${it.monthlyKey}.xlsx.xlsx`);
    if (buf) monthly[it.monthlyKey] = buf;
  }
  if (Object.keys(daily).length === 0 || Object.keys(monthly).length === 0) {
    return t.skip('vegetan fixtures missing');
  }

  const { items, missing } = normalizeVegetan({ daily, monthly }, catalog);
  assert.equal(missing.length, 0, `missing: ${missing}`);
  assert.equal(items.length, 19);

  const tomato = items.find((i) => i.slug === 'tomato');
  assert.ok(tomato.hasDaily);
  assert.ok(tomato.series.length >= 20);
  assert.ok(tomato.monthly.length >= 240);

  // monthly-only items fall back to the monthly series as primary
  const asparagus = items.find((i) => i.slug === 'asparagus');
  assert.equal(asparagus.hasDaily, false);
  assert.equal(asparagus.series.length, asparagus.monthly.length);
});

// ---- merge + stats -------------------------------------------------------------

test('mergeByDate accumulates daily points and lets re-fetches overwrite', () => {
  const existing = [
    { date: '2026-06-01', price: 100, normalRatio: 1.0 },
    { date: '2026-06-02', price: 105, normalRatio: 1.05 },
  ];
  const incoming = [
    { date: '2026-06-02', price: 106, normalRatio: 1.06 }, // revised value wins
    { date: '2026-06-03', price: 110, normalRatio: 1.1 },
  ];
  const merged = mergeByDate(existing, incoming);
  assert.equal(merged.length, 3);
  assert.equal(merged[1].price, 106);
  assert.equal(merged[1].normalRatio, 1.06);
  // idempotent
  assert.deepEqual(mergeByDate(merged, incoming), merged);
});

test('computeItemStats uses source 平年比 for veg daily buy signal', () => {
  const mk = (ratio) => ({
    slug: 'x',
    source: 'vegetan',
    hasDaily: true,
    series: [
      { date: '2026-06-01', price: 100, normalPrice: 120, normalRatio: 100 / 120 },
      { date: '2026-06-02', price: 96, normalPrice: 120, normalRatio: ratio },
    ],
    monthly: [
      { date: '2026-05-01', price: 110 },
      { date: '2026-06-01', price: 100 },
    ],
  });
  const cheap = computeItemStats(mk(0.8));
  assert.equal(cheap.daily, true);
  assert.equal(cheap.isBuy, true, 'ratio 0.8 < 0.9 threshold => buy');
  assert.ok(Math.abs(cheap.vsNormalPct - -20) < 1e-9);
  assert.ok(cheap.momPct != null, 'momPct from monthly series');

  const dear = computeItemStats(mk(1.2));
  assert.equal(dear.isBuy, false);
  assert.ok(dear.vsNormalPct > 0);

  const border = computeItemStats(mk(BUY_RATIO_THRESHOLD));
  assert.equal(border.isBuy, false, 'exactly at threshold is NOT a buy');
});
