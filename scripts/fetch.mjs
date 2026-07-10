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
import { CONFIG_DIR, DATA_DIR, DATA_ITEMS_DIR } from '../src/lib/paths.mjs';
import { getAdapter } from '../src/lib/sources.mjs';
import { normalizeItems, mergeByDate } from '../src/lib/normalize.mjs';
import { normalizeVegetan } from '../src/lib/vegetan.mjs';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const fixtures = args.includes('--fixtures');
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

async function main() {
  const catalog = await readJson(path.join(CONFIG_DIR, 'items.json'), { items: [] });
  const adapter = getAdapter(sourceArg);
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
  // disturbing the other source's entry.
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
    itemCount: items.length,
    totalPoints,
    latestDate,
    missing,
    updatedAt: new Date().toISOString(),
  };

  // Primary source drives the site's default framing: vegetan (the live
  // production source) when present, else whichever exists.
  const primaryId = sources.vegetan ? 'vegetan' : sources.commodity ? 'commodity' : adapter.id;
  const primary = sources[primaryId];

  const meta = {
    generatedAt: new Date().toISOString(),
    primarySource: primaryId,
    sources,
    // Back-compat top-level fields (existing build/templates/tests read these).
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
    itemCount: Object.values(sources).reduce((a, s) => a + (s.itemCount || 0), 0),
    totalPoints: Object.values(sources).reduce((a, s) => a + (s.totalPoints || 0), 0),
    latestDate: primary.latestDate,
    missing: primary.missing,
  };
  await fs.writeFile(path.join(DATA_DIR, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

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
