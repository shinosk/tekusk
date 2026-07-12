#!/usr/bin/env node
// Fetch + normalize price data into data/*.json.
//
// Design goals:
//   * Idempotent: re-running with the same upstream data yields the same files.
//   * Fail-safe: any network/parse error leaves existing data/ untouched and
//     exits 0 (so the daily cron does not fail the whole workflow) unless
//     --strict is passed.
//   * Accumulating: new points are merged into the committed history so the
//     git-tracked JSON acts as a time-series database.
//   * Multi-source: each source owns its own items; a fetch for one source
//     never clobbers another source's item files or meta entry.
//
// Usage:
//   node scripts/fetch.mjs [--source=commodity|vegetan|estat] [--strict] [--fixtures]
//   SOURCE=vegetan node scripts/fetch.mjs --fixtures
//
// --fixtures (vegetan only): read the committed data/raw-samples/files/*.xlsx
//   instead of live HTTP, so the exact production bytes drive development in
//   the egress-restricted sandbox. The fetch→normalize path is identical.

import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR, DATA_DIR, DATA_ITEMS_DIR, DATA_RETAIL_DIR, DATA_ESTAT_DIR } from '../src/lib/paths.mjs';
import { getAdapter } from '../src/lib/sources.mjs';
import { normalizeItems, mergeByDate } from '../src/lib/normalize.mjs';
import { normalizeVegetan } from '../src/lib/vegetan.mjs';
import { normalizeRetail } from '../src/lib/retail.mjs';
import {
  listTables,
  latestListYear,
  resolveItemTables,
  normalizeEstat,
  expectedLatestYear,
} from '../src/lib/estat.mjs';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const fixtures = args.includes('--fixtures');
const force = args.includes('--force');
const sourceArg =
  (args.find((a) => a.startsWith('--source=')) || '').split('=')[1] ||
  process.env.SOURCE ||
  'vegetan';

async function readJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

async function loadExistingRecord(slug) {
  const rec = await readJson(path.join(DATA_ITEMS_DIR, `${slug}.json`), null);
  return {
    series: rec && Array.isArray(rec.series) ? rec.series : [],
    monthly: rec && Array.isArray(rec.monthly) ? rec.monthly : [],
  };
}

const NOW_YM = new Date().toISOString().slice(0, 7);
// Drop future months (the monthly workbooks pre-populate the rest of the
// calendar year); we never present a not-yet-occurred month as "latest".
const capMonthly = (series) => series.filter((p) => p.date.slice(0, 7) <= NOW_YM);

// Produce normalized item records for the requested source. Returns
// { items, missing, rowCount } where each item has at least { slug, ..., series }.
async function collectItems(adapter, catalogItems, opts) {
  if (adapter.id === 'vegetan') {
    const raw = await adapter.fetchRaw(catalogItems, { ...opts, fixtures });
    const { items, missing } = normalizeVegetan(raw, catalogItems);
    let rowCount = 0;
    for (const it of items) {
      it.monthly = capMonthly(it.monthly || []);
      if (!it.hasDaily) it.series = capMonthly(it.series);
      rowCount += it.series.length + (it.monthly ? it.monthly.length : 0);
    }
    return { items, missing, rowCount };
  }
  const csv = await adapter.fetchCsv(opts);
  return normalizeItems(csv, catalogItems);
}

