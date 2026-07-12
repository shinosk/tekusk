// Source adapters. The build/site are source-agnostic: each adapter returns a
// raw CSV string plus provenance metadata, and normalize.mjs turns it into the
// per-item time series the rest of the system consumes.
//
// IMPORTANT (data provenance):
//   * `commodity` is the VERIFIED, machine-fetchable source used to build and
//     test the pipeline end-to-end in this repo. See docs/data-sources.md.
//   * `estat` is a live PRODUCTION source: 農林水産省「青果物卸売市場調査」via the
//     e-Stat API v3 (statsCode=00500226). It is an ANNUAL survey used as the
//     public-record detail layer (産地別シェア＋消費地域別の月別卸売価格) behind the
//     daily ベジ探 data. Discovery + normalization live in src/lib/estat.mjs and
//     are unit-tested against committed fixtures (test/fixtures/estat/).

import fs from 'node:fs/promises';
import path from 'node:path';
import { VEGETAN_FIXTURES_DIR, ESTAT_FIXTURES_DIR } from './paths.mjs';
import { ESTAT_TABLE_CATEGORY_RE } from './estat.mjs';

const UA =
  'tekusk-price-bot/1.0 (+https://github.com/; static-site data updater)';

export async function fetchWithRetry(url, { retries = 4, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/csv,*/*' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        const backoff = Math.min(1000 * 2 ** attempt, 8000);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

// Binary variant of fetchWithRetry for .xlsx (ZIP) downloads.
export async function fetchBufferWithRetry(url, { retries = 4, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: '*/*' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        const backoff = Math.min(1000 * 2 ** attempt, 8000);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

// ---- Adapter: commodity (verified, reachable) ---------------------------
const COMMODITY_URL =
  'https://raw.githubusercontent.com/datasets/commodity-prices/main/data/commodity-prices.csv';

export const commodityAdapter = {
  id: 'commodity',
  title: '国際商品市況（食品・青果コモディティ）',
  url: COMMODITY_URL,
  homepage: 'https://github.com/datasets/commodity-prices',
  license: 'ODC-PDDL-1.0 (Public Domain Dedication and License)',
  licenseUrl: 'http://opendatacommons.org/licenses/pddl/',
  attribution:
    'Frictionless Data / Open Knowledge Foundation「Commodity Prices」（原データ: IMF）',
  cadence: 'monthly',
  async fetchCsv(opts) {
    return fetchWithRetry(COMMODITY_URL, opts);
  },
};

// ---- Adapter: vegetan (production source: ALIC「ベジ探」) ----------------
// Japanese vegetable wholesale/retail prices. Two families of .xlsx books:
//   * Daily wholesale   kakakugurafu/{youkeisai,kasai,konsai,imo}.xlsx
//   * Monthly long-term  wp-content/uploads/{item}.xlsx
// fetchRaw returns { daily:{key:Buffer}, monthly:{key:Buffer} } from EITHER
// live HTTP (production) or the committed fixtures (--fixtures, dev sandbox);
// the downstream fetch→normalize path (src/lib/vegetan.mjs) is identical for
// both, so the parser is developed/tested against the exact bytes production
// will see.
const VEGETAN_BASE = 'https://vegetan.alic.go.jp/';
const VEGETAN_DAILY_BOOKS = ['youkeisai', 'kasai', 'konsai', 'imo'];

// Locate a committed fixture whose sanitized filename ends with `suffix`
// (probe.mjs saves e.g. "005-vegetan.alic.go.jp_kakakugurafu_youkeisai.xlsx.xlsx").
async function findFixture(suffix) {
  const files = await fs.readdir(VEGETAN_FIXTURES_DIR);
  const hit = files.find((f) => f.endsWith(suffix));
  if (!hit) return null;
  return fs.readFile(path.join(VEGETAN_FIXTURES_DIR, hit));
}

export const vegetanAdapter = {
  id: 'vegetan',
  title: '日本の野菜卸売・小売価格（独立行政法人農畜産業振興機構「ベジ探」）',
  url: VEGETAN_BASE,
  homepage: 'https://vegetan.alic.go.jp/',
  // NOTE (legal accuracy, see docs/legal-notes.md): 機構の著作権ページ
  // (https://vegetan.alic.go.jp/chosaku.html) は「掲載情報の著作権は機構に帰属し、私的使用・
  // 引用等の著作権法上認められた行為を除き無断引用・転載・複製不可」という一般的な著作権表示で
  // あり、政府標準利用規約のようなオープンライセンス（出典表示のみで二次利用自由）ではない。
  // 本サイトはページ・記事を複製せず、価格等の数値（事実データ）を独自に集計・可視化して掲載する
  // ことで対応している。licenseUrl は実際に著作権条件を記載した chosaku.html を指す
  // （riyou.html はブラウザ推奨等の別ページで著作権とは無関係）。
  license:
    '著作権は機構に帰属（オープンライセンスではない）。本サイトは価格等の数値（事実データ）を' +
    '独自に集計・可視化して掲載しており、ページ・記事等の転載は行っていない。',
  licenseUrl: 'https://vegetan.alic.go.jp/chosaku.html',
  attribution:
    '独立行政法人農畜産業振興機構『ベジ探』のデータを加工して作成（原資料: 農林水産省「青果物卸売市場調査」等）',
  cadence: 'daily',

  // catalogItems: the vegetan-source items from config/items.json (used to
  // learn which monthly workbook keys to fetch). opts.fixtures switches the
  // byte source; everything after this call is source-agnostic.
  async fetchRaw(catalogItems, opts = {}) {
    const monthlyKeys = [...new Set(catalogItems.map((it) => it.monthlyKey).filter(Boolean))];
    const daily = {};
    const monthly = {};

    if (opts.fixtures) {
      for (const key of VEGETAN_DAILY_BOOKS) {
        const buf = await findFixture(`_kakakugurafu_${key}.xlsx.xlsx`);
        if (buf) daily[key] = buf;
      }
      for (const key of monthlyKeys) {
        const buf = await findFixture(`_wp-content_uploads_${key}.xlsx.xlsx`);
        if (buf) monthly[key] = buf;
      }
    } else {
      for (const key of VEGETAN_DAILY_BOOKS) {
        try {
          daily[key] = await fetchBufferWithRetry(`${VEGETAN_BASE}kakakugurafu/${key}.xlsx`, opts);
        } catch (err) {
          console.error(`[vegetan] daily ${key} failed: ${err.message}`);
        }
      }
      for (const key of monthlyKeys) {
        try {
          monthly[key] = await fetchBufferWithRetry(
            `${VEGETAN_BASE}wp-content/uploads/${key}.xlsx`,
            opts
          );
        } catch (err) {
          console.error(`[vegetan] monthly ${key} failed: ${err.message}`);
        }
      }
    }

    return { daily, monthly };
  },
};

// ---- Adapter: retail (production source: ALIC「ベジ探」都市別小売価格) --------
// Monthly city-level retail prices. One .xlsx per item under kouri_cyousa/,
// named with the site's own romaji spellings (kyabetu, negi, ...); the catalog
// carries each item's `retailKey` (file name) and `retailSheet` (sheet). This
// is a MONTHLY survey — copy must say「月次調査」, never「毎日更新」.
// fetchRaw returns { retailKey: Buffer } from EITHER live HTTP (production) or
// the committed fixtures (--fixtures); the normalize path (src/lib/retail.mjs)
// is identical for both.
const RETAIL_DIR = 'kouri_cyousa/';

export const retailAdapter = {
  id: 'retail',
  title: '都市別 野菜小売価格（独立行政法人農畜産業振興機構「ベジ探」・月次調査）',
  url: `${VEGETAN_BASE}${RETAIL_DIR}`,
  homepage: 'https://vegetan.alic.go.jp/',
  license:
    '著作権は機構に帰属（オープンライセンスではない）。本サイトは価格等の数値（事実データ）を' +
    '独自に集計・可視化して掲載しており、ページ・記事等の転載は行っていない。',
  licenseUrl: 'https://vegetan.alic.go.jp/chosaku.html',
  attribution:
    '独立行政法人農畜産業振興機構『ベジ探』のデータを加工して作成（原資料: 農林水産省「食品価格動向調査」）',
  cadence: 'monthly',

  // catalogItems: the vegetan-source items that carry a `retailKey`. opts.fixtures
  // switches the byte source; everything after this call is source-agnostic.
  async fetchRaw(catalogItems, opts = {}) {
    const keys = [...new Set(catalogItems.map((it) => it.retailKey).filter(Boolean))];
    const retail = {};
    if (opts.fixtures) {
      for (const key of keys) {
        const buf = await findFixture(`_kouri_cyousa_${key}.xlsx.xlsx`);
        if (buf) retail[key] = buf;
      }
    } else {
      for (const key of keys) {
        try {
          retail[key] = await fetchBufferWithRetry(`${VEGETAN_BASE}${RETAIL_DIR}${key}.xlsx`, opts);
        } catch (err) {
          console.error(`[retail] ${key} failed: ${err.message}`);
        }
      }
    }
    return retail;
  },
};

// ---- Adapter: estat (production source: e-Stat 青果物卸売市場調査) --------------
// 農林水産省「青果物卸売市場調査」(statsCode=00500226) via the e-Stat API v3.
// This is an ANNUAL survey (年次公表), used as the "public-record" detail layer
// (産地別シェア＋消費地域別の月別卸売価格) behind the daily ベジ探 source.
//
// appId handling: the application id comes ONLY from process.env.ESTAT_APP_ID
// (a GitHub Secret) and is injected at the last moment, in resolveUrl, right
// before the HTTP call. It is NEVER logged or embedded in error messages —
// scrubUrl strips both the raw id and the appId query parameter, so a thrown
// error can be surfaced safely.
const ESTAT_API = 'https://api.e-stat.go.jp/rest/3.0/app/json';
const ESTAT_STATS_CODE = '00500226';
const ESTAT_APP_ID = (process.env.ESTAT_APP_ID || '').trim();

function scrubUrl(s) {
  let out = String(s);
  if (ESTAT_APP_ID) out = out.split(ESTAT_APP_ID).join('***');
  return out.replace(/appId=[^&\s]*/gi, 'appId=***');
}

// Fetch + JSON-parse, converting any error into an appId-safe message.
async function fetchEstatJson(url, opts) {
  let text;
  try {
    text = await fetchWithRetry(url, opts);
  } catch (err) {
    throw new Error(`estat fetch failed: ${scrubUrl(err.message)}`);
  }
  const scrubbed = ESTAT_APP_ID ? text.split(ESTAT_APP_ID).join('***') : text;
  let json;
  try {
    json = JSON.parse(scrubbed);
  } catch {
    throw new Error('estat response was not valid JSON');
  }
  // Surface e-Stat API-level errors (STATUS != 0) without leaking the id.
  const result =
    (json.GET_STATS_LIST && json.GET_STATS_LIST.RESULT) ||
    (json.GET_STATS_DATA && json.GET_STATS_DATA.RESULT);
  if (result && result.STATUS && result.STATUS !== 0) {
    throw new Error(`estat API error STATUS=${result.STATUS}: ${scrubUrl(result.ERROR_MSG || '')}`);
  }
  return json;
}

// Locate a committed estat fixture by embedded statsDataId (probe.mjs saves e.g.
// "001-...getStatsData_appId_APPID_statsDataId_0004044496_limit_10000.json").
async function findEstatDataFixture(statsDataId) {
  const files = await fs.readdir(ESTAT_FIXTURES_DIR);
  const hit = files.find((f) => f.includes(`statsDataId_${statsDataId}`));
  if (!hit) return null;
  return JSON.parse(await fs.readFile(path.join(ESTAT_FIXTURES_DIR, hit), 'utf8'));
}

export const estatAdapter = {
  id: 'estat',
  title: '青果物の産地別・消費地域別 卸売価格（農林水産省「青果物卸売市場調査」/ e-Stat）',
  url: `${ESTAT_API}/getStatsData (statsCode=${ESTAT_STATS_CODE})`,
  homepage: 'https://www.e-stat.go.jp/stat-search?toukei=00500226',
  license: '政府標準利用規約（第2.0版）に準拠。出典の明示により二次利用可。',
  licenseUrl: 'https://www.e-stat.go.jp/terms-of-use',
  attribution: '農林水産省「青果物卸売市場調査」（e-Stat）を加工して作成',
  cadence: 'annual',

  hasAppId() {
    return ESTAT_APP_ID.length > 0;
  },

  // getStatsList for statsCode=00500226, narrowed by searchWord. Returns the raw
  // JSON; discovery parsing lives in estat.mjs (listTables/resolveItemTables).
  // In --fixtures mode reads the committed catalog-tail sample instead.
  //
  // NOTE: getStatsList はID昇順(=古い年代が先)で返し、単発の limit 指定では
  // 先頭ウィンドウしか取れない(本番でこれを踏み、最大年が2019に化けた)。
  // RESULT_INF.NEXT_KEY を辿って全ページを取得し、TABLE_INF を結合して返す。
  async fetchCatalog(opts = {}) {
    if (opts.fixtures) {
      const p = path.join(ESTAT_FIXTURES_DIR, 'catalog-tail-getStatsList.json');
      return JSON.parse(await fs.readFile(p, 'utf8'));
    }
    if (!ESTAT_APP_ID) throw new Error('ESTAT_APP_ID is not set (env/secret required for live estat)');
    const base =
      `${ESTAT_API}/getStatsList?appId=${encodeURIComponent(ESTAT_APP_ID)}` +
      `&statsCode=${ESTAT_STATS_CODE}&searchWord=${encodeURIComponent('主要消費地域別')}&limit=1000`;
    const allTables = [];
    let startPosition = null;
    let first = null;
    for (let page = 0; page < 20; page++) {
      const url = startPosition ? `${base}&startPosition=${startPosition}` : base;
      const json = await fetchEstatJson(url, opts);
      if (!first) first = json;
      const inf = json?.GET_STATS_LIST?.DATALIST_INF;
      if (!inf) break;
      const t = inf.TABLE_INF;
      if (t) allTables.push(...(Array.isArray(t) ? t : [t]));
      const next = inf.RESULT_INF && inf.RESULT_INF.NEXT_KEY;
      if (!next) break;
      startPosition = next;
    }
    if (first && first.GET_STATS_LIST && first.GET_STATS_LIST.DATALIST_INF) {
      first.GET_STATS_LIST.DATALIST_INF.TABLE_INF = allTables;
    }
    return first;
  },

  // getStatsData for one table id. In --fixtures mode returns the committed
  // sample for that id, or null when none exists (item is skipped).
  async fetchData(statsDataId, opts = {}) {
    if (opts.fixtures) {
      return findEstatDataFixture(statsDataId);
    }
    if (!ESTAT_APP_ID) throw new Error('ESTAT_APP_ID is not set (env/secret required for live estat)');
    const url =
      `${ESTAT_API}/getStatsData?appId=${encodeURIComponent(ESTAT_APP_ID)}` +
      `&statsDataId=${statsDataId}&limit=100000`;
    return fetchEstatJson(url, opts);
  },
};

// Re-exported for callers that want the discovery regex without importing estat.
export { ESTAT_TABLE_CATEGORY_RE };

export const adapters = {
  commodity: commodityAdapter,
  vegetan: vegetanAdapter,
  retail: retailAdapter,
  estat: estatAdapter,
};

export function getAdapter(id) {
  const a = adapters[id];
  if (!a) throw new Error(`Unknown source adapter: ${id}`);
  return a;
}
