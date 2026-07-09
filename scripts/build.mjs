#!/usr/bin/env node
// Build static site from data/*.json into public/.

import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR, DATA_DIR, DATA_ITEMS_DIR, PUBLIC_DIR } from '../src/lib/paths.mjs';
import { renderPage, adSlot, STYLESHEET } from '../src/templates/layout.mjs';
import { computeItemStats, buildRankings } from '../src/lib/stats.mjs';
import { lineChartSvg } from '../src/lib/chart.mjs';
import { esc } from '../src/lib/html.mjs';
import { fmtNum, fmtPct, fmtMonth, fmtDate, trendClass } from '../src/lib/format.mjs';
import { weeklyReport, headline, itemBlurb } from '../src/lib/report.mjs';

async function readJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

async function loadItems() {
  let files = [];
  try {
    files = (await fs.readdir(DATA_ITEMS_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const recs = [];
  for (const f of files) {
    const rec = await readJson(path.join(DATA_ITEMS_DIR, f), null);
    if (rec && Array.isArray(rec.series) && rec.series.length) recs.push(rec);
  }
  return recs;
}

async function write(rel, content) {
  const out = path.join(PUBLIC_DIR, rel);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, content);
}

function pctCell(v) {
  const c = trendClass(v);
  const arrow = v == null ? '' : v > 1 ? '▲' : v < -1 ? '▼' : '＝';
  return `<span class="${c}">${arrow} ${fmtPct(v)}</span>`;
}

function statBox(k, v) {
  return `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`;
}

// ---- Page: item ----------------------------------------------------------
function renderItemPage(site, meta, entry, updatedLabel) {
  const { item, stats } = entry;
  const s = item.series;
  const recent = s.slice(-36);
  const canonicalPath = `/items/${item.slug}/`;

  const buyBadge = stats.isBuy
    ? `<span class="badge pill-down">いま買い時 🟢</span>`
    : stats.vsNormalPct != null && stats.vsNormalPct > 5
      ? `<span class="badge pill-up">やや割高</span>`
      : `<span class="badge">通常水準</span>`;

  const body = `
<h1>${item.emoji} ${esc(item.name)}の価格推移 <span class="cat-tag">/ ${esc(item.category)}</span></h1>
<p class="lead">${esc(itemBlurb(item, stats))} ${buyBadge}</p>

<div class="statgrid">
  ${statBox('最新価格', `${fmtNum(stats.latest.price)}<small> ${esc(item.unit)}</small>`)}
  ${statBox('前月比', pctCell(stats.momPct))}
  ${statBox('前年比', pctCell(stats.yoyPct))}
  ${statBox('平年比', pctCell(stats.vsNormalPct))}
  ${statBox('期間高値', fmtNum(stats.max))}
  ${statBox('期間安値', fmtNum(stats.min))}
</div>

<h2>直近3年の価格推移</h2>
${lineChartSvg(recent, { ariaLabel: `${item.name}の直近価格推移`, title: `${item.name} 直近` })}

<h2>取得できる全期間の価格推移</h2>
${lineChartSvg(s, { ariaLabel: `${item.name}の長期価格推移`, title: `${item.name} 長期` })}
<p class="lead">対象期間: ${fmtMonth(stats.firstDate)} 〜 ${fmtMonth(stats.lastDate)}（${stats.pointCount}件）</p>

${adSlot(site, site.adsenseSlotItem)}

<h2>品目情報</h2>
<table>
  <tr><th>分類</th><td>${esc(item.category)}</td></tr>
  <tr><th>代表産地・規格</th><td>${esc(item.origin)}</td></tr>
  <tr><th>旬・出回り</th><td>${esc(item.season)}</td></tr>
  <tr><th>価格の単位</th><td>${esc(item.unit)}</td></tr>
  <tr><th>平年値（同月平均）</th><td>${fmtNum(stats.normal)} ${esc(item.unit)}</td></tr>
</table>

<div class="notice">価格は${esc(meta.source.title)}に基づく参考値です。単位は品目により異なります。${esc(meta.source.attribution)}</div>
`;

  const breadcrumb = [
    { name: 'トップ', url: '/' },
    { name: '品目一覧', url: '/#items' },
    { name: item.name, url: canonicalPath },
  ];

  const jsonld = [
    {
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: `${item.name}の価格推移`,
      description: `${item.name}（${item.origin}）の価格時系列。最新 ${fmtMonth(stats.lastDate)}、前月比 ${fmtPct(stats.momPct)}。`,
      creator: { '@type': 'Organization', name: meta.source.attribution },
      license: meta.source.licenseUrl,
      isAccessibleForFree: true,
      temporalCoverage: `${stats.firstDate}/${stats.lastDate}`,
      variableMeasured: `価格（${item.unit}）`,
      url: site.baseUrl.replace(/\/$/, '') + canonicalPath,
    },
    breadcrumbLd(site, breadcrumb),
  ];

  return renderPage(site, {
    title: `${item.name}の価格推移・平年比`,
    description: `${item.name}の最新価格は${fmtNum(stats.latest.price)}${item.unit}（前月比${fmtPct(stats.momPct)}）。平年比${fmtPct(stats.vsNormalPct)}。価格推移チャートと旬情報をチェック。`,
    path: canonicalPath,
    breadcrumb,
    jsonld,
    updatedLabel,
    body,
  });
}

function breadcrumbLd(site, items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((b, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: b.name,
      item: site.baseUrl.replace(/\/$/, '') + b.url,
    })),
  };
}

