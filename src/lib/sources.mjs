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
  estat: estatAdapter,
};

export function getAdapter(id) {
  const a = adapters[id];
  if (!a) throw new Error(`Unknown source adapter: ${id}`);
  return a;
}
