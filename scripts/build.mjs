#!/usr/bin/env node
// Build static site from data/*.json into public/.
//
// The site is vegetable-first: items whose source is `vegetan` (日本の野菜
// 卸売価格) drive the top page, buy-signal and rankings, while the frozen
// international `commodity` items live on under /archive/ as an explicitly
// labeled long-term archive. Freshness (live vs archive copy/banner) is
// computed PER DATA SOURCE, so veg pages show live "daily update" copy while
// commodity pages honestly show the archive banner on the same build.

import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR, DATA_DIR, DATA_ITEMS_DIR, DATA_RETAIL_DIR, DATA_ESTAT_DIR, PUBLIC_DIR, ASSETS_DIR } from '../src/lib/paths.mjs';
import { renderPage, adSlot, STYLESHEET } from '../src/templates/layout.mjs';
import { computeItemStats, buildRankings } from '../src/lib/stats.mjs';
import { lineChartSvg } from '../src/lib/chart.mjs';
import { esc } from '../src/lib/html.mjs';
import { fmtNum, fmtPct, fmtMonth, fmtDate, trendClass } from '../src/lib/format.mjs';
import { weeklyReport, headline, itemBlurb, retailWeeklyParagraph } from '../src/lib/report.mjs';
import { freshnessCopy } from '../src/lib/freshness.mjs';
import { latestChange, monthsAcross, cityOf } from '../src/lib/retail.mjs';
import { pad2 } from '../src/lib/wareki.mjs';
import { getItemContent } from '../src/content/items.mjs';

const VEGETAN_ATTRIBUTION =
  '出典：独立行政法人農畜産業振興機構『ベジ探』のデータを加工して作成';
const RETAIL_ATTRIBUTION =
  '出典：独立行政法人農畜産業振興機構『ベジ探』のデータを加工して作成（原資料: 農林水産省「食品価格動向調査」）';
const ESTAT_ATTRIBUTION =
  '出典：農林水産省「青果物卸売市場調査」（e-Stat）を加工して作成';
// Honest annual-source label — this data is 年次公表 (not a daily feed), so it
// never gets the archive banner; the annual caveat is stated inline instead.
const estatSurveyLabel = (year) =>
  `農林水産省「青果物卸売市場調査」${year}年調査（年次公表）`;

// Cities covered by the monthly retail survey, in a rough north→south display
// order. `national` (全国) is carried in the data for overviews but has no page.
const RETAIL_CITY_ORDER = [
  'sapporo', 'sendai', 'tokyo', 'kanazawa', 'nagoya',
  'osaka', 'hiroshima', 'takamatsu', 'fukuoka',
];

// "YYYY-MM-01" -> "6月" (compact month column header).
function fmtMonthCol(date) {
  const m = Number(String(date).split('-')[1]);
  return `${m}月`;
}

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

