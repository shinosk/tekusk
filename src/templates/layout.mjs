import { esc, jsonLd } from '../lib/html.mjs';

// Shared stylesheet, written once to public/assets/style.css.
export const STYLESHEET = `
:root{
  --bg:#ffffff; --fg:#1a1c1e; --muted:#5b6570; --line:#e6e8eb;
  --card:#f7f8fa; --accent:#1f7a4d; --up:#c0392b; --down:#1f7a4d; --flat:#6b7280;
  --link:#1558b0; --shadow:0 1px 2px rgba(0,0,0,.06);
}
@media (prefers-color-scheme:dark){
  :root{--bg:#15181b;--fg:#e7eaed;--muted:#9aa4af;--line:#2a2f34;
  --card:#1e2226;--accent:#4ecb8b;--up:#ff6b5e;--down:#4ecb8b;--flat:#9aa4af;--link:#7fb2ff;}
}
*{box-sizing:border-box}
html{font-size:16px}
body{margin:0;background:var(--bg);color:var(--fg);
  font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",Meiryo,sans-serif;
  line-height:1.7;-webkit-text-size-adjust:100%}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:960px;margin:0 auto;padding:0 16px}
header.site{border-bottom:1px solid var(--line);background:var(--bg)}
header.site .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:12px;padding-bottom:12px}
.brand{font-weight:700;font-size:1.15rem;color:var(--fg)}
.brand span{color:var(--accent)}
nav.main a{margin-left:14px;color:var(--muted);font-size:.92rem}
main{padding:20px 0 40px}
h1{font-size:1.6rem;margin:.2em 0 .4em}
h2{font-size:1.25rem;margin:1.6em 0 .5em;border-left:4px solid var(--accent);padding-left:.5em}
h3{font-size:1.05rem;margin:1.2em 0 .4em}
.lead{color:var(--muted);margin:.2em 0 1em}
.grid{display:grid;gap:12px}
.cards{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;box-shadow:var(--shadow)}
.item-card{display:flex;flex-direction:column;gap:2px}
.item-card .em{font-size:1.5rem}
.item-card .nm{font-weight:600}
.item-card .px{font-variant-numeric:tabular-nums}
.badge{display:inline-block;font-size:.78rem;padding:1px 7px;border-radius:999px;border:1px solid var(--line)}
.up{color:var(--up)} .down{color:var(--down)} .flat{color:var(--flat)}
.pill-up{background:rgba(192,57,43,.12);color:var(--up)}
.pill-down{background:rgba(31,122,77,.14);color:var(--down)}
table{width:100%;border-collapse:collapse;font-size:.95rem}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.rank-list{list-style:none;margin:0;padding:0}
.rank-list li{display:flex;justify-content:space-between;gap:8px;padding:7px 2px;border-bottom:1px solid var(--line)}
.chart{width:100%;height:auto;display:block}
.chart-line{stroke:var(--accent);stroke-width:2}
.chart-area{fill:var(--accent);opacity:.08}
.chart-grid{stroke:var(--line);stroke-width:1}
.chart-axis{fill:var(--muted);font-size:11px}
.chart-dot{fill:var(--accent)}
.chart-empty{fill:var(--muted);font-size:13px}
.statgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:14px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.stat .k{font-size:.78rem;color:var(--muted)}
.stat .v{font-size:1.15rem;font-weight:700;font-variant-numeric:tabular-nums}
.notice{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);
  border-radius:8px;padding:10px 14px;margin:14px 0;font-size:.92rem;color:var(--muted)}
.ad-slot{margin:18px 0;text-align:center}
.report p{margin:.6em 0}
footer.site{border-top:1px solid var(--line);color:var(--muted);font-size:.85rem;padding:18px 0 40px}
footer.site a{color:var(--muted);text-decoration:underline}
.breadcrumb{font-size:.82rem;color:var(--muted);margin:4px 0 10px}
.breadcrumb a{color:var(--muted)}
.cat-tag{font-size:.78rem;color:var(--muted)}
.archive-banner{background:#7a4a12;color:#fff8ec;text-align:center;font-size:.85rem;padding:8px 14px}
@media (prefers-color-scheme:dark){.archive-banner{background:#5c3a11;color:#ffe9c7}}
@media (max-width:520px){h1{font-size:1.35rem}nav.main a{margin-left:10px}}
`;