// ---- Page: index ---------------------------------------------------------
function renderIndex(site, meta, entries, rankings, updatedLabel) {
  const byCat = new Map();
  for (const e of entries) {
    if (!byCat.has(e.item.category)) byCat.set(e.item.category, []);
    byCat.get(e.item.category).push(e);
  }

  const buyCards = rankings.buys.length
    ? `<div class="grid cards">${rankings.buys
        .map(
          (e) => `<a class="card item-card" href="/items/${e.item.slug}/">
        <span class="em">${e.item.emoji}</span>
        <span class="nm">${esc(e.item.name)}</span>
        <span class="px">${fmtNum(e.stats.latest.price)} <small>${esc(e.item.unit)}</small></span>
        <span class="down">平年比 ${fmtPct(e.stats.vsNormalPct)}</span>
      </a>`
        )
        .join('')}</div>`
    : `<p class="lead">現在、明確な「買い時」と判定された品目はありません。</p>`;

  const rankList = (list, cls) =>
    `<ul class="rank-list">${list
      .map(
        (e) =>
          `<li><a href="/items/${e.item.slug}/">${e.item.emoji} ${esc(e.item.name)}</a><span class="${cls}">${fmtPct(e.stats.momPct)}</span></li>`
      )
      .join('')}</ul>`;

  const catSections = [...byCat.entries()]
    .map(
      ([cat, list]) => `<h3>${esc(cat)}</h3>
    <div class="grid cards">${list
      .map(
        (e) => `<a class="card item-card" href="/items/${e.item.slug}/">
          <span class="em">${e.item.emoji}</span>
          <span class="nm">${esc(e.item.name)}</span>
          <span class="px">${fmtNum(e.stats.latest.price)} <small>${esc(e.item.unit)}</small></span>
          <span class="${trendClass(e.stats.momPct)}">前月比 ${fmtPct(e.stats.momPct)}</span>
        </a>`
      )
      .join('')}</div>`
    )
    .join('');

  const body = `
<h1>今週の野菜・食品価格ナビ</h1>
<p class="lead">${esc(headline(meta, rankings))}</p>
<div class="notice">最新集計: <strong>${fmtMonth(meta.latestDate)}</strong>／対象 ${entries.length} 品目。データは毎日自動で取得・更新しています。</div>

<h2>🟢 いまが買い時の品目</h2>
<p class="lead">平年（同月の過去平均）と直近12か月の水準をどちらも下回っている＝割安な品目です。</p>
${buyCards}

${adSlot(site, site.adsenseSlotTop)}

<h2>値上がり・値下がりランキング（前月比）</h2>
<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
  <div class="card"><h3 class="up">▲ 値上がり</h3>${rankList(rankings.risers, 'up')}</div>
  <div class="card"><h3 class="down">▼ 値下がり</h3>${rankList(rankings.fallers, 'down')}</div>
</div>

<h2 id="items">品目一覧</h2>
${catSections}
`;

  const jsonld = [
    {
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: site.siteName,
      description: site.description,
      creator: { '@type': 'Organization', name: meta.source.attribution },
      license: meta.source.licenseUrl,
      isAccessibleForFree: true,
      dateModified: meta.generatedAt,
      url: site.baseUrl,
    },
    breadcrumbLd(site, [{ name: 'トップ', url: '/' }]),
  ];

  return renderPage(site, {
    title: site.siteName,
    description: site.description,
    path: '/',
    jsonld,
    updatedLabel,
    body,
  });
}

