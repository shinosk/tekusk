// Source adapters. The build/site are source-agnostic: each adapter returns a
// raw CSV string plus provenance metadata, and normalize.mjs turns it into the
// per-item time series the rest of the system consumes.
//
// IMPORTANT (data provenance):
//   * `commodity` is the VERIFIED, machine-fetchable source used to build and
//     test the pipeline end-to-end in this repo. See docs/data-sources.md.
//   * `estat` is the INTENDED PRODUCTION source (Japanese wholesale/retail
//     vegetable prices). Its endpoints are documented in docs/data-sources.md
//     but were unreachable from the build sandbox (egress allow-list), so its
//     parser is intentionally left as a clearly-marked stub to be finalized
//     against a live response rather than guessed.

import fs from 'node:fs/promises';
import path from 'node:path';
import { VEGETAN_FIXTURES_DIR } from './paths.mjs';

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

// ---- Adapter: estat (production target, stub) ---------------------------
export const estatAdapter = {
  id: 'estat',
  title: '日本の卸売・小売 青果価格（本番想定ソース）',
  url: 'https://www.e-stat.go.jp/ / https://www.maff.go.jp/j/zyukyu/anpo/kouri/',
  homepage: 'https://www.e-stat.go.jp/',
  license: '政府標準利用規約（第2.0版）/ CC-BY 互換',
  licenseUrl: 'https://www.digital.go.jp/copyright-policy',
  attribution: '出典: 農林水産省・総務省統計局 等（e-Stat）',
  cadence: 'weekly/daily',
  async fetchCsv() {
    throw new Error(
      'estat adapter is a documented stub. The Japanese government endpoints ' +
        'were unreachable from the build sandbox and the exact CSV layout must ' +
        'be finalized against a live response. See docs/data-sources.md.'
    );
  },
};

export const adapters = {
  commodity: commodityAdapter,
  vegetan: vegetanAdapter,
  estat: estatAdapter,
};

export function getAdapter(id) {
  const a = adapters[id];
  if (!a) throw new Error(`Unknown source adapter: ${id}`);
  return a;
}