// Merge a source descriptor into the multi-source meta.json without disturbing
// the other sources' entries, then rewrite the back-compat top-level fields.
async function updateMeta(adapter, extra) {
  const prevMeta = await readJson(path.join(DATA_DIR, 'meta.json'), {});
  const sources = { ...(prevMeta.sources || {}) };
  sources[adapter.id] = {
    id: adapter.id,
    title: adapter.title,
    url: adapter.url,
    homepage: adapter.homepage,
    license: adapter.license,
    licenseUrl: adapter.licenseUrl,
    attribution: adapter.attribution,
    cadence: adapter.cadence,
    ...extra,
    updatedAt: new Date().toISOString(),
  };

  // Primary source drives the site's default framing: vegetan (the live
  // production source) when present, else whichever exists.
  const primaryId = sources.vegetan
    ? 'vegetan'
    : sources.commodity
      ? 'commodity'
      : adapter.id;
  const primary = sources[primaryId];

  // The top-level itemCount/totalPoints reflect the item PAGES (vegetan +
  // commodity); retail and estat are separate cross-tabulated datasets and are
  // not summed in so the OG "N品目" stays honest.
  const pageSources = Object.entries(sources).filter(([id]) => id !== 'retail' && id !== 'estat');
  const meta = {
    generatedAt: new Date().toISOString(),
    primarySource: primaryId,
    sources,
    source: {
      id: primary.id,
      title: primary.title,
      url: primary.url,
      homepage: primary.homepage,
      license: primary.license,
      licenseUrl: primary.licenseUrl,
      attribution: primary.attribution,
      cadence: primary.cadence,
    },
    itemCount: pageSources.reduce((a, [, s]) => a + (s.itemCount || 0), 0),
    totalPoints: pageSources.reduce((a, [, s]) => a + (s.totalPoints || 0), 0),
    latestDate: primary.latestDate,
    missing: primary.missing,
  };
  await fs.writeFile(path.join(DATA_DIR, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
}

// Retail (都市別小売価格・月次) has a different shape than the item series files:
// item × city × month. It is written to data/retail/<slug>.json and accumulated
// per city with mergeByDate so history survives across fiscal-year workbooks.
async function runRetail(adapter, catalog) {
  const catalogItems = catalog.items.filter((it) => it.retailKey);
  const cityMap = (catalog.retail && catalog.retail.cities) || {};
  console.log(`[fetch] source=${adapter.id} (${adapter.title})${fixtures ? ' [fixtures]' : ''}`);
  console.log(`[fetch] url=${adapter.url}`);
  if (catalogItems.length === 0) throw new Error('no catalog items with retailKey');

  const raw = await adapter.fetchRaw(catalogItems, { retries: 4, timeoutMs: 30000, fixtures });
  const { items, missing } = normalizeRetail(raw, catalogItems, cityMap);
  if (items.length === 0) {
    throw new Error('retail normalize produced 0 items — refusing to overwrite data');
  }

  await fs.mkdir(DATA_RETAIL_DIR, { recursive: true });
  let totalPoints = 0;
  let latestDate = '';
  const cityNames = new Set();
  for (const it of items) {
    const existing = await readJson(path.join(DATA_RETAIL_DIR, `${it.slug}.json`), null);
    const existingCities = new Map(
      (existing && Array.isArray(existing.cities) ? existing.cities : []).map((c) => [c.citySlug, c])
    );
    const merged = new Map();
    for (const [slug, c] of existingCities) merged.set(slug, { ...c });
    for (const c of it.cities) {
      const prev = merged.get(c.citySlug);
      merged.set(c.citySlug, {
        citySlug: c.citySlug,
        cityName: c.cityName,
        series: mergeByDate(prev ? prev.series : [], c.series),
      });
    }
    const cities = [...merged.values()]
      .map((c) => ({ ...c, series: capMonthly(c.series) }))
      .filter((c) => c.series.length);
    for (const c of cities) {
      cityNames.add(c.citySlug);
      totalPoints += c.series.length;
      const last = c.series.length ? c.series[c.series.length - 1].date : '';
      if (last > latestDate) latestDate = last;
    }
    const record = {
      slug: it.slug,
      name: it.name,
      emoji: it.emoji,
      category: it.category,
      unit: it.unit,
      source: 'retail',
      updatedAt: new Date().toISOString(),
      cities,
    };
    await fs.writeFile(
      path.join(DATA_RETAIL_DIR, `${it.slug}.json`),
      JSON.stringify(record, null, 2) + '\n'
    );
  }

  await updateMeta(adapter, {
    itemCount: items.length,
    cityCount: cityNames.size,
    totalPoints,
    latestDate,
    missing,
  });
  console.log(
    `[fetch] wrote ${items.length} retail items (${cityNames.size} cities), latest=${latestDate}, points=${totalPoints}` +
      (missing.length ? `, missing: ${missing.join(', ')}` : '')
  );
  console.log('[fetch] done.');
}

// e-Stat「青果物卸売市場調査」(annual). Writes data/estat/<slug>.json with the
// latest published year's 産地別シェア + 消費地域別の月別卸売価格. Idempotent &
// skip-heavy: this is a YEARLY dataset, so once the committed data already
// covers the latest expected year we make ZERO API calls (unless --force).
async function runEstat(adapter, catalog) {
  const catalogItems = catalog.items.filter((it) => it.estatTitle);
  console.log(`[fetch] source=${adapter.id} (${adapter.title})${fixtures ? ' [fixtures]' : ''}`);
  if (catalogItems.length === 0) throw new Error('no catalog items with estatTitle');

  const prevMeta = await readJson(path.join(DATA_DIR, 'meta.json'), {});
  const prevEstat = (prevMeta.sources && prevMeta.sources.estat) || null;

  // Zero-call skip: on a normal daily run the annual data is already current.
  // Never skip when the committed data was generated from --fixtures (a partial,
  // 4-item dev subset): production must do at least one real fetch to replace it.
  if (!fixtures && !force && prevEstat && prevEstat.year != null && !prevEstat.fromFixtures) {
    const expected = expectedLatestYear(new Date());
    if (prevEstat.year >= expected) {
      console.log(
        `[fetch] estat already at year ${prevEstat.year} (>= expected ${expected}); ` +
          'skipping all API calls. Use --force to refetch.'
      );
      return;
    }
  }

  // Discovery (1 API call, or the committed catalog-tail fixture).
  const listJson = await adapter.fetchCatalog({ retries: 4, timeoutMs: 30000, fixtures });
  const tables = listTables(listJson);
  const year = latestListYear(tables);
  if (year == null) throw new Error('estat discovery found no 主要消費地域別 tables');
  const resolved = resolveItemTables(tables, catalogItems, year);
  console.log(`[fetch] estat latest published year=${year}, matched ${resolved.length} items`);

  await fs.mkdir(DATA_ESTAT_DIR, { recursive: true });
  const records = [];
  const skipped = [];
  const missing = [];
  for (const r of resolved) {
    const outPath = path.join(DATA_ESTAT_DIR, `${r.item.slug}.json`);
    const existing = await readJson(outPath, null);
    // Per-item idempotency: don't refetch a slug we already have for this year.
    if (!force && existing && existing.year === r.year) {
      records.push(existing);
      skipped.push(r.item.slug);
      continue;
    }
    let dataJson;
    try {
      dataJson = await adapter.fetchData(r.id, { retries: 4, timeoutMs: 30000, fixtures });
    } catch (err) {
      console.error(`[fetch] estat ${r.item.slug} (${r.id}) failed: ${err.message}`);
      if (existing) records.push(existing);
      continue;
    }
    if (!dataJson) {
      // --fixtures: no committed sample for this table → skip (keep existing).
      missing.push(r.item.slug);
      if (existing) records.push(existing);
      continue;
    }
    const rec = normalizeEstat(dataJson, r.item, r);
    if (!rec) {
      console.error(`[fetch] estat ${r.item.slug} normalized to nothing — skipped`);
      if (existing) records.push(existing);
      continue;
    }
    rec.updatedAt = new Date().toISOString();
    await fs.writeFile(outPath, JSON.stringify(rec, null, 2) + '\n');
    records.push(rec);
  }

  if (records.length === 0) {
    throw new Error('estat produced 0 records — refusing to update meta');
  }

  await updateMeta(adapter, {
    year,
    itemCount: records.length,
    latestDate: `${year}-12-01`,
    missing,
    fromFixtures: fixtures,
  });
  console.log(
    `[fetch] wrote ${records.length - skipped.length} estat files (${skipped.length} up-to-date), year=${year}` +
      (missing.length ? `, no-fixture: ${missing.join(', ')}` : '')
  );
  console.log('[fetch] done.');
}

async function main() {
  const catalog = await readJson(path.join(CONFIG_DIR, 'items.json'), { items: [] });
  const adapter = getAdapter(sourceArg);
  if (adapter.id === 'retail') return runRetail(adapter, catalog);
  if (adapter.id === 'estat') return runEstat(adapter, catalog);

  const catalogItems = catalog.items.filter((it) => (it.source || 'commodity') === adapter.id);

  console.log(`[fetch] source=${adapter.id} (${adapter.title})${fixtures ? ' [fixtures]' : ''}`);
  console.log(`[fetch] url=${adapter.url}`);
  if (catalogItems.length === 0) {
    throw new Error(`no catalog items for source "${adapter.id}"`);
  }

  const { items, missing, rowCount } = await collectItems(adapter, catalogItems, {
    retries: 4,
    timeoutMs: 30000,
  });

  if (items.length === 0) {
    throw new Error('normalize produced 0 items — refusing to overwrite data');
  }
  console.log(
    `[fetch] parsed ${rowCount} rows -> ${items.length} items` +
      (missing.length ? `, missing: ${missing.join(', ')}` : '')
  );

  await fs.mkdir(DATA_ITEMS_DIR, { recursive: true });

  let totalPoints = 0;
  let latestDate = '';
  for (const it of items) {
    const existing = await loadExistingRecord(it.slug);
    const series = mergeByDate(existing.series, it.series);
    totalPoints += series.length;
    if (series.length) {
      const last = series[series.length - 1].date;
      if (last > latestDate) latestDate = last;
    }
    const record = {
      slug: it.slug,
      name: it.name,
      emoji: it.emoji,
      category: it.category,
      unit: it.unit,
      origin: it.origin,
      season: it.season,
      buyKeyword: it.buyKeyword,
      source: adapter.id,
      hasDaily: it.hasDaily === true,
      updatedAt: new Date().toISOString(),
      series,
    };
    // Vegetan items carry a separate long-term monthly series for the second
    // chart; commodity items have only `series`. Merge with the accumulated
    // history so a transiently missing monthly workbook can't wipe it.
    if (it.monthly || existing.monthly.length) {
      record.monthly = mergeByDate(existing.monthly, it.monthly || []);
    }
    await fs.writeFile(
      path.join(DATA_ITEMS_DIR, `${it.slug}.json`),
      JSON.stringify(record, null, 2) + '\n'
    );
  }

  // Merge this source's descriptor into a multi-source meta.json without
  // disturbing the other sources' entries.
  await updateMeta(adapter, { itemCount: items.length, totalPoints, latestDate, missing });

  console.log(`[fetch] wrote ${items.length} item files, latest=${latestDate}, points=${totalPoints}`);
  console.log('[fetch] done.');
}

main().catch((err) => {
  console.error(`[fetch] ERROR: ${err.message}`);
  if (strict) {
    process.exit(1);
  } else {
    console.error('[fetch] fail-safe: existing data left untouched, exiting 0.');
    process.exit(0);
  }
});