// ---- Page: weekly --------------------------------------------------------
function renderWeekly(site, meta, entries, rankings, updatedLabel) {
  const rep = weeklyReport(meta, entries, rankings);
  const movers = [...rankings.risers.slice(0, 3), ...rankings.fallers.slice(0, 3)];
  const body = `
<h1>${esc(rep.title)}</h1>
<p class="lead">データから自動生成した価格まとめです（${fmtMonth(meta.latestDate)}）。</p>
<div class="report">${rep.paragraphs.map((t) => `<p>${esc(t)}</p>`).join('')}</div>

${adSlot(site, site.adsenseSlotTop)}

<h2>主な値動き</h2>
<table>
  <thead><tr><th>品目</th><th class="num">最新価格</th><th class="num">前月比</th><th class="num">平年比</th></tr></thead>
  <tbody>${movers
    .map(
      (e) =>
        `<tr><td><a href="/items/${e.item.slug}/">${e.item.emoji} ${esc(e.item.name)}</a></td><td class="num">${fmtNum(e.stats.latest.price)}</td><td class="num">${pctCell(e.stats.momPct)}</td><td class="num">${pctCell(e.stats.vsNormalPct)}</td></tr>`
    )
    .join('')}</tbody>
</table>
`;
  const jsonld = [breadcrumbLd(site, [{ name: 'トップ', url: '/' }, { name: '週報', url: '/weekly/' }])];
  return renderPage(site, {
    title: rep.title,
    description: `${fmtMonth(meta.latestDate)}の野菜・食品価格まとめ。値上がり・値下がり・買い時品目を自動集計したレポートです。`,
    path: '/weekly/',
    breadcrumb: [{ name: 'トップ', url: '/' }, { name: '週報', url: '/weekly/' }],
    jsonld,
    updatedLabel,
    body,
  });
}

// ---- Page: about ---------------------------------------------------------
function renderAbout(site, meta, updatedLabel) {
  const src = meta.source;
  const body = `
<h1>データ出典・このサイトについて</h1>
<p class="lead">${esc(site.siteName)}は、公開オープンデータをもとに価格情報を<strong>自動生成・毎日更新</strong>するユーティリティサイトです。</p>

<h2>データの出典</h2>
<table>
  <tr><th>現在のデータソース</th><td>${esc(src.title)}</td></tr>
  <tr><th>提供元・出典表示</th><td>${esc(src.attribution)}</td></tr>
  <tr><th>取得元URL</th><td><a href="${esc(src.homepage)}" rel="nofollow">${esc(src.homepage)}</a></td></tr>
  <tr><th>ライセンス</th><td><a href="${esc(src.licenseUrl)}" rel="nofollow">${esc(src.license)}</a></td></tr>
  <tr><th>更新頻度</th><td>${esc(src.cadence)}（本サイトは日次で自動チェック）</td></tr>
  <tr><th>最新データ</th><td>${fmtMonth(meta.latestDate)}</td></tr>
</table>

<h2>自動更新であることの開示</h2>
<p>本サイトのすべてのページは、GitHub Actions の日次スケジュール（日本時間の朝）で
データ取得スクリプトとページ生成スクリプトを実行し、自動的に再構築・公開されています。
編集者による手動の価格入力・修正は行っていません。</p>

<h2>指標の算出方法</h2>
<ul>
  <li><strong>前月比 / 前年比</strong>: 直前の集計期・12か月前と比較した価格変化率です。</li>
  <li><strong>平年比</strong>: 同じ月の過去全期間の平均（＝平年値）と比較した割安・割高の度合いです。</li>
  <li><strong>いま買い時</strong>: 平年値と直近12か月平均のどちらも下回っている品目を「割安（買い時）」と判定しています。</li>
</ul>

<h2>本番運用で想定するデータソース</h2>
<p>本システムは日本国内の卸売・小売の青果価格（e-Stat / 農林水産省 食品価格動向調査 等、
政府標準利用規約に基づき出典表示のうえ二次利用可能）を本番のデータソースとして想定して設計されています。
データソースはアダプタ方式で差し替え可能です。詳細はリポジトリの <code>docs/data-sources.md</code> を参照してください。</p>

<h2>免責事項</h2>
<p>掲載する価格は国際市況等に基づく参考値であり、特定地域の店頭価格や実際の取引価格を保証するものではありません。
本サイトの情報を用いて行う一切の判断・行為について、運営者は責任を負いません。</p>

<h2>広告・アフィリエイトについて</h2>
<p>本サイトは第三者配信の広告サービス（Google AdSense 等）およびアフィリエイトプログラムを利用する場合があります（設定時のみ表示）。</p>
`;
  const jsonld = [breadcrumbLd(site, [{ name: 'トップ', url: '/' }, { name: 'データ出典', url: '/about/' }])];
  return renderPage(site, {
    title: 'データ出典・このサイトについて',
    description: `${site.siteName}のデータ出典・ライセンス・自動更新の仕組み・指標の算出方法・免責事項について。`,
    path: '/about/',
    breadcrumb: [{ name: 'トップ', url: '/' }, { name: 'データ出典', url: '/about/' }],
    jsonld,
    updatedLabel,
    body,
  });
}

