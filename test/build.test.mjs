import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { lineChartSvg } from '../src/lib/chart.mjs';
import { renderPage } from '../src/templates/layout.mjs';
import { weeklyReport } from '../src/lib/report.mjs';
import { computeItemStats, buildRankings } from '../src/lib/stats.mjs';
import { ROOT, DATA_DIR, PUBLIC_DIR, CONFIG_DIR } from '../src/lib/paths.mjs';

// 内部リンク検証用: 現在の config/site.json からパスプレフィックスを導出
// (カスタムドメイン=ルート配信なら空、github.ioプロジェクト配信なら /<repo>)
const SITE_CONF = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'site.json'), 'utf8'));
const PREFIX = (() => {
  try { return new URL(SITE_CONF.baseUrl).pathname.replace(/\/$/, ''); } catch { return ''; }
})();
const escPrefix = PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

// Retail pages: when data/retail exists, the build must emit the /retail/ index
// plus per-city pages, wire them into the nav/sitemap, and add the retail +
// explainer sections to the item pages — all with root-absolute internal links
// (so the /tekusk path prefix applies) and honest "月次調査" framing.
test('build.mjs emits retail pages and item explainer/retail sections', (t) => {
  const metaPath = path.join(DATA_DIR, 'meta.json');
  const retailDir = path.join(DATA_DIR, 'retail');
  if (!fs.existsSync(metaPath) || !fs.existsSync(retailDir)) {
    t.skip('no data/retail — run `node scripts/fetch.mjs --source=retail --fixtures` first');
    return;
  }
  execFileSync('node', ['scripts/build.mjs'], { cwd: ROOT, stdio: 'pipe' });

  // Retail index + at least one known city page exist.
  const retailIndex = path.join(PUBLIC_DIR, 'retail/index.html');
  const sapporo = path.join(PUBLIC_DIR, 'retail/sapporo/index.html');
  assert.ok(fs.existsSync(retailIndex), 'public/retail/index.html should exist');
  assert.ok(fs.existsSync(sapporo), 'public/retail/sapporo/index.html should exist');

  const idxHtml = fs.readFileSync(retailIndex, 'utf8');
  const cityHtml = fs.readFileSync(sapporo, 'utf8');
  // Honest monthly framing, never a daily-update claim on retail pages.
  assert.match(idxHtml, /月次調査/);
  assert.match(cityHtml, /月次/);
  assert.doesNotMatch(cityHtml, /毎日更新/);
  // Root-absolute internal links carry the site path prefix (/tekusk).
  assert.match(cityHtml, new RegExp(`href="${escPrefix}/items/`));
  // JSON-LD Dataset + attribution present.
  assert.match(cityHtml, /"@type":"Dataset"/);
  assert.match(cityHtml, /食品価格動向調査/);

  // Item page (tomato) gained the retail table + evergreen explainer section.
  const tomato = fs.readFileSync(path.join(PUBLIC_DIR, 'items/tomato/index.html'), 'utf8');
  assert.match(tomato, /都市別の小売価格（月次調査）/);
  assert.match(tomato, /選び方・保存・価格の見方/);
  assert.match(tomato, new RegExp(`href="${escPrefix}/retail/sapporo/`));

  // Sitemap includes the retail URLs; nav link is present site-wide.
  const sitemap = fs.readFileSync(path.join(PUBLIC_DIR, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /\/retail\/sapporo\//);
  assert.match(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'), /小売価格/);
});

// e-Stat (青果物卸売市場調査・年次): when data/estat exists, the build must emit
// standalone fruit item pages, add the 果実 top-page section + nav, embed the
// 産地/地域別 section on vegetable pages that have estat data, and frame it all as
// annual (年次) — never with a stale "archive banner". Root-absolute internal
// links must carry the /tekusk path prefix, and the source must be attributed.
test('build.mjs emits estat fruit pages, veg estat sections and honest annual framing', (t) => {
  const metaPath = path.join(DATA_DIR, 'meta.json');
  const estatDir = path.join(DATA_DIR, 'estat');
  if (!fs.existsSync(metaPath) || !fs.existsSync(estatDir)) {
    t.skip('no data/estat — run `node scripts/fetch.mjs --source=estat --fixtures` first');
    return;
  }
  execFileSync('node', ['scripts/build.mjs'], { cwd: ROOT, stdio: 'pipe' });

  // Standalone fruit page (apple) exists with annual framing + attribution.
  const applePath = path.join(PUBLIC_DIR, 'items/apple/index.html');
  assert.ok(fs.existsSync(applePath), 'public/items/apple/index.html should exist');
  const apple = fs.readFileSync(applePath, 'utf8');
  assert.match(apple, /青果物卸売市場調査/);
  assert.match(apple, /年次公表/);
  assert.match(apple, /e-Stat）を加工して作成/);
  assert.doesNotMatch(apple, /archive-banner/); // annual data is not "archived"
  assert.match(apple, /主な産地/);
  assert.match(apple, /消費地域別の月別卸売価格/);

  // Top page: 果実 section + nav link, root-absolute internal links prefixed.
  const index = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  assert.match(index, /id="fruits"/);
  assert.match(index, /果実の卸売価格と産地/);
  assert.match(index, new RegExp(`href="${escPrefix}/items/apple/`));
  assert.match(index, new RegExp(`href="${escPrefix}/#fruits"`)); // nav

  // Vegetable page (radish) gained the embedded 政府統計 section.
  const radish = fs.readFileSync(path.join(PUBLIC_DIR, 'items/radish/index.html'), 'utf8');
  assert.match(radish, /産地と地域別の卸売価格（政府統計）/);
  assert.match(radish, /青果物卸売市場調査/);

  // Sitemap + about attribution.
  assert.match(fs.readFileSync(path.join(PUBLIC_DIR, 'sitemap.xml'), 'utf8'), /\/items\/apple\//);
  assert.match(fs.readFileSync(path.join(PUBLIC_DIR, 'about/index.html'), 'utf8'), /青果物卸売市場調査/);
});

// Per-source freshness + attribution: on a build that has BOTH the live
// vegetan data and the frozen commodity archive, veg pages must carry live
// copy + the ベジ探 attribution and NO archive banner, while commodity pages
// must carry the archive banner. This is the "freshness per data source"
// requirement made observable in the generated HTML.
test('per-source freshness: veg pages live, commodity pages archived', (t) => {
  const meta = fs.existsSync(path.join(DATA_DIR, 'meta.json'))
    ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'meta.json'), 'utf8'))
    : null;
  if (!meta || !meta.sources || !meta.sources.vegetan || !meta.sources.commodity) {
    t.skip('needs both vegetan and commodity data — run both fetches first');
    return;
  }
  execFileSync('node', ['scripts/build.mjs'], { cwd: ROOT, stdio: 'pipe' });

  const tomato = fs.readFileSync(path.join(PUBLIC_DIR, 'items/tomato/index.html'), 'utf8');
  const banana = fs.readFileSync(path.join(PUBLIC_DIR, 'items/banana/index.html'), 'utf8');
  const index = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const about = fs.readFileSync(path.join(PUBLIC_DIR, 'about/index.html'), 'utf8');

  // veg page: live (no archive banner), attributed, two-chart layout
  assert.doesNotMatch(tomato, /archive-banner/);
  assert.match(tomato, /ベジ探』のデータを加工して作成/);
  assert.match(tomato, /日次の卸売価格/);
  assert.match(tomato, /長期の価格推移（2005年〜・月次）/);

  // commodity page: archive banner + honest framing on the same build
  assert.match(banana, /archive-banner/);
  assert.match(banana, /月次アーカイブ/);
  assert.match(banana, /国際市況アーカイブ/);

  // top page: vegetable-first with 平年比-based buy framing + attribution
  assert.doesNotMatch(index, /archive-banner/);
  assert.match(index, /買い時の野菜/);
  assert.match(index, /平年比/);
  assert.match(index, /ベジ探』のデータを加工して作成/);

  // about page: attribution required
  assert.match(about, /ベジ探』のデータを加工して作成/);
});

// Custom-domain support (config/site.json `customDomain`, opt-in): when unset
// (the default), no GitHub Pages CNAME or ads.txt should be emitted. When set,
// CNAME must contain the domain, and ads.txt (declaring this site an
// authorized AdSense seller) must be emitted iff adsenseClientId is also set.
test('build.mjs emits CNAME/ads.txt only when customDomain is configured', (t) => {
  if (!fs.existsSync(path.join(DATA_DIR, 'meta.json'))) {
    t.skip('no data/meta.json — run `npm run fetch` first');
    return;
  }
  const sitePath = path.join(CONFIG_DIR, 'site.json');
  const original = fs.readFileSync(sitePath, 'utf8');
  const site = JSON.parse(original);

  try {
    // customDomain を空にした場合: どちらのファイルも生成されない。
    fs.writeFileSync(sitePath, JSON.stringify({ ...site, customDomain: '' }, null, 2));
    execFileSync('node', ['scripts/build.mjs'], { cwd: ROOT, stdio: 'pipe' });
    assert.ok(!fs.existsSync(path.join(PUBLIC_DIR, 'CNAME')), 'CNAME should not exist when customDomain is empty');
    assert.ok(!fs.existsSync(path.join(PUBLIC_DIR, 'ads.txt')), 'ads.txt should not exist when customDomain is empty');

    // customDomain set + adsenseClientId set: both CNAME and ads.txt emitted.
    fs.writeFileSync(
      sitePath,
      JSON.stringify({ ...site, customDomain: 'example.com', adsenseClientId: 'ca-pub-1234567890123456' }, null, 2)
    );
    execFileSync('node', ['scripts/build.mjs'], { cwd: ROOT, stdio: 'pipe' });
    const cname = fs.readFileSync(path.join(PUBLIC_DIR, 'CNAME'), 'utf8').trim();
    assert.equal(cname, 'example.com');
    const adsTxt = fs.readFileSync(path.join(PUBLIC_DIR, 'ads.txt'), 'utf8').trim();
    assert.equal(adsTxt, 'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0');

    // customDomain set but adsenseClientId empty: CNAME only, no ads.txt.
    fs.writeFileSync(
      sitePath,
      JSON.stringify({ ...site, customDomain: 'example.com', adsenseClientId: '' }, null, 2)
    );
    execFileSync('node', ['scripts/build.mjs'], { cwd: ROOT, stdio: 'pipe' });
    assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'CNAME')));
    assert.ok(!fs.existsSync(path.join(PUBLIC_DIR, 'ads.txt')), 'ads.txt should not exist when adsenseClientId is empty');
  } finally {
    fs.writeFileSync(sitePath, original);
    // Rebuild once more with the restored (committed) config so the public/
    // directory left behind after the test run matches the real site config.
    execFileSync('node', ['scripts/build.mjs'], { cwd: ROOT, stdio: 'pipe' });
  }
});