async function loadRetail() {
  let files = [];
  try {
    files = (await fs.readdir(DATA_RETAIL_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const recs = [];
  for (const f of files) {
    const rec = await readJson(path.join(DATA_RETAIL_DIR, f), null);
    if (rec && Array.isArray(rec.cities) && rec.cities.length) recs.push(rec);
  }
  return recs;
}

async function loadEstat() {
  let files = [];
  try {
    files = (await fs.readdir(DATA_ESTAT_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const recs = [];
  for (const f of files) {
    const rec = await readJson(path.join(DATA_ESTAT_DIR, f), null);
    if (rec && rec.slug && Array.isArray(rec.regionsOrder)) recs.push(rec);
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

function buyBadgeFor(stats) {
  return stats.isBuy
    ? `<span class="badge pill-down">いま買い時</span>`
    : stats.vsNormalPct != null && stats.vsNormalPct > 5
      ? `<span class="badge pill-up">やや割高</span>`
      : `<span class="badge">通常水準</span>`;
}

// ---- Page: vegetable item (daily + long-term monthly, two charts) ---------
function renderVegItemPage(site, meta, entry, updatedLabel, freshness, retailRec, cityList, estatRec) {
  const { item, stats } = entry;
  const s = item.series;
  const monthly = item.monthly || [];
  const canonicalPath = `/items/${item.slug}/`;
  const src = meta.sources.vegetan;

  // Evergreen explainer copy (旬・選び方・保存・価格の動き). Omitted when absent.
  const c = getItemContent(item.slug);
  const explainerSection = c
    ? `
<h2>${esc(item.name)}の選び方・保存・価格の見方</h2>
<div class="explainer">
  <h3>旬と産地の傾向</h3>
  <p>${esc(c.season)}</p>
  <h3>選び方</h3>
  <p>${esc(c.choosing)}</p>
  <h3>保存方法</h3>
  <p>${esc(c.storage)}</p>
  <h3>価格の動きの特徴</h3>
  <p>${esc(c.pricePattern)}</p>
</div>`
    : '';

  const retailSection = renderRetailItemSection(item, retailRec, cityList || []);
  const estatSection = renderEstatSection(estatRec);

  const dailySection = item.hasDaily
    ? `
<h2>日次の卸売価格（直近取得可能範囲）</h2>
${lineChartSvg(s, { ariaLabel: `${item.name}の日次卸売価格推移`, title: `${item.name} 日次`, xFormat: 'md' })}
<p class="lead">対象期間: ${fmtDate(stats.firstDate)} 〜 ${fmtDate(stats.lastDate)}（${stats.pointCount}日分・東京都中央卸売市場）。取得済みの日次データは毎日追記で蓄積されます。</p>`
    : `
<div class="notice">この品目は日次卸売データの対象外のため、月次の価格を掲載しています。</div>`;

  const monthlySection = monthly.length
    ? `
<h2>長期の価格推移（2005年〜・月次）</h2>
${lineChartSvg(monthly, { ariaLabel: `${item.name}の長期月次価格推移`, title: `${item.name} 長期` })}
<p class="lead">対象期間: ${fmtMonth(monthly[0].date)} 〜 ${fmtMonth(monthly[monthly.length - 1].date)}（${monthly.length}か月分）</p>`
    : '';

  const statRow = item.hasDaily
    ? `
  ${statBox(freshness.priceLabel, `${fmtNum(stats.latest.price, 0)}<small> ${esc(item.unit)}</small>`)}
  ${statBox('平年比（当日）', pctCell(stats.vsNormalPct))}
  ${statBox('直近1週間', pctCell(stats.wowPct))}
  ${statBox('前月比（月次）', pctCell(stats.momPct))}
  ${statBox('前年比（月次）', pctCell(stats.yoyPct))}
  ${statBox('平年値（同時期）', `${fmtNum(stats.normal, 0)}<small> ${esc(item.unit)}</small>`)}`
    : `
  ${statBox('最新月の価格', `${fmtNum(stats.latest.price, 0)}<small> ${esc(item.unit)}</small>`)}
  ${statBox('前月比', pctCell(stats.momPct))}
  ${statBox('前年比', pctCell(stats.yoyPct))}
  ${statBox('平年比', pctCell(stats.vsNormalPct))}
  ${statBox('期間高値', fmtNum(stats.max, 0))}
  ${statBox('期間安値', fmtNum(stats.min, 0))}`;

  const body = `
<h1>${item.emoji} ${esc(item.name)}の価格推移 <span class="cat-tag">/ ${esc(item.category)}</span></h1>
<p class="lead">${esc(itemBlurb(item, stats))} ${buyBadgeFor(stats)}</p>

<div class="statgrid">${statRow}
</div>
${dailySection}

${adSlot(site, site.adsenseSlotItem)}
${monthlySection}
${retailSection}
${estatSection}
${explainerSection}

<h2>品目情報</h2>
<table>
  <tr><th>分類</th><td>${esc(item.category)}</td></tr>
  <tr><th>調査対象</th><td>${esc(item.origin)}</td></tr>
  <tr><th>旬・出回り</th><td>${esc(item.season)}</td></tr>
  <tr><th>価格の単位</th><td>${esc(item.unit)}</td></tr>
</table>

<div class="notice">${esc(VEGETAN_ATTRIBUTION)}（原資料: 農林水産省「青果物卸売市場調査（日別調査）」等）。価格は参考値です。</div>
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
      description: `${item.name}の卸売・小売価格の時系列。最新 ${fmtDate(stats.lastDate)}、平年比 ${fmtPct(stats.vsNormalPct)}。`,
      creator: { '@type': 'Organization', name: src.attribution },
      license: src.licenseUrl,
      isAccessibleForFree: true,
      temporalCoverage: `${stats.monthlyFirst || stats.firstDate}/${stats.lastDate}`,
      variableMeasured: `価格（${item.unit}）`,
      url: site.baseUrl.replace(/\/$/, '') + canonicalPath,
    },
    breadcrumbLd(site, breadcrumb),
  ];

  return renderPage(site, {
    title: `${item.name}の価格推移・平年比・買い時`,
    description: `${item.name}の最新卸売価格は${fmtNum(stats.latest.price, 0)}${item.unit}（平年比${fmtPct(stats.vsNormalPct)}）。日次と2005年からの長期チャートで買い時をチェック。`,
    path: canonicalPath,
    breadcrumb,
    jsonld,
    updatedLabel,
    freshness,
    body,
  });
}

// ---- Page: commodity (archive) item ---------------------------------------
function renderCommodityItemPage(site, meta, entry, updatedLabel, freshness) {
  const { item, stats } = entry;
  const s = item.series;
  const recent = s.slice(-36);
  const canonicalPath = `/items/${item.slug}/`;
  const src = meta.sources.commodity;

  const body = `
<h1>${item.emoji} ${esc(item.name)}の価格推移 <span class="cat-tag">/ 国際市況アーカイブ・${esc(item.category)}</span></h1>
<p class="lead">${esc(itemBlurb(item, stats))}</p>

<div class="statgrid">
  ${statBox(freshness.priceLabel, `${fmtNum(stats.latest.price)}<small> ${esc(item.unit)}</small>`)}
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
  <tr><th>分類</th><td>国際市況アーカイブ（${esc(item.category)}）</td></tr>
  <tr><th>代表産地・規格</th><td>${esc(item.origin)}</td></tr>
  <tr><th>旬・出回り</th><td>${esc(item.season)}</td></tr>
  <tr><th>価格の単位</th><td>${esc(item.unit)}</td></tr>
  <tr><th>平年値（同月平均）</th><td>${fmtNum(stats.normal)} ${esc(item.unit)}</td></tr>
</table>

<div class="notice">価格は${esc(src.title)}に基づく参考値です。${esc(src.attribution)}。このデータは${esc(freshness.label)}で更新が停止した月次アーカイブです。</div>
`;

  const breadcrumb = [
    { name: 'トップ', url: '/' },
    { name: '国際市況アーカイブ', url: '/archive/' },
    { name: item.name, url: canonicalPath },
  ];

  const jsonld = [
    {
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: `${item.name}の国際市況価格推移（アーカイブ）`,
      description: `${item.name}（${item.origin}）の国際市況価格時系列。${fmtMonth(stats.firstDate)}〜${fmtMonth(stats.lastDate)}の月次アーカイブ。`,
      creator: { '@type': 'Organization', name: src.attribution },
      license: src.licenseUrl,
      isAccessibleForFree: true,
      temporalCoverage: `${stats.firstDate}/${stats.lastDate}`,
      variableMeasured: `価格（${item.unit}）`,
      url: site.baseUrl.replace(/\/$/, '') + canonicalPath,
    },
    breadcrumbLd(site, breadcrumb),
  ];

  return renderPage(site, {
    title: `${item.name}の国際市況価格推移（アーカイブ）`,
    description: `${item.name}の国際市況価格アーカイブ（${fmtMonth(stats.firstDate)}〜${fmtMonth(stats.lastDate)}・月次）。長期の価格推移チャートを掲載。`,
    path: canonicalPath,
    breadcrumb,
    jsonld,
    updatedLabel,
    freshness,
    body,
  });
}

// ---- Retail (都市別小売価格・月次) --------------------------------------------

// City slug -> display name, learned from the data (falls back to slug). Built
// once per build from the loaded retail records.
function buildCityNames(retailRecords) {
  const names = new Map();
  for (const rec of retailRecords) {
    for (const c of rec.cities || []) {
      if (c.citySlug && c.cityName && !names.has(c.citySlug)) names.set(c.citySlug, c.cityName);
    }
  }
  return names;
}

// Ordered list of {citySlug, cityName} that actually appear in the data,
// excluding the全国 aggregate (which has no page).
function retailCityList(retailRecords) {
  const names = buildCityNames(retailRecords);
  const present = new Set();
  for (const rec of retailRecords) for (const c of rec.cities || []) present.add(c.citySlug);
  const ordered = RETAIL_CITY_ORDER.filter((s) => present.has(s));
  // Append any city seen in data but missing from the display order, so nothing
  // is silently dropped if the survey adds a city.
  for (const s of present) if (s !== 'national' && !ordered.includes(s)) ordered.push(s);
  return ordered.map((citySlug) => ({ citySlug, cityName: names.get(citySlug) || citySlug }));
}

// Section embedded on a vegetable item page: this item's price across cities.
function renderRetailItemSection(item, retailRec, cityList) {
  if (!retailRec) return '';
  const months = monthsAcross(retailRec.cities.map((c) => c.series));
  if (months.length === 0) return '';
  const bySlug = new Map(retailRec.cities.map((c) => [c.citySlug, c]));

  const rows = [...cityList, { citySlug: 'national', cityName: '全国' }]
    .map(({ citySlug, cityName }) => {
      const c = bySlug.get(citySlug);
      if (!c) return '';
      const byDate = new Map(c.series.map((p) => [p.date, p.price]));
      const cells = months
        .map((d) => `<td class="num">${byDate.has(d) ? fmtNum(byDate.get(d), 0) : '—'}</td>`)
        .join('');
      const lc = latestChange(c.series);
      const label =
        citySlug === 'national'
          ? '<strong>全国</strong>'
          : `<a href="/retail/${esc(citySlug)}/">${esc(cityName)}</a>`;
      return `<tr><th scope="row">${label}</th>${cells}<td class="num">${pctCell(lc && lc.momPct)}</td></tr>`;
    })
    .join('');

  const head = months.map((d) => `<th class="num">${esc(fmtMonthCol(d))}</th>`).join('');
  return `
<h2>都市別の小売価格（月次調査）</h2>
<p class="lead">主要都市の店頭小売価格（円/kg）の推移です。卸売価格とは異なり、消費者が実際に買う価格の目安になります。数値は月次の調査値で、末尾の「前月比」は各都市の直近月の変化です。</p>
<div style="overflow-x:auto">
<table>
  <thead><tr><th>都市</th>${head}<th class="num">前月比</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</div>
<p class="lead">都市ごとの全品目一覧は<a href="/retail/">小売価格ページ</a>から確認できます。</p>
<div class="notice">${esc(RETAIL_ATTRIBUTION)}。小売価格は月次の調査値であり、店頭の実売価格を保証するものではありません。</div>`;
}

// Items where this city's latest price is below the全国 latest for the same
// item (＝相対的に割安), most-under first.
function cheapVsNational(retailRecords, citySlug) {
  const out = [];
  for (const rec of retailRecords) {
    const c = cityOf(rec, citySlug);
    const nat = cityOf(rec, 'national');
    if (!c || !nat) continue;
    const cl = latestChange(c.series);
    const nl = latestChange(nat.series);
    if (!cl || !nl || !nl.price || cl.date !== nl.date) continue;
    out.push({ rec, cityLatest: cl, vsNat: ((cl.price - nl.price) / nl.price) * 100 });
  }
  return out.filter((x) => x.vsNat < 0).sort((a, b) => a.vsNat - b.vsNat);
}

function renderRetailCityPage(site, meta, city, retailRecords, updatedLabel, freshness) {
  const { citySlug, cityName } = city;
  const canonicalPath = `/retail/${citySlug}/`;
  const src = meta.sources.retail;

  // Item rows: latest price + 前月比 + the month columns.
  const withData = retailRecords
    .map((rec) => ({ rec, city: cityOf(rec, citySlug) }))
    .filter((x) => x.city && x.city.series.length);
  const months = monthsAcross(withData.map((x) => x.city.series));

  const head = months.map((d) => `<th class="num">${esc(fmtMonthCol(d))}</th>`).join('');
  const rows = withData
    .map(({ rec, city: c }) => {
      const byDate = new Map(c.series.map((p) => [p.date, p.price]));
      const cells = months
        .map((d) => `<td class="num">${byDate.has(d) ? fmtNum(byDate.get(d), 0) : '—'}</td>`)
        .join('');
      const lc = latestChange(c.series);
      return `<tr><th scope="row"><a href="/items/${esc(rec.slug)}/">${rec.emoji} ${esc(rec.name)}</a></th>${cells}<td class="num">${pctCell(lc && lc.momPct)}</td></tr>`;
    })
    .join('');

  const cheap = cheapVsNational(retailRecords, citySlug).slice(0, 6);
  const cheapCards = cheap.length
    ? `<div class="grid cards">${cheap
        .map(
          (x) => `<a class="card item-card" href="/items/${esc(x.rec.slug)}/">
        <span class="em">${x.rec.emoji}</span>
        <span class="nm">${esc(x.rec.name)}</span>
        <span class="px">${fmtNum(x.cityLatest.price, 0)} <small>円/kg</small></span>
        <span class="down">全国平均比 ${fmtPct(x.vsNat)}</span>
      </a>`
        )
        .join('')}</div>`
    : `<p class="lead">直近の調査では、${esc(cityName)}で全国平均を下回った品目はありませんでした。</p>`;

  const latestMonth = months.length ? fmtMonth(months[months.length - 1]) : '—';
  const otherCities = retailCityList(retailRecords).filter((c) => c.citySlug !== citySlug);

  const body = `
<h1>${esc(cityName)}の野菜小売価格 <span class="cat-tag">/ 月次調査</span></h1>
<p class="lead">${esc(cityName)}における主要野菜${withData.length}品目の店頭小売価格（円/kg）です。最新の調査は${esc(latestMonth)}。全国平均と比べて割安な品目もチェックできます。</p>

<h2><span class="dot dot-buy"></span>${esc(cityName)}でいま割安な品目（全国平均比）</h2>
<p class="lead">最新調査月で、${esc(cityName)}の小売価格が全国平均を下回っている品目です。</p>
${cheapCards}

${adSlot(site, site.adsenseSlotItem)}

<h2>品目別の小売価格（月次）</h2>
<div style="overflow-x:auto">
<table>
  <thead><tr><th>品目</th>${head}<th class="num">前月比</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</div>

<h2>ほかの都市</h2>
<div class="grid cards">${otherCities
    .map(
      (c) => `<a class="card item-card" href="/retail/${esc(c.citySlug)}/"><span class="nm">${esc(c.cityName)}</span></a>`
    )
    .join('')}</div>

<div class="notice">${esc(RETAIL_ATTRIBUTION)}。掲載価格は月次の調査値であり、店頭の実売価格を保証するものではありません。</div>
`;

  const breadcrumb = [
    { name: 'トップ', url: '/' },
    { name: '小売価格', url: '/retail/' },
    { name: cityName, url: canonicalPath },
  ];
  const jsonld = [
    {
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: `${cityName}の野菜小売価格`,
      description: `${cityName}における主要野菜の月次小売価格（円/kg）。最新 ${latestMonth}。`,
      creator: { '@type': 'Organization', name: src.attribution },
      license: src.licenseUrl,
      isAccessibleForFree: true,
      temporalCoverage: months.length ? `${months[0]}/${months[months.length - 1]}` : undefined,
      variableMeasured: '小売価格（円/kg）',
      url: site.baseUrl.replace(/\/$/, '') + canonicalPath,
    },
    breadcrumbLd(site, breadcrumb),
  ];

  return renderPage(site, {
    title: `${cityName}の野菜小売価格`,
    description: `${cityName}の主要野菜${withData.length}品目の月次小売価格（円/kg）。全国平均と比べて割安な品目、品目別の価格推移を掲載。`,
    path: canonicalPath,
    breadcrumb,
    jsonld,
    updatedLabel,
    freshness,
    body,
  });
}

function renderRetailIndex(site, meta, retailRecords, cityList, updatedLabel, freshness) {
  const src = meta.sources.retail;
  // National overview table: latest全国 price + 前月比 per item.
  const overview = retailRecords
    .map((rec) => ({ rec, nat: cityOf(rec, 'national') }))
    .filter((x) => x.nat && x.nat.series.length)
    .map((x) => ({ rec: x.rec, lc: latestChange(x.nat.series) }));
  const latestMonth = overview.length
    ? fmtMonth(
        overview
          .map((o) => o.lc.date)
          .sort()
          .slice(-1)[0]
      )
    : '—';

  const overviewRows = overview
    .map(
      (o) =>
        `<tr><th scope="row"><a href="/items/${esc(o.rec.slug)}/">${o.rec.emoji} ${esc(o.rec.name)}</a></th><td class="num">${fmtNum(o.lc.price, 0)}<small> 円/kg</small></td><td class="num">${pctCell(o.lc.momPct)}</td></tr>`
    )
    .join('');

  const cityCards = cityList
    .map(
      (c) => `<a class="card item-card" href="/retail/${esc(c.citySlug)}/">
        <span class="nm">${esc(c.cityName)}</span>
        <span class="down">小売価格を見る →</span>
      </a>`
    )
    .join('');

  const body = `
<h1>都市別の野菜小売価格（月次調査）</h1>
<p class="lead">${esc(retailWeeklyParagraph(retailRecords, cityList))}</p>
<div class="notice">最新の調査月: <strong>${esc(latestMonth)}</strong>／対象 ${cityList.length} 都市・${overview.length} 品目。これは<strong>月次</strong>の小売価格調査で、卸売価格（日次）とは別の指標です。</div>

<h2>都市を選ぶ</h2>
<div class="grid cards">${cityCards}</div>

${adSlot(site, site.adsenseSlotTop)}

<h2>全国平均の小売価格（最新月）</h2>
<div style="overflow-x:auto">
<table>
  <thead><tr><th>品目</th><th class="num">全国平均</th><th class="num">前月比</th></tr></thead>
  <tbody>${overviewRows}</tbody>
</table>
</div>

<h2>卸売価格もチェック</h2>
<p class="lead">市場での日次の卸売価格や「いまが買い時」の野菜は<a href="/">トップページ</a>で毎日更新しています。</p>

<div class="notice">${esc(RETAIL_ATTRIBUTION)}。掲載価格は月次の調査値であり、店頭の実売価格を保証するものではありません。</div>
`;

  const breadcrumb = [
    { name: 'トップ', url: '/' },
    { name: '小売価格', url: '/retail/' },
  ];
  const jsonld = [
    {
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: '都市別の野菜小売価格（月次調査）',
      description: `全国主要${cityList.length}都市の野菜小売価格（円/kg・月次）。最新 ${latestMonth}。`,
      creator: { '@type': 'Organization', name: src.attribution },
      license: src.licenseUrl,
      isAccessibleForFree: true,
      variableMeasured: '小売価格（円/kg）',
      url: site.baseUrl.replace(/\/$/, '') + '/retail/',
    },
    breadcrumbLd(site, breadcrumb),
  ];

  return renderPage(site, {
    title: '都市別の野菜小売価格（月次調査）',
    description: `全国主要${cityList.length}都市の野菜小売価格（円/kg・月次）。都市別ページ、全国平均、品目別の価格推移を掲載。最新 ${latestMonth}。`,
    path: '/retail/',
    breadcrumb,
    jsonld,
    updatedLabel,
    freshness,
    body,
  });
}

// ---- e-Stat (青果物卸売市場調査・年次) 共通レンダリング --------------------------

// National monthly series as chart points ("YYYY-MM-01").
function estatNationalSeries(rec) {
  return (rec.national || []).map((p) => ({ date: `${rec.year}-${pad2(p.month)}-01`, price: p.price }));
}

// Top-5 origin share as horizontal bars (widths relative to the top origin).
function estatOriginBars(rec) {
  const origins = rec.origins || [];
  if (!origins.length) return '';
  const maxShare = Math.max(...origins.map((o) => o.share || 0)) || 1;
  const rows = origins
    .map((o) => {
      const pct = o.share != null ? o.share * 100 : 0;
      const w = ((o.share || 0) / maxShare) * 100;
      return `<div class="obar"><span class="nm">${esc(o.name)}</span><span class="track"><span class="fill" style="width:${w.toFixed(1)}%"></span></span><span class="pc">${o.share != null ? `${pct.toFixed(1)}%` : '—'}</span></div>`;
    })
    .join('');
  return `<div class="obars">${rows}</div>`;
}

// 消費地域（市場）× 月 の卸売価格テーブル（末尾に全国加重平均行）。
function estatRegionTable(rec) {
  const months = (rec.national || []).map((p) => p.month);
  if (!months.length || !rec.regionsOrder.length) return '';
  const head = months.map((m) => `<th class="num">${m}月</th>`).join('');
  const rows = rec.regionsOrder
    .map((name) => {
      const byMonth = new Map((rec.regions[name] || []).map((p) => [p.month, p.price]));
      const cells = months
        .map((m) => `<td class="num">${byMonth.get(m) != null ? fmtNum(byMonth.get(m), 0) : '—'}</td>`)
        .join('');
      return `<tr><th scope="row">${esc(name)}</th>${cells}</tr>`;
    })
    .join('');
  const nat = new Map((rec.national || []).map((p) => [p.month, p.price]));
  const natCells = months
    .map((m) => `<td class="num">${nat.get(m) != null ? fmtNum(nat.get(m), 0) : '—'}</td>`)
    .join('');
  return `<div style="overflow-x:auto">
<table>
  <thead><tr><th>消費地域</th>${head}</tr></thead>
  <tbody>${rows}<tr><th scope="row"><strong>全国（加重平均）</strong></th>${natCells}</tr></tbody>
</table>
</div>`;
}

// Evergreen explainer block (shared by veg and fruit item pages).
function explainerBlock(slug, name) {
  const c = getItemContent(slug);
  if (!c) return '';
  return `
<h2>${esc(name)}の選び方・保存・価格の見方</h2>
<div class="explainer">
  <h3>旬と産地の傾向</h3>
  <p>${esc(c.season)}</p>
  <h3>選び方</h3>
  <p>${esc(c.choosing)}</p>
  <h3>保存方法</h3>
  <p>${esc(c.storage)}</p>
  <h3>価格の動きの特徴</h3>
  <p>${esc(c.pricePattern)}</p>
</div>`;
}

// Section embedded on a vegetable item page: 産地シェア + 消費地域別価格（政府統計）.
function renderEstatSection(rec) {
  if (!rec) return '';
  const top = rec.origins && rec.origins[0];
  const intro =
    top && top.share != null
      ? `${rec.year}年の調査では、${rec.name}の入荷量は${top.name}産が最も多く、全国の約${Math.round(top.share * 100)}%を占めます。`
      : `${rec.year}年調査の産地別・消費地域別の卸売データです。`;
  return `
<h2>産地と地域別の卸売価格（政府統計）</h2>
<p class="lead">${esc(intro)}以下は${esc(estatSurveyLabel(rec.year))}にもとづく、主要産地の年間入荷量シェアと、消費地域（卸売市場）別の月別卸売価格です。日次のベジ探価格とは調査・時点が異なる、年に一度の確報値です。</p>
<h3>主な産地（年間入荷量シェア・上位5）</h3>
${estatOriginBars(rec)}
<h3>消費地域別の月別卸売価格（円/kg・${rec.year}年）</h3>
${estatRegionTable(rec)}
<div class="notice estat-note">${esc(ESTAT_ATTRIBUTION)}。${esc(estatSurveyLabel(rec.year))}の確報値です。</div>`;
}

// Standalone item page driven by e-Stat data (fruits + estat-only 果菜).
function renderEstatItemPage(site, meta, rec, updatedLabel, estatFresh) {
  const canonicalPath = `/items/${rec.slug}/`;
  const src = meta.sources.estat || {};
  const series = estatNationalSeries(rec);
  const prices = series.map((p) => p.price).filter((v) => v != null);
  const avg = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null;
  const hi = prices.length ? Math.max(...prices) : null;
  const lo = prices.length ? Math.min(...prices) : null;
  const top = rec.origins && rec.origins[0];

  const body = `
<h1>${rec.emoji} ${esc(rec.name)}の卸売価格・産地 <span class="cat-tag">/ ${esc(rec.category)}</span></h1>
<p class="lead">${esc(estatSurveyLabel(rec.year))}にもとづく、${esc(rec.name)}の産地別シェアと消費地域別の月別卸売価格です。${top && top.share != null ? `主産地は${esc(top.name)}（全国の約${Math.round(top.share * 100)}%）。` : ''}</p>

<div class="statgrid">
  ${statBox('年間平均卸売価格', avg != null ? `${fmtNum(avg, 0)}<small> 円/kg</small>` : '—')}
  ${statBox('月別の高値', hi != null ? `${fmtNum(hi, 0)}<small> 円/kg</small>` : '—')}
  ${statBox('月別の安値', lo != null ? `${fmtNum(lo, 0)}<small> 円/kg</small>` : '—')}
  ${statBox('主産地', top ? esc(top.name) : '—')}
  ${statBox('対象年', `${rec.year}年`)}
</div>

<h2>月別の卸売価格（全国加重平均・${rec.year}年）</h2>
${lineChartSvg(series, { ariaLabel: `${rec.name}の月別卸売価格推移`, title: `${rec.name} 月別` })}
<p class="lead">主要消費地域（卸売市場）の入荷量で加重平均した、${rec.year}年の月別卸売価格（円/kg）です。</p>

${adSlot(site, site.adsenseSlotItem)}

<h2>主な産地（年間入荷量シェア・上位5）</h2>
${estatOriginBars(rec)}

<h2>消費地域別の月別卸売価格（円/kg・${rec.year}年）</h2>
${estatRegionTable(rec)}
${explainerBlock(rec.slug, rec.name)}

<h2>品目情報</h2>
<table>
  <tr><th>分類</th><td>${esc(rec.category)}</td></tr>
  <tr><th>主産地</th><td>${top ? esc(top.name) : '—'}</td></tr>
  <tr><th>価格の単位</th><td>${esc(rec.priceUnit || '円/kg')}</td></tr>
  <tr><th>調査</th><td>${esc(estatSurveyLabel(rec.year))}</td></tr>
</table>

<div class="notice estat-note">${esc(ESTAT_ATTRIBUTION)}。${esc(estatSurveyLabel(rec.year))}の確報値であり、価格は参考値です。日次の市況を示すものではありません。</div>
`;

  const breadcrumb = [
    { name: 'トップ', url: '/' },
    { name: '果実・産地データ', url: '/#fruits' },
    { name: rec.name, url: canonicalPath },
  ];
  const jsonld = [
    {
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: `${rec.name}の産地別・消費地域別の卸売価格（${rec.year}年）`,
      description: `${rec.name}の${rec.year}年の産地別入荷量シェアと消費地域別の月別卸売価格（円/kg）。${estatSurveyLabel(rec.year)}。`,
      creator: { '@type': 'Organization', name: src.attribution || ESTAT_ATTRIBUTION },
      license: src.licenseUrl,
      isAccessibleForFree: true,
      temporalCoverage: `${rec.year}-01/${rec.year}-12`,
      variableMeasured: '卸売価格（円/kg）・入荷量（t）',
      url: site.baseUrl.replace(/\/$/, '') + canonicalPath,
    },
    breadcrumbLd(site, breadcrumb),
  ];

  return renderPage(site, {
    title: `${rec.name}の卸売価格・産地（${rec.year}年・政府統計）`,
    description: `${rec.name}の${rec.year}年の産地別シェアと消費地域別の月別卸売価格（円/kg）。${top ? `主産地は${top.name}。` : ''}農林水産省「青果物卸売市場調査」（e-Stat）を加工。`,
    path: canonicalPath,
    breadcrumb,
    jsonld,
    updatedLabel,
    freshness: estatFresh,
    body,
  });
}

// Top-page section: fruit (+ estat-only) cards grouped by category.
function estatTopSection(records) {
  if (!records.length) return '';
  const byCat = new Map();
  for (const r of records) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push(r);
  }
  const cats = [...byCat.keys()].sort((a, b) =>
    a === '果実' ? -1 : b === '果実' ? 1 : a.localeCompare(b, 'ja')
  );
  const sections = cats
    .map((cat) => {
      const list = byCat.get(cat).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
      const cards = list
        .map((r) => {
          const nat = r.national || [];
          const avg = nat.length ? Math.round(nat.reduce((a, p) => a + p.price, 0) / nat.length) : null;
          const top = r.origins && r.origins[0];
          return `<a class="card item-card" href="/items/${esc(r.slug)}/">
        <span class="em">${r.emoji}</span>
        <span class="nm">${esc(r.name)}</span>
        <span class="px">${avg != null ? fmtNum(avg, 0) : '—'} <small>円/kg</small></span>
        <span class="flat">${top ? esc(`主産地 ${top.name}`) : ''}</span>
      </a>`;
        })
        .join('');
      return `<h3>${esc(cat)}</h3><div class="grid cards">${cards}</div>`;
    })
    .join('');
  const year = records[0].year;
  return `
<h2 id="fruits">果実の卸売価格と産地（政府統計・年次）</h2>
<p class="lead">農林水産省「青果物卸売市場調査」（e-Stat）の最新公表年（${year}年）をもとにした、果実などの産地別シェアと消費地域別の卸売価格です。日次更新のベジ探とは異なり、年に一度公表される確報値です。</p>
${sections}
<div class="notice estat-note">${esc(ESTAT_ATTRIBUTION)}</div>`;
}

// Self-drawn hero illustration: a rounded market panel with a price line
// dipping to a highlighted "買い時" (buy) point, plus two understated produce
// motifs. Colors come from the CSS accent vars, so it adapts to light/dark.
// Kept intentionally light (~1KB) to respect the per-page size budget.
function heroSvg() {
  return `<svg class="hero-svg" viewBox="0 0 420 300" role="img" aria-label="卸売価格の推移と買い時のイメージ図">
  <rect class="hs-panel" x="8" y="8" width="404" height="284" rx="18"/>
  <line class="hs-grid" x1="30" y1="98" x2="392" y2="98"/>
  <line class="hs-grid" x1="30" y1="158" x2="392" y2="158"/>
  <line class="hs-grid" x1="30" y1="218" x2="392" y2="218"/>
  <path class="hs-area" d="M40 118 L100 100 L155 146 L210 126 L265 180 L320 216 L376 192 L376 252 L40 252 Z"/>
  <path class="hs-line" d="M40 118 L100 100 L155 146 L210 126 L265 180 L320 216 L376 192"/>
  <circle class="hs-ring" cx="320" cy="216" r="11"/>
  <circle class="hs-dot" cx="320" cy="216" r="5"/>
  <rect class="hs-tag" x="290" y="172" width="60" height="24" rx="7"/>
  <text class="hs-tag-t" x="320" y="188" text-anchor="middle">買い時</text>
  <g transform="translate(72 60)">
    <path class="hs-leaf" d="M-2 -17 C6 -22 15 -18 15 -18 C15 -10 8 -6 0 -9 Z"/>
    <circle class="hs-fruit" cx="0" cy="3" r="15"/>
  </g>
  <g transform="translate(352 58)">
    <circle class="hs-fruit" cx="0" cy="0" r="14" opacity="0.92"/>
    <path class="hs-fruit-v" d="M0 -14 A14 14 0 0 1 0 14"/>
  </g>
</svg>`;
}

// Small line-art icons for the "できること" cards (accent stroke, dark-mode safe).
const USE_ICONS = {
  buy: `<svg class="use-ico" viewBox="0 0 24 24" aria-hidden="true"><path class="uc-stroke" d="M3 8l5 4 3-2 4 4"/><circle class="uc-stroke" cx="15" cy="14" r="0.6"/><path class="uc-stroke" d="M15 18v2M11 20h8"/></svg>`,
  trend: `<svg class="use-ico" viewBox="0 0 24 24" aria-hidden="true"><path class="uc-stroke" d="M4 4v16h16"/><path class="uc-stroke" d="M7 15l3-4 3 2 5-7"/></svg>`,
  origin: `<svg class="use-ico" viewBox="0 0 24 24" aria-hidden="true"><path class="uc-stroke" d="M12 21s6-5.4 6-10a6 6 0 10-12 0c0 4.6 6 10 6 10Z"/><circle class="uc-stroke" cx="12" cy="11" r="2.2"/></svg>`,
};

function useCard(ico, title, desc, linkText, href) {
  return `<div class="use-card">
    ${ico}
    <h3>${esc(title)}</h3>
    <p>${esc(desc)}</p>
    <a class="use-link" href="${href}">${esc(linkText)} →</a>
  </div>`;
}

// Hero + "できること" + honest data disclosure — the top-of-page framing that
// tells a first-time visitor what this site is and how to use it.
function renderIntro(site, meta, vegEntries) {
  const hero = `
<section class="hero">
  <div class="hero-copy">
    <span class="hero-eyebrow">全国の卸売市場データを毎日更新</span>
    <h1 class="hero-title">野菜と果物の<span class="accent">買い時</span>が、<br>ひと目でわかる。</h1>
    <p class="hero-sub">公的な市場データから、いま平年より安い品目・価格の推移・産地の相場を毎日自動で集計。今週の献立にも、お店の仕入れにも役立つ、登録不要の無料サイトです。</p>
    <div class="hero-cta">
      <a class="btn btn-primary" href="#buy">今週の買い時を見る</a>
      <a class="btn btn-ghost" href="#items">品目一覧</a>
    </div>
    <p class="hero-meta">最新集計 <strong>${fmtDate(meta.latestDate)}</strong>　・　野菜${vegEntries.length}品目＋果実データ　・　完全無料</p>
  </div>
  <div class="hero-art">${heroSvg()}</div>
</section>`;

  const cards = [
    useCard(USE_ICONS.buy, '今週の買い時がわかる', '当日の卸売価格が平年より割安な品目をピックアップ。毎日の献立や、飲食店・八百屋の仕入れの判断に。', '買い時を見る', '#buy'),
    useCard(USE_ICONS.trend, '価格の推移と旬がわかる', '品目ごとの日次・長期の価格チャートに、選び方・保存・旬のポイントを添えて掲載しています。', '品目一覧を見る', '#items'),
    useCard(USE_ICONS.origin, '産地・地域別の相場がわかる', '主要産地の入荷量シェアと、消費地域（卸売市場）別の月別卸売価格を政府統計から掲載。', '産地データを見る', '#fruits'),
  ].join('');

  const about = `
<section class="about-block">
  <h2>${esc(site.siteName)}でできること</h2>
  <p class="lead">全国の卸売市場で取引される野菜・果物の価格を、公的なオープンデータから毎日自動で集計し、無料で公開しています。難しい登録は不要。気になる品目の「いま」と「これまで」がすぐに分かります。</p>
  <div class="grid use-grid">${cards}</div>
  <p class="more-links">このほか、<a href="/retail/">都市別の小売価格</a>や<a href="/weekly/">今週の値動きレポート</a>もご覧いただけます。</p>
  <div class="notice">
    価格データは3つの公的な出典にもとづいています。<strong>①日次の卸売価格</strong>（独立行政法人農畜産業振興機構「ベジ探」。原資料は農林水産省の卸売市場調査）／<strong>②都市別の小売価格</strong>（同・月次調査）／<strong>③産地・地域別の卸売価格</strong>（農林水産省「青果物卸売市場調査」・e-Stat。年次の確報値）。卸売価格は市場での公表まで数営業日ほどかかるため直近数日は反映が遅れることがあり、産地別データは最新の公表年をもとにしています。更新は毎日自動で行っているため、人手をかけずに最新の数値を反映しています。
  </div>
</section>`;

  return hero + about;
}

// ---- Page: index (vegetable-first) ----------------------------------------
function renderIndex(site, meta, vegEntries, rankings, updatedLabel, freshness, estatStandalone = []) {
  const byCat = new Map();
  for (const e of vegEntries) {
    if (!byCat.has(e.item.category)) byCat.set(e.item.category, []);
    byCat.get(e.item.category).push(e);
  }

  const buyCards = rankings.buys.length
    ? `<div class="grid cards">${rankings.buys
        .map(
          (e) => `<a class="card item-card" href="/items/${e.item.slug}/">
        <span class="em">${e.item.emoji}</span>
        <span class="nm">${esc(e.item.name)}</span>
        <span class="px">${fmtNum(e.stats.latest.price, 0)} <small>${esc(e.item.unit)}</small></span>
        <span class="down">平年比 ${fmtPct(e.stats.vsNormalPct)}</span>
      </a>`
        )
        .join('')}</div>`
    : `<p class="lead">現在、平年比が買い時ライン（平年より10%以上割安）に達した野菜はありません。</p>`;

  const rankList = (list, cls) =>
    `<ul class="rank-list">${list
      .map(
        (e) =>
          `<li><a href="/items/${e.item.slug}/">${e.item.emoji} ${esc(e.item.name)}</a><span class="${cls}">${fmtPct(e.stats.rankPct)}</span></li>`
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
          <span class="px">${fmtNum(e.stats.latest.price, 0)} <small>${esc(e.item.unit)}</small></span>
          <span class="${trendClass(e.stats.vsNormalPct)}">平年比 ${fmtPct(e.stats.vsNormalPct)}</span>
        </a>`
      )
      .join('')}</div>`
    )
    .join('');

  const body = `
${renderIntro(site, meta, vegEntries)}

<h2 id="buy"><span class="dot dot-buy"></span>いまが買い時の野菜</h2>
<p class="lead">${esc(headline(meta, rankings))}</p>
<p class="lead">当日の卸売価格が平年（過去5か年の同時期平均）を10%以上下回っている、いま割安な野菜です。</p>
<div class="notice">最新集計: <strong>${fmtDate(meta.latestDate)}</strong>／対象 ${vegEntries.length} 品目（東京都中央卸売市場ほか）。${esc(freshness.updateNotice)}</div>
${buyCards}

${adSlot(site, site.adsenseSlotTop)}

<h2>値上がり・値下がりランキング（日次・直近1週間）</h2>
<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
  <div class="card"><h3 class="up">▲ 値上がり</h3>${rankList(rankings.risers, 'up')}</div>
  <div class="card"><h3 class="down">▼ 値下がり</h3>${rankList(rankings.fallers, 'down')}</div>
</div>

<h2 id="items">品目一覧</h2>
${catSections}

${estatTopSection(estatStandalone)}

<h2>国際市況アーカイブ</h2>
<p class="lead">バナナ・小麦・コーヒーなど食品コモディティ26品目の国際市況（1980〜2017年・月次）の長期アーカイブも<a href="/archive/">こちら</a>で公開しています。</p>

<div class="notice">${esc(VEGETAN_ATTRIBUTION)}</div>
`;

  const jsonld = [
    {
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: site.siteName,
      description: site.description,
      creator: { '@type': 'Organization', name: meta.sources.vegetan.attribution },
      license: meta.sources.vegetan.licenseUrl,
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
    freshness,
    body,
  });
}

// ---- Page: archive index (commodity) ---------------------------------------
function renderArchiveIndex(site, meta, entries, updatedLabel, freshness) {
  const src = meta.sources.commodity;
  const byCat = new Map();
  for (const e of entries) {
    if (!byCat.has(e.item.category)) byCat.set(e.item.category, []);
    byCat.get(e.item.category).push(e);
  }
  const catSections = [...byCat.entries()]
    .map(
      ([cat, list]) => `<h3>${esc(cat)}</h3>
    <div class="grid cards">${list
      .map(
        (e) => `<a class="card item-card" href="/items/${e.item.slug}/">
          <span class="em">${e.item.emoji}</span>
          <span class="nm">${esc(e.item.name)}</span>
          <span class="px">${fmtNum(e.stats.latest.price)} <small>${esc(e.item.unit)}</small></span>
        </a>`
      )
      .join('')}</div>`
    )
    .join('');

  const body = `
<h1>国際市況アーカイブ（食品コモディティ）</h1>
<p class="lead">バナナ・穀物・食用油・畜産・水産・嗜好品など食品コモディティ${entries.length}品目の国際市況価格（1980〜${freshness.label}・月次）の長期アーカイブです。データソースの更新は${freshness.label}で停止しており、掲載価格は変動しません。</p>
${catSections}
<div class="notice">出典: ${esc(src.attribution)}（ライセンス: ${esc(src.license)}）。本アーカイブは参考資料であり、現在の市況を示すものではありません。最新の野菜価格は<a href="/">トップページ</a>をご覧ください。</div>
`;

  const breadcrumb = [
    { name: 'トップ', url: '/' },
    { name: '国際市況アーカイブ', url: '/archive/' },
  ];
  const jsonld = [breadcrumbLd(site, breadcrumb)];
  return renderPage(site, {
    title: '国際市況アーカイブ（食品コモディティ・1980〜2017）',
    description: `食品コモディティ${entries.length}品目の国際市況価格アーカイブ（月次・${freshness.label}まで）。長期の価格推移チャートを品目別に掲載。`,
    path: '/archive/',
    breadcrumb,
    jsonld,
    updatedLabel,
    freshness,
    body,
  });
}

// ---- Page: weekly ----------------------------------------------------------
function renderWeekly(site, meta, entries, rankings, updatedLabel, freshness, retailRecords, cityList) {
  const rep = weeklyReport(meta, entries, rankings, freshness);
  // Append a machine-generated paragraph on the monthly city retail survey.
  const retailPara = retailWeeklyParagraph(retailRecords || [], cityList || []);
  if (retailPara) rep.paragraphs = [...rep.paragraphs, retailPara];
  const movers = [...rankings.risers.slice(0, 3), ...rankings.fallers.slice(0, 3)];
  const body = `
<h1>${esc(rep.title)}</h1>
<p class="lead">市場データをもとに自動でまとめた、野菜価格の週次レポートです（${fmtDate(meta.latestDate)}時点）。</p>
<div class="report">${rep.paragraphs.map((t) => `<p>${esc(t)}</p>`).join('')}</div>

${adSlot(site, site.adsenseSlotTop)}

<h2>主な値動き</h2>
<table>
  <thead><tr><th>品目</th><th class="num">${esc(freshness.priceLabel)}</th><th class="num">直近の変化</th><th class="num">平年比</th></tr></thead>
  <tbody>${movers
    .map(
      (e) =>
        `<tr><td><a href="/items/${e.item.slug}/">${e.item.emoji} ${esc(e.item.name)}</a></td><td class="num">${fmtNum(e.stats.latest.price, 0)}</td><td class="num">${pctCell(e.stats.rankPct)}</td><td class="num">${pctCell(e.stats.vsNormalPct)}</td></tr>`
    )
    .join('')}</tbody>
</table>
<div class="notice">${esc(VEGETAN_ATTRIBUTION)}</div>
`;
  const jsonld = [breadcrumbLd(site, [{ name: 'トップ', url: '/' }, { name: '週報', url: '/weekly/' }])];
  return renderPage(site, {
    title: rep.title,
    description: `${fmtMonth(meta.latestDate)}の野菜価格まとめ。値上がり・値下がり・買い時の野菜を自動集計したレポートです。`,
    path: '/weekly/',
    breadcrumb: [{ name: 'トップ', url: '/' }, { name: '週報', url: '/weekly/' }],
    jsonld,
    updatedLabel,
    freshness,
    body,
  });
}

// ---- Page: about ------------------------------------------------------------
function renderAbout(site, meta, updatedLabel, freshnessBySource) {
  const veg = meta.sources.vegetan;
  const com = meta.sources.commodity;
  const ret = meta.sources.retail;
  const est = meta.sources.estat;
  const vf = freshnessBySource.vegetan;

  const vegRows = veg
    ? `
<h2>データの出典（野菜価格）</h2>
<p><strong>${esc(VEGETAN_ATTRIBUTION)}</strong></p>
<table>
  <tr><th>データソース</th><td>${esc(veg.title)}</td></tr>
  <tr><th>提供元・出典表示</th><td>${esc(veg.attribution)}</td></tr>
  <tr><th>取得元URL</th><td><a href="${esc(veg.homepage)}" rel="nofollow">${esc(veg.homepage)}</a></td></tr>
  <tr><th>著作権について（機構の規定）</th><td><a href="${esc(veg.licenseUrl)}" rel="nofollow">${esc(veg.licenseUrl)}</a></td></tr>
  <tr><th>更新頻度</th><td>日次（卸売・東京都中央卸売市場ほか）＋月次（長期系列）。本サイトは日次で自動取得。</td></tr>
  <tr><th>最新データ</th><td>${fmtDate(veg.latestDate)}</td></tr>
</table>
<p>日次卸売データ（入荷量・卸売価格・平年値・平年比）は農林水産省「青果物卸売市場調査（日別調査）」を原資料として
「ベジ探」が公開しているもの、2005年からの長期月次系列は主要品目の価格をまとめたものです。</p>
<p><strong>著作権の扱いについて:</strong> ${esc(veg.license)}
「ベジ探」の著作権ページには「掲載されている情報の著作権は、特記されていない限り、機構に帰属します。
内容の全部又は一部については、私的使用又は引用等著作権法上認められた行為を除き、当機構に無断で
引用、転載、複製を行うことはできません」と明記されており、政府標準利用規約のような
出典表示のみで再利用可能なオープンライセンスではありません。本サイトはページや記事を複製・転載せず、
公開されている価格・数量等の数値（それ自体は著作権法上の保護対象外である事実データ）を独自に
集計・グラフ化して掲載しています。</p>`
    : '';

  const retRows = ret
    ? `
<h2>データの出典（都市別小売価格）</h2>
<p><strong>${esc(RETAIL_ATTRIBUTION)}</strong></p>
<table>
  <tr><th>データソース</th><td>${esc(ret.title)}</td></tr>
  <tr><th>提供元・出典表示</th><td>${esc(ret.attribution)}</td></tr>
  <tr><th>取得元URL</th><td><a href="${esc(ret.homepage)}" rel="nofollow">${esc(ret.homepage)}</a></td></tr>
  <tr><th>調査対象</th><td>全国主要都市の店頭小売価格（円/kg）</td></tr>
  <tr><th>更新頻度</th><td><strong>月次調査</strong>（毎日更新ではありません）。本サイトは自動で取得し、月次で更新します。</td></tr>
  <tr><th>最新データ</th><td>${fmtMonth(ret.latestDate)}</td></tr>
</table>
<p>都市別小売価格は農林水産省「食品価格動向調査」を原資料として「ベジ探」が公開している<strong>月次</strong>の調査値です。
卸売価格（日次）とは別の指標で、消費者が店頭で購入する価格の目安を示します。都市別の一覧は<a href="/retail/">小売価格ページ</a>をご覧ください。</p>`
    : '';

  const estRows = est
    ? `
<h2>データの出典（果実・産地別 卸売価格）</h2>
<p><strong>${esc(ESTAT_ATTRIBUTION)}</strong></p>
<table>
  <tr><th>データソース</th><td>${esc(est.title)}</td></tr>
  <tr><th>提供元・出典表示</th><td>${esc(est.attribution)}</td></tr>
  <tr><th>取得元</th><td><a href="${esc(est.homepage)}" rel="nofollow">${esc(est.homepage)}</a>（e-Stat API v3・statsCode=00500226）</td></tr>
  <tr><th>ライセンス</th><td><a href="${esc(est.licenseUrl)}" rel="nofollow">${esc(est.license)}</a></td></tr>
  <tr><th>更新頻度</th><td><strong>年次公表</strong>（毎日更新ではありません）。最新公表年のみを掲載します。</td></tr>
  <tr><th>最新公表年</th><td>${est.year ? `${esc(String(est.year))}年調査` : '—'}</td></tr>
</table>
<p>果実（りんご・みかん・ぶどう等）の品目ページ、および一部の野菜ページの「産地と地域別の卸売価格（政府統計）」セクションは、農林水産省「青果物卸売市場調査」（e-Stat）の<strong>年次確報</strong>を原資料としています。産地別の入荷量シェアと、主要消費地域（卸売市場）別の月別卸売価格を、政府標準利用規約に基づき出典を明示して加工・掲載しています。日次のベジ探価格とは調査・時点が異なる、年に一度公表される確報値です。</p>`
    : '';

  const comRows = com
    ? `
<h2>データの出典（国際市況アーカイブ）</h2>
<table>
  <tr><th>データソース</th><td>${esc(com.title)}</td></tr>
  <tr><th>提供元・出典表示</th><td>${esc(com.attribution)}</td></tr>
  <tr><th>取得元URL</th><td><a href="${esc(com.homepage)}" rel="nofollow">${esc(com.homepage)}</a></td></tr>
  <tr><th>ライセンス</th><td><a href="${esc(com.licenseUrl)}" rel="nofollow">${esc(com.license)}</a></td></tr>
  <tr><th>状態</th><td>${fmtMonth(com.latestDate)}で更新が停止した月次アーカイブ（<a href="/archive/">アーカイブ一覧</a>）</td></tr>
</table>`
    : '';

  const body = `
<h1>このサイトについて・データ出典</h1>
<p class="lead">${esc(site.siteName)}は、全国の卸売市場で取引される野菜・果物の価格を、公的なオープンデータから毎日自動で集計して無料で公開している情報サイトです。</p>

<h2>サイトの目的</h2>
<p>スーパーや市場に並ぶ野菜・果物の価格は、天候や産地の切り替わりで日々動いています。ただ、その「いまが高いのか安いのか」を消費者やお店の人が自分で調べるのは簡単ではありません。${esc(site.siteName)}は、公的機関が公開している価格データをわかりやすく整理し、<strong>「いま平年より割安な品目（買い時）」「価格の推移と旬」「産地・地域別の相場」</strong>を、登録なしでひと目で確認できるようにすることを目的としています。毎日の献立を考える消費者の方にも、飲食店や八百屋など仕入れを行うプロの方にも、同じように役立つことを目指しています。</p>

<h2>運営方針</h2>
<p>掲載している数値は、いずれも国や独立行政法人が公表している一次データにもとづいています。価格そのものは加工せず、集計・グラフ化・平年比の判定といった「見やすくする」処理だけを行い、出典は各ページに明記しています。データの取得から集計、ページの生成・公開までは毎日自動で行っており、人手による価格の入力や書き換えは行っていません。これにより、鮮度を保ちながら、恣意的な操作の入り込む余地をなくしています。データの鮮度は出典ごとに判定し、更新が止まった系統（国際市況アーカイブ）のページには、その旨を自動で表示します。</p>
${vegRows}
${retRows}
${estRows}
${comRows}

<h2>自動更新であることの開示</h2>
<p>本サイトのすべてのページは、GitHub Actions の日次スケジュール（日本時間の朝）で
データ取得スクリプトとページ生成スクリプトを実行し、自動的に再構築・公開されています。
編集者による手動の価格入力・修正は行っていません。データの鮮度はデータソース単位で判定し、
更新が止まったソース（国際市況アーカイブ）のページには自動でアーカイブである旨を表示します。</p>

<h2>指標の算出方法</h2>
<ul>
  <li><strong>平年比</strong>: 「ベジ探」が提供する、当日の卸売価格と平年値（過去5か年の同時期平均）との比率です。野菜の割安・割高の基準として使用しています。</li>
  <li><strong>いま買い時</strong>: 当日の平年比が0.9未満（＝平年より10%以上割安）の品目を「買い時」と判定しています。</li>
  <li><strong>値上がり・値下がりランキング</strong>: 日次卸売価格の直近1週間の変化率で並べています。</li>
  <li><strong>前月比 / 前年比</strong>: 長期月次系列で、直前月・12か月前と比較した価格変化率です。</li>
</ul>

<h2>免責事項</h2>
<p>掲載する価格は卸売市場等の調査に基づく参考値であり、店頭価格や実際の取引価格を保証するものではありません。
本サイトの情報を用いて行う一切の判断・行為について、運営者は責任を負いません。</p>

<h2>広告・アフィリエイトについて</h2>
<p>本サイトは第三者配信の広告サービス（Google AdSense 等）およびアフィリエイトプログラムを利用する場合があります（設定時のみ表示）。</p>
`;
  const jsonld = [breadcrumbLd(site, [{ name: 'トップ', url: '/' }, { name: 'データ出典', url: '/about/' }])];
  return renderPage(site, {
    title: 'データ出典・このサイトについて',
    description: `${site.siteName}のデータ出典（独立行政法人農畜産業振興機構「ベジ探」等）・ライセンス・自動更新の仕組み・指標の算出方法・免責事項について。`,
    path: '/about/',
    breadcrumb: [{ name: 'トップ', url: '/' }, { name: 'データ出典', url: '/about/' }],
    jsonld,
    updatedLabel,
    freshness: vf,
    body,
  });
}

// ---- assets ----------------------------------------------------------------
function ogSvg(site, meta, freshness) {
  const tail = freshness.archive
    ? `品目（月次アーカイブ・${freshness.label}まで）`
    : '品目を毎日自動更新';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#0f2e20"/>
<rect x="0" y="0" width="1200" height="12" fill="#4ecb8b"/>
<text x="80" y="230" font-family="sans-serif" font-size="86" font-weight="700" fill="#ffffff">🥬 ${esc(site.siteName)}</text>
<text x="80" y="320" font-family="sans-serif" font-size="42" fill="#bfe6d2">${esc(site.tagline)}</text>
<text x="80" y="470" font-family="sans-serif" font-size="34" fill="#9fd8bb">最新集計: ${esc(fmtDate(meta.latestDate))}／${esc(String(meta.itemCount))}${esc(tail)}</text>
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

// ads.txt (IAB) authorized-seller line for AdSense, derived from
// adsenseClientId (e.g. "ca-pub-1234567890123456" -> pub id "pub-1234567890123456").
// Returns null when adsenseClientId is unset or not in the expected ca-pub-<digits> form.
function adsTxtContent(adsenseClientId) {
  const m = /^ca-(pub-\d+)$/.exec(adsenseClientId || '');
  if (!m) return null;
  return `google.com, ${m[1]}, DIRECT, f08c47fec0942fa0\n`;
}

// ---- main --------------------------------------------------------------------
async function main() {
  const rawSite = await readJson(path.join(CONFIG_DIR, 'site.json'), {});
  const meta = await readJson(path.join(DATA_DIR, 'meta.json'), null);
  const records = await loadItems();
  const retailRecords = await loadRetail();
  const estatRecords = await loadEstat();

  if (!meta || records.length === 0) {
    throw new Error('build: no data found. Run `npm run fetch` first.');
  }
  // Back-compat: lift a single-source meta.json into the multi-source shape.
  if (!meta.sources) {
    meta.sources = { [meta.source.id]: { ...meta.source, latestDate: meta.latestDate } };
    meta.primarySource = meta.source.id;
  }

  // PER-SOURCE freshness: each data source's latest data point decides whether
  // its pages carry live copy or the archive banner. The site-level default is
  // the primary (vegetan) source's freshness.
  const now = new Date();
  const freshnessBySource = {};
  for (const [id, src] of Object.entries(meta.sources)) {
    freshnessBySource[id] = freshnessCopy(src.latestDate, now);
  }
  const primaryFresh =
    freshnessBySource[meta.primarySource] || freshnessCopy(meta.latestDate, now);

  // Brand icon: if assets/icon.png exists, use it for the favicon / app icon
  // across every page; otherwise fall back to the inline emoji favicon.
  const iconBytes = await fs.readFile(path.join(ASSETS_DIR, 'icon.png')).catch(() => null);

  const site = {
    ...rawSite,
    tagline: primaryFresh.archive ? primaryFresh.tagline : rawSite.tagline,
    description: primaryFresh.archive ? primaryFresh.description : rawSite.description,
    freshness: primaryFresh,
    iconPng: iconBytes ? '/assets/icon.png' : null,
  };

  const entries = records
    .map((item) => ({ item, stats: computeItemStats(item) }))
    .filter((e) => e.stats);
  entries.sort((a, b) =>
    a.item.category === b.item.category
      ? a.item.name.localeCompare(b.item.name, 'ja')
      : a.item.category.localeCompare(b.item.category, 'ja')
  );

  const vegEntries = entries.filter((e) => e.item.source === 'vegetan');
  const comEntries = entries.filter((e) => e.item.source !== 'vegetan');
  const vegFresh = freshnessBySource.vegetan || primaryFresh;
  const comFresh = freshnessBySource.commodity || freshnessCopy(null, now);

  // Retail (都市別小売価格) is a MONTHLY survey. Reuse the freshness machinery for
  // the stale-banner behaviour, but force honest monthly copy for the footer and
  // price labels — this data is never "毎日更新".
  const retailMeta = meta.sources.retail;
  const retailBase = freshnessCopy(retailMeta ? retailMeta.latestDate : null, now);
  const retailFresh = {
    ...retailBase,
    priceLabel: '最新月の小売価格',
    footerNotice:
      '本サイトの都市別小売価格は、独立行政法人農畜産業振興機構「ベジ探」が公開する<strong>月次の食品価格動向調査</strong>をもとに自動集計しています。',
  };
  const retailMap = new Map(retailRecords.map((r) => [r.slug, r]));
  const cityList = retailCityList(retailRecords);

  // e-Stat (青果物卸売市場調査) is ANNUAL (年次公表), so its pages never get the
  // stale "archive banner" — the annual caveat is stated inline instead. Records
  // whose slug matches a vegetable item page are embedded as a section there;
  // the rest (fruits + estat-only 果菜) get standalone /items/<slug>/ pages.
  const estatMeta = meta.sources.estat;
  const estatYear = (estatMeta && estatMeta.year) || (estatRecords[0] && estatRecords[0].year) || null;
  const estatFresh = {
    archive: false,
    banner: null,
    label: estatYear ? `${estatYear}年` : '—',
    priceLabel: '最新公表年の卸売価格',
    updateNotice: '',
    footerNotice:
      '本サイトの果実・産地データは、農林水産省「青果物卸売市場調査」（e-Stat）の<strong>年次確報</strong>をもとに自動集計しています（日次更新ではありません）。',
  };
  const vegSlugSet = new Set(vegEntries.map((e) => e.item.slug));
  const estatMap = new Map(estatRecords.map((r) => [r.slug, r]));
  const estatStandalone = estatRecords.filter((r) => !vegSlugSet.has(r.slug));

  // Rankings and the buy signal are vegetable/daily-based: isBuy comes from the
  // source-provided 平年比 (normalRatio < 0.9), rankPct from the daily series.
  const rankings = buildRankings(vegEntries.length ? vegEntries : entries);
  // 日本のサイトなので「最終更新」はJSTの日付で表示する(UTCのままだと
  // JST朝のビルドが前日表記になる)
  const jstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const updatedLabel = fmtDate(jstToday) + '（日本時間）';

  // clean public (keep dir)
  await fs.rm(PUBLIC_DIR, { recursive: true, force: true });
  await fs.mkdir(PUBLIC_DIR, { recursive: true });

  // assets
  await write('assets/style.css', STYLESHEET);
  await write('assets/og.svg', ogSvg(site, meta, vegEntries.length ? vegFresh : primaryFresh));
  await write('.nojekyll', '');
  if (iconBytes) {
    // Brand icon (favicon / apple-touch / PWA). Copied verbatim; a single square
    // PNG is scaled by browsers for every required size.
    await write('assets/icon.png', iconBytes);
    await write(
      'site.webmanifest',
      JSON.stringify(
        {
          name: site.siteName,
          short_name: site.siteName,
          icons: [
            { src: '/assets/icon.png', sizes: '192x192', type: 'image/png' },
            { src: '/assets/icon.png', sizes: '512x512', type: 'image/png' },
          ],
          theme_color: '#1f7a4d',
          background_color: '#ffffff',
          display: 'browser',
        },
        null,
        2,
      ),
    );
  }

  const urls = ['/', '/weekly/', '/about/'];

  if (vegEntries.length) {
    await write('index.html', renderIndex(site, meta, vegEntries, rankings, updatedLabel, vegFresh, estatStandalone));
    await write('weekly/index.html', renderWeekly(site, meta, vegEntries, rankings, updatedLabel, vegFresh, retailRecords, cityList));
  } else {
    // Degenerate fallback (no veg data yet): keep the site buildable from the
    // commodity archive alone rather than failing the deploy.
    await write('index.html', renderArchiveIndex(site, meta, comEntries, updatedLabel, comFresh));
    await write('weekly/index.html', renderWeekly(site, meta, comEntries, rankings, updatedLabel, comFresh, retailRecords, cityList));
  }
  await write('about/index.html', renderAbout(site, meta, updatedLabel, freshnessBySource));

  if (comEntries.length && vegEntries.length) {
    await write('archive/index.html', renderArchiveIndex(site, meta, comEntries, updatedLabel, comFresh));
    urls.push('/archive/');
  }

  for (const e of vegEntries) {
    await write(
      `items/${e.item.slug}/index.html`,
      renderVegItemPage(site, meta, e, updatedLabel, vegFresh, retailMap.get(e.item.slug), cityList, estatMap.get(e.item.slug))
    );
    urls.push(`/items/${e.item.slug}/`);
  }
  for (const e of comEntries) {
    await write(`items/${e.item.slug}/index.html`, renderCommodityItemPage(site, meta, e, updatedLabel, comFresh));
    urls.push(`/items/${e.item.slug}/`);
  }

  // Standalone e-Stat item pages (fruits + estat-only 果菜).
  let estatPageCount = 0;
  for (const rec of estatStandalone) {
    await write(`items/${rec.slug}/index.html`, renderEstatItemPage(site, meta, rec, updatedLabel, estatFresh));
    urls.push(`/items/${rec.slug}/`);
    estatPageCount += 1;
  }

  // Retail: index + one page per surveyed city.
  let retailPageCount = 0;
  if (retailRecords.length && retailMeta && cityList.length) {
    await write('retail/index.html', renderRetailIndex(site, meta, retailRecords, cityList, updatedLabel, retailFresh));
    urls.push('/retail/');
    retailPageCount += 1;
    for (const city of cityList) {
      await write(
        `retail/${city.citySlug}/index.html`,
        renderRetailCityPage(site, meta, city, retailRecords, updatedLabel, retailFresh)
      );
      urls.push(`/retail/${city.citySlug}/`);
      retailPageCount += 1;
    }
  }

  await write('sitemap.xml', sitemap(site, urls, meta.generatedAt.slice(0, 10)));
  await write('robots.txt', robots(site));

  // Custom domain (opt-in, config/site.json `customDomain`): emit the GitHub
  // Pages CNAME file and, when AdSense is configured, ads.txt declaring this
  // site as an authorized direct seller. Both are skipped entirely when
  // customDomain is empty (the default — GitHub Pages project-page subpath
  // needs neither file).
  if (site.customDomain) {
    await write('CNAME', `${site.customDomain}\n`);
    const ads = adsTxtContent(site.adsenseClientId);
    if (ads) await write('ads.txt', ads);
  }

  console.log(`[build] ${entries.length} items (${vegEntries.length} veg / ${comEntries.length} archive) + ${retailPageCount} retail + ${estatPageCount} estat -> ${urls.length} pages in public/`);
  console.log('[build] done.');
}

main().catch((err) => {
  console.error(`[build] ERROR: ${err.stack || err.message}`);
  process.exit(1);
});
