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
//
// Usage:
//   node scripts/fetch.mjs [--source=commodity|estat] [--strict]
//   SOURCE=commodity node scripts/fetch.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR, DATA_DIR, DATA_ITEMS_DIR } from '../src/lib/paths.mjs';
import { getAdapter } from '../src/lib/sources.mjs';
import { normalizeItems, mergeSeries } from '../src/lib/normalize.mjs';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const sourceArg =
  (args.find((a) => a.startsWith('--source=')) || '').split('=')[1] ||
  process.env.SOURCE ||
  'commodity';

async function readJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

async function loadExistingSeries(slug) {
  const rec = await readJson(path.join(DATA_ITEMS_DIR, `${slug}.json`), null);
  return rec && Array.isArray(rec.series) ? rec.series : [];
}

async function main() {
  const catalog = await readJson(path.join(CONFIG_DIR, 'items.json'), { items: [] });
  const adapter = getAdapter(sourceArg);

  console.log(`[fetch] source=${adapter.id} (${adapter.title})`);
  console.log(`[fetch] url=${adapter.url}`);

  const csv = await adapter.fetchCsv({ retries: 4, timeoutMs: 30000 });
  const { items, missing, rowCount } = normalizeItems(csv, catalog.items);

  if (items.length === 0) {
    throw new Error('normalize produced 0 items — refusing to overwrite data');
  }
  console.log(
    `[fetch] parsed ${rowCount} rows -> ${items.length} items` +
      (missing.length ? `, missing columns: ${missing.join(', ')}` : '')
  );

  await fs.mkdir(DATA_ITEMS_DIR, { recursive: true });

  let totalPoints = 0;
  let latestDate = '';
  for (const it of items) {
    const existing = await loadExistingSeries(it.slug);
    const series = mergeSeries(existing, it.series);
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
      updatedAt: new Date().toISOString(),
      series,
    };
    await fs.writeFile(
      path.join(DATA_ITEMS_DIR, `${it.slug}.json`),
      JSON.stringify(record, null, 2) + '\n'
    );
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    source: {
      id: adapter.id,
      title: adapter.title,
      url: adapter.url,
      homepage: adapter.homepage,
      license: adapter.license,
      licenseUrl: adapter.licenseUrl,
      attribution: adapter.attribution,
      cadence: adapter.cadence,
    },
    itemCount: items.length,
    totalPoints,
    latestDate,
    missing,
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
