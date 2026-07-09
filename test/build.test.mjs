import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { lineChartSvg } from '../src/lib/chart.mjs';
import { renderPage } from '../src/templates/layout.mjs';
import { weeklyReport } from '../src/lib/report.mjs';
import { computeItemStats, buildRankings } from '../src/lib/stats.mjs';
import { ROOT, DATA_DIR, PUBLIC_DIR } from '../src/lib/paths.mjs';

test('lineChartSvg produces valid svg and handles short series', () => {
  const svg = lineChartSvg([
    { date: '2016-01-01', price: 10 },
    { date: '2016-02-01', price: 20 },
    { date: '2016-03-01', price: 15 },
  ]);
  assert.match(svg, /^<svg/);
  assert.match(svg, /chart-line/);
  const empty = lineChartSvg([{ date: '2016-01-01', price: 10 }]);
  assert.match(empty, /データ不足/);
});

test('renderPage emits doctype, escapes, meta and canonical', () => {
  const site = { siteName: 'テスト', tagline: 't', lang: 'ja', locale: 'ja_JP', baseUrl: 'https://ex.com', adsenseClientId: '' };
  const html = renderPage(site, {
    title: '<script>x</script>',
    description: 'desc & "quote"',
    path: '/foo/',
    body: '<p>hi</p>',
    jsonld: [{ '@context': 'https://schema.org', '@type': 'Thing' }],
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/ex.com\/foo\/">/);
  assert.doesNotMatch(html, /<script>x<\/script>/); // title must be escaped
  assert.match(html, /application\/ld\+json/);
  // ad markup absent when no client id
  assert.doesNotMatch(html, /adsbygoogle/);
});

test('renderPage injects AdSense only when configured', () => {
  const site = { siteName: 'T', tagline: 't', lang: 'ja', locale: 'ja_JP', baseUrl: 'https://ex.com', adsenseClientId: 'ca-pub-123' };
  const html = renderPage(site, { title: 'x', description: 'd', path: '/', body: '' });
  assert.match(html, /adsbygoogle/);
  assert.match(html, /ca-pub-123/);
});

test('weeklyReport builds paragraphs from stats without throwing', () => {
  const mkSeries = (base) =>
    Array.from({ length: 24 }, (_, i) => ({
      date: `20${14 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`,
      price: base + i,
    }));
  const entries = [
    { item: { slug: 'a', name: 'バナナ', unit: 'USD/トン' }, series: mkSeries(100) },
    { item: { slug: 'b', name: '米', unit: 'USD/トン' }, series: mkSeries(200) },
  ].map((e) => ({ item: e.item, stats: computeItemStats({ slug: e.item.slug, series: e.series }) }));
  const rankings = buildRankings(entries);
  const meta = { latestDate: '2015-12-01', source: { title: 'テストソース' } };
  const rep = weeklyReport(meta, entries, rankings);
  assert.ok(rep.paragraphs.length >= 3);
  assert.ok(rep.title.includes('レポート'));
});

// Integration: if data has been fetched, a full build must succeed and emit HTML.
test('build.mjs runs end-to-end when data exists', (t) => {
  if (!fs.existsSync(path.join(DATA_DIR, 'meta.json'))) {
    t.skip('no data/meta.json — run `npm run fetch` first');
    return;
  }
  execFileSync('node', ['scripts/build.mjs'], { cwd: ROOT, stdio: 'pipe' });
  const idx = path.join(PUBLIC_DIR, 'index.html');
  assert.ok(fs.existsSync(idx), 'public/index.html should exist');
  const html = fs.readFileSync(idx, 'utf8');
  assert.match(html, /<!doctype html>/);
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'sitemap.xml')));
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'robots.txt')));
});
