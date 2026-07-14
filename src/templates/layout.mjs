import { esc, jsonLd } from '../lib/html.mjs';

// Shared stylesheet, written once to public/assets/style.css.
export const STYLESHEET = `
:root{
  --bg:#ffffff; --fg:#1a1c1e; --muted:#5b6570; --line:#e6e8eb;
  --card:#f7f8fa; --accent:#1f7a4d; --accent2:#d98324; --on-accent:#ffffff;
  --up:#c0392b; --down:#1f7a4d; --flat:#6b7280;
  --link:#1558b0; --shadow:0 1px 2px rgba(0,0,0,.06);
  --hero-bg:linear-gradient(135deg,rgba(31,122,77,.08),rgba(217,131,36,.06));
}
@media (prefers-color-scheme:dark){
  :root{--bg:#15181b;--fg:#e7eaed;--muted:#9aa4af;--line:#2a2f34;
  --card:#1e2226;--accent:#4ecb8b;--accent2:#e5a955;--on-accent:#0f2419;
  --up:#ff6b5e;--down:#4ecb8b;--flat:#9aa4af;--link:#7fb2ff;
  --hero-bg:linear-gradient(135deg,rgba(78,203,139,.10),rgba(229,167,85,.07));}
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
.obars{display:flex;flex-direction:column;gap:6px;margin:10px 0}
.obar{display:grid;grid-template-columns:6em 1fr 4.2em;align-items:center;gap:8px;font-size:.9rem}
.obar .nm{color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.obar .track{background:var(--line);border-radius:6px;height:14px;overflow:hidden}
.obar .fill{background:var(--accent);height:100%;border-radius:6px;min-width:2px}
.obar .pc{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}
.estat-note{font-size:.82rem}
.archive-banner{background:#7a4a12;color:#fff8ec;text-align:center;font-size:.85rem;padding:8px 14px}
@media (prefers-color-scheme:dark){.archive-banner{background:#5c3a11;color:#ffe9c7}}
/* --- brand mark --- */
.brand{display:inline-flex;align-items:center}
.brand-mark{vertical-align:middle;margin-right:8px;flex:none}
.bm-bg{fill:var(--accent)}
.bm-line{fill:none;stroke:var(--on-accent);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.bm-dot{fill:var(--on-accent)}
.brand .bt{color:var(--accent)}
.accent{color:var(--accent)}
/* --- buttons --- */
.btn{display:inline-flex;align-items:center;gap:6px;padding:11px 20px;border-radius:11px;
  font-weight:700;font-size:.98rem;line-height:1.2;border:1px solid transparent;cursor:pointer}
.btn:hover{text-decoration:none}
.btn-primary{background:var(--accent);color:var(--on-accent);box-shadow:var(--shadow)}
.btn-primary:hover{filter:brightness(1.06)}
.btn-ghost{background:transparent;color:var(--fg);border-color:var(--line)}
.btn-ghost:hover{border-color:var(--accent);color:var(--accent)}
/* --- hero --- */
.hero{display:grid;grid-template-columns:1.15fr .85fr;gap:28px;align-items:center;
  background:var(--hero-bg);border:1px solid var(--line);border-radius:18px;
  padding:32px 30px;margin:22px 0 30px}
.hero-eyebrow{display:inline-block;font-size:.8rem;font-weight:600;letter-spacing:.02em;
  color:var(--accent);background:var(--card);border:1px solid var(--line);
  border-radius:999px;padding:4px 12px;margin:0 0 14px}
.hero-title{font-size:2.1rem;line-height:1.32;font-weight:800;margin:0 0 .5em;letter-spacing:.01em}
.hero-sub{color:var(--muted);font-size:1.02rem;margin:0 0 20px;max-width:34em}
.hero-cta{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:16px}
.hero-meta{font-size:.86rem;color:var(--muted);margin:0}
.hero-meta strong{color:var(--fg);font-variant-numeric:tabular-nums}
.hero-art{align-self:center}
.hero-svg{width:100%;height:auto;display:block}
.hs-panel{fill:var(--card);stroke:var(--line);stroke-width:1.5}
.hs-grid{stroke:var(--line);stroke-width:1}
.hs-area{fill:var(--accent);opacity:.10}
.hs-line{fill:none;stroke:var(--accent);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.hs-ring{fill:none;stroke:var(--accent);stroke-width:2;opacity:.4}
.hs-dot{fill:var(--accent)}
.hs-tag{fill:var(--accent)}
.hs-tag-t{fill:var(--on-accent);font-size:11px;font-weight:700;font-family:inherit}
.hs-leaf{fill:var(--accent);opacity:.85}
.hs-fruit{fill:var(--accent2)}
.hs-fruit-v{stroke:var(--accent2);stroke-width:1.5;fill:none;opacity:.7}
/* --- use-cases / about block --- */
.about-block{margin:8px 0 6px}
.use-grid{grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin:16px 0}
.use-card{background:var(--card);border:1px solid var(--line);border-radius:12px;
  padding:16px 16px 14px;display:flex;flex-direction:column;gap:8px;box-shadow:var(--shadow)}
.use-card .use-ico{width:34px;height:34px}
.use-card h3{margin:0;font-size:1.02rem}
.use-card p{margin:0;color:var(--muted);font-size:.92rem;flex:1}
.use-card .use-link{font-size:.9rem;font-weight:600;color:var(--accent);margin-top:2px}
.uc-stroke{fill:none;stroke:var(--accent);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.uc-fill{fill:var(--accent);opacity:.15}
.dot{display:inline-block;width:.62em;height:.62em;border-radius:50%;
  margin-right:.45em;vertical-align:middle}
.dot-buy{background:var(--down)}
.more-links{font-size:.92rem;color:var(--muted);margin:6px 0 0}
@media (max-width:760px){
  .hero{grid-template-columns:1fr;padding:26px 22px;gap:18px}
  .hero-art{order:-1;max-width:320px}
  .hero-title{font-size:1.8rem}
}
@media (max-width:520px){
  h1{font-size:1.35rem}nav.main a{margin-left:10px}
  .hero-title{font-size:1.55rem}.hero-sub{font-size:.96rem}
  .btn{flex:1;justify-content:center}
}
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
  return '本サイトは、公的なオープンデータをもとに野菜・果物の価格を<strong>毎日自動で集計・更新</strong>している情報サイトです。';
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

// Small inline logomark: a rounded badge with a price line dipping to a
// highlighted "buy" point — a quiet visual pun on 買い時 (price down = good).
function brandMark() {
  return `<svg class="brand-mark" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false"><rect x="1.5" y="1.5" width="21" height="21" rx="7" class="bm-bg"/><path class="bm-line" d="M6 9 L10 12 L13 10 L17.5 15.5"/><circle class="bm-dot" cx="17.5" cy="15.5" r="2.2"/></svg>`;
}

// Brand wordmark: accent the leading portion, keep the trailing "ナビ" in the
// base color for a calm two-tone look. Name-agnostic (falls back gracefully).
function brandName(siteName) {
  const n = String(siteName || '');
  if (n.endsWith('ナビ') && n.length > 2) {
    return `<span class="bt">${esc(n.slice(0, -2))}</span>ナビ`;
  }
  return esc(n);
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
  <a class="brand" href="/">${brandMark()}${brandName(site.siteName)}</a>
  <nav class="main">
    <a href="/">トップ</a>
    <a href="/#fruits">果実</a>
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