// ---- assets --------------------------------------------------------------
function ogSvg(site, meta) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#0f2e20"/>
<rect x="0" y="0" width="1200" height="12" fill="#4ecb8b"/>
<text x="80" y="230" font-family="sans-serif" font-size="86" font-weight="700" fill="#ffffff">🥬 ${esc(site.siteName)}</text>
<text x="80" y="320" font-family="sans-serif" font-size="42" fill="#bfe6d2">${esc(site.tagline)}</text>
<text x="80" y="470" font-family="sans-serif" font-size="34" fill="#9fd8bb">最新集計: ${esc(fmtMonth(meta.latestDate))}／${esc(String(meta.itemCount))}品目を毎日自動更新</text>
</svg>`;
}

function sitemap(site, urls, lastmod) {
  const base = site.baseUrl.replace(/\/$/, '');
  const body = urls
    .map(
      (u) =>
        `  <url><loc>${esc(base + u)}</loc><lastmod>${esc(lastmod)}</lastmod><changefreq>daily</changefreq></url>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>`;
}

function robots(site) {
  const base = site.baseUrl.replace(/\/$/, '');
  return `User-agent: *
Allow: /
Sitemap: ${base}/sitemap.xml
`;
}

// ---- main ----------------------------------------------------------------
async function main() {
  const site = await readJson(path.join(CONFIG_DIR, 'site.json'), {});
  const meta = await readJson(path.join(DATA_DIR, 'meta.json'), null);
  const records = await loadItems();

  if (!meta || records.length === 0) {
    throw new Error('build: no data found. Run `npm run fetch` first.');
  }

  const entries = records
    .map((item) => ({ item, stats: computeItemStats(item) }))
    .filter((e) => e.stats);
  // stable order by category then name
  entries.sort((a, b) =>
    a.item.category === b.item.category
      ? a.item.name.localeCompare(b.item.name, 'ja')
      : a.item.category.localeCompare(b.item.category, 'ja')
  );

  const rankings = buildRankings(entries);
  const updatedLabel = fmtDate(new Date().toISOString().slice(0, 10)) + '（自動生成）';

  // clean public (keep dir)
  await fs.rm(PUBLIC_DIR, { recursive: true, force: true });
  await fs.mkdir(PUBLIC_DIR, { recursive: true });

  // assets
  await write('assets/style.css', STYLESHEET);
  await write('assets/og.svg', ogSvg(site, meta));
  await write('.nojekyll', '');

  // pages
  await write('index.html', renderIndex(site, meta, entries, rankings, updatedLabel));
  await write('weekly/index.html', renderWeekly(site, meta, entries, rankings, updatedLabel));
  await write('about/index.html', renderAbout(site, meta, updatedLabel));

  const urls = ['/', '/weekly/', '/about/'];
  for (const e of entries) {
    const rel = `items/${e.item.slug}/index.html`;
    await write(rel, renderItemPage(site, meta, e, updatedLabel));
    urls.push(`/items/${e.item.slug}/`);
  }

  await write('sitemap.xml', sitemap(site, urls, meta.generatedAt.slice(0, 10)));
  await write('robots.txt', robots(site));

  console.log(`[build] ${entries.length} items -> ${urls.length} pages in public/`);
  console.log('[build] done.');
}

main().catch((err) => {
  console.error(`[build] ERROR: ${err.stack || err.message}`);
  process.exit(1);
});
