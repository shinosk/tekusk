import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ESTAT_FIXTURES_DIR, CONFIG_DIR } from '../src/lib/paths.mjs';
import {
  estatNum,
  surveyYear,
  expectedLatestYear,
  listTables,
  latestListYear,
  resolveItemTables,
  describeAxes,
  normalizeEstat,
} from '../src/lib/estat.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
// getStatsData fixtures embed their statsDataId in the filename.
function dataFixture(id) {
  const f = fs.readdirSync(ESTAT_FIXTURES_DIR).find((n) => n.includes(`statsDataId_${id}`));
  return readJson(path.join(ESTAT_FIXTURES_DIR, f));
}
const catalog = readJson(path.join(CONFIG_DIR, 'items.json'));
const catalogTail = readJson(path.join(ESTAT_FIXTURES_DIR, 'catalog-tail-getStatsList.json'));

// ---- primitives ------------------------------------------------------------

test('estatNum parses numbers and treats suppressed cells as null', () => {
  assert.equal(estatNum('123'), 123);
  assert.equal(estatNum('45.6'), 45.6);
  assert.equal(estatNum('-'), null); // not-applicable
  assert.equal(estatNum('…'), null); // suppressed
  assert.equal(estatNum(''), null);
  assert.equal(estatNum(null), null);
  assert.equal(estatNum(78), 78);
});

test('surveyYear / expectedLatestYear', () => {
  assert.equal(surveyYear('202401-202412'), 2024);
  assert.equal(surveyYear('202301'), 2023);
  assert.equal(surveyYear(''), null);
  // Data for year Y is published ~April of Y+2.
  assert.equal(expectedLatestYear(new Date('2026-07-12T00:00:00Z')), 2024);
  assert.equal(expectedLatestYear(new Date('2026-02-01T00:00:00Z')), 2023);
});

// ---- discovery (catalog-tail getStatsList) ---------------------------------

test('listTables extracts 主要消費地域別 tables and latest year', () => {
  const tables = listTables(catalogTail);
  assert.ok(tables.length > 0);
  // Every table is from one of the two 主要消費地域別 families.
  assert.ok(tables.every((t) => /主要消費地域別/.test(t.category)));
  assert.equal(latestListYear(tables), 2024);
  // Both a vegetable (だいこん) and a fruit (りんご 計) table exist for 2024.
  const y2024 = tables.filter((t) => t.year === 2024);
  assert.ok(y2024.some((t) => t.tableName === 'だいこん'));
  assert.ok(y2024.some((t) => t.tableName === 'りんご' && t.sub === '計'));
});

test('resolveItemTables maps catalog items to the right statsDataId (latest year, 計 variant)', () => {
  const tables = listTables(catalogTail);
  const items = catalog.items.filter((it) =>
    ['radish', 'cabbage', 'apple', 'grape', 'cherry', 'mini-tomato'].includes(it.slug)
  );
  const resolved = resolveItemTables(tables, items, 2024);
  const bySlug = new Map(resolved.map((r) => [r.item.slug, r]));

  assert.equal(bySlug.get('radish').id, '0004044496'); // だいこん
  assert.equal(bySlug.get('cabbage').id, '0004044497'); // キャベツ
  assert.equal(bySlug.get('apple').id, '0004044462'); // りんご 計 (not つがる etc.)
  assert.equal(bySlug.get('mini-tomato').id, '0004044437'); // ミニトマト
  // multi-variety fruit picks the 計 table
  assert.equal(bySlug.get('grape').id, '0004044483'); // ぶどう 計
  // さくらんぼ maps via estatTitle=おうとう (single table, no variety)
  assert.ok(bySlug.get('cherry').id);
  // every resolved id must be for 2024
  assert.ok(resolved.every((r) => r.year === 2024));
});

test('resolveItemTables skips items without a matching table', () => {
  const tables = listTables(catalogTail);
  const bogus = [{ slug: 'x', estatTitle: '存在しない品目' }];
  assert.equal(resolveItemTables(tables, bogus, 2024).length, 0);
});

// ---- normalization: vegetable (4-axis) -------------------------------------

test('normalizeEstat (vegetable / radish) produces regions, national & origin shares', () => {
  const item = catalog.items.find((i) => i.slug === 'radish');
  const rec = normalizeEstat(dataFixture('0004044496'), item, { id: '0004044496', year: 2024 });
  assert.ok(rec);
  assert.equal(rec.year, 2024);
  assert.equal(rec.source, 'estat');
  assert.equal(rec.regionsOrder.length, 12); // 12 消費地域
  assert.equal(rec.national.length, 12); // 12 months
  assert.ok(rec.national.every((p) => p.price > 0));
  // origins: top-5, quantity-descending, shares in (0,1]
  assert.ok(rec.origins.length >= 1 && rec.origins.length <= 5);
  assert.equal(rec.origins[0].name, '千葉'); // top radish origin in 2024
  for (let i = 1; i < rec.origins.length; i++) {
    assert.ok(rec.origins[i - 1].qty >= rec.origins[i].qty);
  }
  assert.ok(rec.origins.every((o) => o.share > 0 && o.share <= 1));
});

test('describeAxes detects the vegetable 4-axis shape', () => {
  const sd = dataFixture('0004044496').GET_STATS_DATA.STATISTICAL_DATA;
  const ax = describeAxes(sd);
  assert.equal(ax.kind, 'veg');
  assert.ok(ax.originTotal); // 計 origin resolved
});

// ---- normalization: fruit (3-axis, compound region·origin) -----------------

test('normalizeEstat (fruit / apple) parses compound region·origin axis', () => {
  const item = catalog.items.find((i) => i.slug === 'apple');
  const rec = normalizeEstat(dataFixture('0004044462'), item, { id: '0004044462', year: 2024 });
  assert.ok(rec);
  assert.equal(rec.category, '果実');
  assert.ok(rec.regionsOrder.includes('東京都')); // market totals recovered
  assert.equal(rec.national.length, 12);
  assert.ok(rec.national.every((p) => p.price > 0));
  // Aomori dominates apple production.
  assert.equal(rec.origins[0].name, '青森');
  assert.ok(rec.origins[0].share > 0.5);
});

test('describeAxes detects the fruit 3-axis shape', () => {
  const sd = dataFixture('0004044462').GET_STATS_DATA.STATISTICAL_DATA;
  const ax = describeAxes(sd);
  assert.equal(ax.kind, 'fruit');
});

// ---- truncated data resilience ---------------------------------------------

test('normalizeEstat tolerates truncated data (cabbage, limit-capped fixture)', () => {
  const item = catalog.items.find((i) => i.slug === 'cabbage');
  const raw = dataFixture('0004044497');
  // The fixture is truncated (10000 of 14976 values) — normalize must not throw
  // and must still return sensible top origins from whatever exists.
  const rec = normalizeEstat(raw, item, { id: '0004044497', year: 2024 });
  assert.ok(rec);
  assert.ok(rec.origins.length >= 1);
  assert.equal(rec.origins[0].name, '群馬'); // top cabbage origin
  assert.ok(rec.national.length >= 1);
  assert.ok(rec.origins.every((o) => o.share > 0 && o.share <= 1));
});

test('normalizeEstat returns null for an unrecognisable payload', () => {
  assert.equal(normalizeEstat({}, { slug: 'x' }), null);
  assert.equal(normalizeEstat({ GET_STATS_DATA: { STATISTICAL_DATA: {} } }, { slug: 'x' }), null);
});
