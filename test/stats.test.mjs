import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pct,
  mean,
  shiftMonths,
  normalForMonth,
  movingAverage,
  computeItemStats,
  buildRankings,
} from '../src/lib/stats.mjs';

test('pct computes percentage change and guards zero', () => {
  assert.equal(pct(100, 110), 10);
  assert.equal(pct(200, 150), -25);
  assert.equal(pct(0, 5), null);
  assert.equal(pct(null, 5), null);
});

test('mean ignores non-finite', () => {
  assert.equal(mean([2, 4, 6]), 4);
  assert.equal(mean([]), null);
});

test('shiftMonths crosses year boundaries', () => {
  assert.equal(shiftMonths('2016-06', 12), '2015-06');
  assert.equal(shiftMonths('2016-01', 1), '2015-12');
  assert.equal(shiftMonths('2016-01', 13), '2014-12');
});

test('normalForMonth averages same calendar month', () => {
  const series = [
    { date: '2014-06-01', price: 10 },
    { date: '2015-06-01', price: 20 },
    { date: '2015-07-01', price: 99 },
    { date: '2016-06-01', price: 30 },
  ];
  assert.equal(normalForMonth(series, '06'), 20);
});

test('movingAverage of last n', () => {
  const series = [10, 20, 30, 40].map((p, i) => ({ date: `2016-0${i + 1}-01`, price: p }));
  assert.equal(movingAverage(series, 2), 35);
});

test('computeItemStats derives mom/yoy/normal/buy signal', () => {
  // 25 monthly points; construct a clear "cheap now" scenario.
  const series = [];
  let d = new Date(Date.UTC(2014, 0, 1));
  for (let i = 0; i < 25; i++) {
    const iso = d.toISOString().slice(0, 10);
    // high prices historically (100), last point cheap (50)
    series.push({ date: iso, price: i === 24 ? 50 : 100 });
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
  const stats = computeItemStats({ slug: 't', series });
  assert.equal(stats.latest.price, 50);
  assert.equal(stats.prev.price, 100);
  assert.equal(stats.momPct, -50);
  assert.ok(stats.yoyPct < 0);
  assert.ok(stats.vsNormalPct < 0, 'should be below normal');
  assert.equal(stats.isBuy, true, 'below normal and below trend => buy');
  assert.ok(stats.buyScore > 0);
});

test('computeItemStats returns null for empty series', () => {
  assert.equal(computeItemStats({ slug: 'x', series: [] }), null);
});

test('buildRankings splits risers/fallers/buys', () => {
  const mk = (slug, momPct, isBuy, buyScore) => ({
    item: { slug, name: slug },
    stats: { momPct, isBuy, buyScore },
  });
  const entries = [
    mk('a', 5, false, 0),
    mk('b', -8, true, 12),
    mk('c', 2, true, 3),
    mk('d', -1, false, 0),
  ];
  const r = buildRankings(entries);
  assert.equal(r.risers[0].item.slug, 'a');
  assert.equal(r.fallers[0].item.slug, 'b');
  assert.equal(r.buys[0].item.slug, 'b'); // highest buyScore first
  assert.equal(r.buys.length, 2);
});