// AdSense placeholder — only emits markup when a client id is configured.
export function adSlot(site, slotId) {
  if (!site.adsenseClientId) return '';
  const slot = slotId || '';
  return `<div class="ad-slot">
  <ins class="adsbygoogle" style="display:block" data-ad-client="${esc(site.adsenseClientId)}"${slot ? ` data-ad-slot="${esc(slot)}"` : ''} data-ad-format="auto" data-full-width-responsive="true"></ins>
  <script>(adsbygoogle=window.adsbygoogle||[]).push({});</script>
</div>`;
}

function adsenseHead(site) {
  if (!site.adsenseClientId) return '';
  return `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${esc(site.adsenseClientId)}" crossorigin="anonymous"></script>`;
}

// Data-freshness banner (site.freshness is attached by scripts/build.mjs from
// src/lib/freshness.mjs). Only rendered when the underlying data is stale, so
// the site never displays a live/daily banner alongside archived data. Placed
// at the very top of <body> so it is prominent on every page.
function archiveBanner(freshness) {
  const f = freshness;
  if (!f || !f.banner) return '';
  return `<div class="archive-banner">${esc(f.banner)}</div>`;
}

// Footer disclosure sentence: honest "daily update" copy when data is fresh,
// honest "frozen archive" copy when it isn't. freshnessCopy's strings are
// static (no user input), so — consistent with the rest of this literal —
// they are not passed through esc().
function footerNotice(freshness) {
  const f = freshness;
  if (f && f.footerNotice) return f.footerNotice;
  return '本サイトは公開オープンデータをもとに<strong>自動生成・毎日更新</strong>される情報サイトです。';
}

// page: { title, description, path, canonical, breadcrumb, jsonld, body,
//         freshness } — page.freshness (per data source) overrides site.freshness
// so a live veg page and an archived commodity page can each show honest copy.
// GitHub Pages のプロジェクトサイトは https://<user>.github.io/<repo>/ の
// サブパス配下で配信されるため、ルート絶対パス(/assets/... /items/... 等)には
// baseUrl のパス部分(例: /tekusk)を前置しないと 404 になる。カスタムドメイン
// (パス部が /)では空文字になり、書き換えは実質無効化される。
export function sitePathPrefix(site) {
  try {
    return new URL(site.baseUrl).pathname.replace(/\/$/, '');
  } catch {
    return '';
  }
}

// 最終HTML内のルート絶対 href/src にだけ前置する(http(s)の完全URL・
// data: URI・protocol-relative "//" は対象外)。
export function applyPathPrefix(html, prefix) {
  if (!prefix) return html;
  return html.replace(/(href|src)="\/(?!\/)/g, `$1="${prefix}/`);
}

export function renderPage(site, page) {
  const canonical = site.baseUrl.replace(/\/$/, '') + page.path;
  const ogImage = site.baseUrl.replace(/\/$/, '') + '/assets/og.svg';
  const fullTitle = page.path === '/' ? `${site.siteName}｜${site.tagline}` : `${page.title}｜${site.siteName}`;
  const freshness = page.freshness || site.freshness;

  const jsonldBlocks = (page.jsonld || []).map(jsonLd).join('\n');

  return applyPathPrefix(`<!doctype html>
<html lang="${esc(site.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(page.description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(site.siteName)}">
<meta property="og:title" content="${esc(page.title || site.siteName)}">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:locale" content="${esc(site.locale)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="robots" content="index,follow">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%A5%AC%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="/assets/style.css">
${adsenseHead(site)}
${jsonldBlocks}
</head>
<body>
${archiveBanner(freshness)}
<header class="site"><div class="wrap">
  <a class="brand" href="/">🥬 ${esc(site.siteName.replace('価格ナビ', ''))}<span>価格ナビ</span></a>
  <nav class="main">
    <a href="/">トップ</a>
    <a href="/retail/">小売価格</a>
    <a href="/weekly/">週報</a>
    <a href="/archive/">国際市況</a>
    <a href="/about/">データ出典</a>
  </nav>
</div></header>
<main><div class="wrap">
${page.breadcrumb ? renderBreadcrumb(page.breadcrumb) : ''}
${page.body}
</div></main>
<footer class="site"><div class="wrap">
  <p>${esc(site.siteName)} — ${footerNotice(freshness)} 価格は参考値であり取引を保証するものではありません。</p>
  <p><a href="/about/">データ出典・免責事項</a>　|　最終更新: ${esc(page.updatedLabel || '')}</p>
</div></footer>
</body>
</html>`, sitePathPrefix(site));
}

function renderBreadcrumb(items) {
  const parts = items
    .map((b, i) =>
      i === items.length - 1
        ? `<span>${esc(b.name)}</span>`
        : `<a href="${esc(b.url)}">${esc(b.name)}</a>`
    )
    .join(' › ');
  return `<div class="breadcrumb">${parts}</div>`;
}
