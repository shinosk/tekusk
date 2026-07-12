// Retail (小売) price parsing + normalization for ALIC「ベジ探」's
// 都市別小売価格調査 workbooks (kouri_cyousa/{name}.xlsx). Pure functions over
// already-loaded xlsx Buffers, so this is unit-testable against the committed
// fixtures with no network or fs of its own.
//
// Source shape (confirmed from the committed fixtures, e.g.
// test/fixtures/vegetan/041-...tomato.xlsx):
//
//   * One sheet per item (sheet name = 品目名, e.g.「トマト」). ねぎ books carry
//     two sheets (白ねぎ・青ねぎ); we take the one named in the catalog.
//   * Row 1 title: "{品目}の小売価格等の状況（令和８年度）" — the fiscal year (年度)
//     is authoritative for dating each month.
//   * The FIRST data block is「小売価格（円/kg）」. A header row carries month
//     labels ("５月".."３月"); the fiscal year starts in April, so the single
//     unlabeled leading data column (col 2) is 4月.
//   * Rows below the header are cities (札幌市, 仙台市, 東京23区, 金沢市, 名古屋市,
//     大阪市, 広島市, 高松市, 福岡市) plus a「全国」national aggregate. Values are
//     the retail price (円/kg); empty cells are months not yet surveyed.
//
// Because the調査 is MONTHLY, downstream framing must say「月次調査」, never
// 「毎日更新」.
//
// Output per item: { slug, name, ..., cities: [{ cityName, citySlug,
//   series:[{date:"YYYY-MM-01", price}] }] }, dates ascending. The「全国」row is
// carried as a city with citySlug "national" so callers can use it for the
// index overview while skipping it when generating per-city pages.

import { parseXlsx } from './xlsx.mjs';
import { pad2 } from './wareki.mjs';

// Era name -> Gregorian year of its 元年 (year 1); mirrors wareki.mjs but here
// we accept the 年度 (fiscal-year) suffix used by the retail titles.
const ERAS = [
  ['令和', 2019],
  ['平成', 1989],
  ['昭和', 1926],
];

function toHalfWidth(s) {
  return String(s).replace(/[０-９]/g, (d) => '０１２３４５６７８９'.indexOf(d));
}

function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = toHalfWidth(String(v).trim());
  if (s === '' || s === '#N/A' || /^#/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// "…（令和８年度）" -> 2026 (the Gregorian year in which the fiscal year starts).
// Returns null when no era-year is present so the caller can fall back to a
// reference date.
export function parseFiscalYear(title) {
  if (title == null) return null;
  const s = toHalfWidth(String(title));
  for (const [name, base] of ERAS) {
    const m = s.match(new RegExp(`${name}\\s*(元|[0-9]+)\\s*年度`));
    if (m) {
      const n = m[1] === '元' ? 1 : parseInt(m[1], 10);
      if (Number.isFinite(n)) return base + n - 1;
    }
  }
  const w = s.match(/((?:19|20)\d{2})\s*年度/);
  if (w) return parseInt(w[1], 10);
  return null;
}

// The fiscal year starts in April: months 4..12 belong to the start year,
// months 1..3 to the following calendar year.
function calendarYear(fiscalStartYear, month) {
  return month >= 4 ? fiscalStartYear : fiscalStartYear + 1;
}

function looksLikeCity(v) {
  if (v == null) return false;
  return /(市|区|全国)/.test(String(v));
}

// Build a { columnIndex -> month } map from the block's header row. Labeled
// columns ("５月") are authoritative; the fiscal year starts in April, so any
// unlabeled data column immediately to the LEFT of the earliest labeled month
// is filled in with decreasing months (recovering the unlabeled 4月 column).
function monthColumns(headerRow, cityCol) {
  const byCol = new Map();
  for (let c = cityCol + 1; c < headerRow.length; c++) {
    const cell = headerRow[c];
    if (cell == null) continue;
    const m = toHalfWidth(String(cell)).match(/([0-9]+)\s*月/);
    if (m) {
      const mm = parseInt(m[1], 10);
      if (mm >= 1 && mm <= 12) byCol.set(c, mm);
    }
  }
  if (byCol.size) {
    const firstLabeled = Math.min(...byCol.keys());
    let mo = byCol.get(firstLabeled) - 1;
    for (let c = firstLabeled - 1; c > cityCol && mo >= 1; c--, mo--) {
      if (!byCol.has(c)) byCol.set(c, mo);
    }
  }
  return byCol;
}

// Parse the first「小売価格」block of a retail item sheet into a per-city list.
// `opts.fiscalYear` overrides the year parsed from the title (mainly for tests);
// `opts.now` supplies the fallback fiscal year when neither is available.
export function parseRetailSheet(grid, opts = {}) {
  // Locate the header row (a row with at least two "N月" labels) and the city
  // column (the column holding city names in the following rows).
  let headerIdx = -1;
  for (let r = 0; r < Math.min(grid.length, 12); r++) {
    const row = grid[r] || [];
    let monthCells = 0;
    for (const cell of row) if (cell != null && /月/.test(toHalfWidth(String(cell)))) monthCells += 1;
    if (monthCells >= 2) {
      headerIdx = r;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const headerRow = grid[headerIdx];
  // City column = first column whose next row holds a city-looking label.
  let cityCol = 1;
  for (let c = 0; c < headerRow.length; c++) {
    const below = grid[headerIdx + 1] && grid[headerIdx + 1][c];
    if (looksLikeCity(below)) {
      cityCol = c;
      break;
    }
  }

  const byCol = monthColumns(headerRow, cityCol);
  if (byCol.size === 0) return [];

  let fiscalYear = opts.fiscalYear;
  if (fiscalYear == null) {
    // Title lives in an early row (row 1 in the fixtures).
    for (let r = 0; r <= headerIdx; r++) {
      const row = grid[r] || [];
      for (const cell of row) {
        const y = parseFiscalYear(cell);
        if (y != null) {
          fiscalYear = y;
          break;
        }
      }
      if (fiscalYear != null) break;
    }
  }
  if (fiscalYear == null) {
    const now = opts.now instanceof Date ? opts.now : new Date();
    const y = now.getUTCFullYear();
    fiscalYear = now.getUTCMonth() + 1 >= 4 ? y : y - 1;
  }

  const cols = [...byCol.entries()].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const cityName = row[cityCol];
    if (!looksLikeCity(cityName)) break; // first block only: stop at its end
    const series = [];
    for (const [c, month] of cols) {
      const price = num(row[c]);
      if (price == null) continue;
      series.push({ date: `${calendarYear(fiscalYear, month)}-${pad2(month)}-01`, price });
    }
    series.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    out.push({ cityName: String(cityName).trim(), series });
  }
  return out;
}

// Parse a whole retail workbook for one item. `sheetName` selects the sheet
// (needed for the ねぎ book which carries 白ねぎ/青ねぎ); defaults to the first.
// `cityMap` is { 都市名: slug } from config; unknown cities get a romaji-free
// fallback slug derived from position so nothing is silently dropped.
export function parseRetailWorkbook(wb, { sheetName, cityMap = {}, fiscalYear, now } = {}) {
  const name = sheetName && wb.sheetNames.includes(sheetName) ? sheetName : wb.sheetNames[0];
  if (!name) return [];
  const rows = parseRetailSheet(wb.sheet(name), { fiscalYear, now });
  return rows.map((row) => ({
    cityName: row.cityName,
    citySlug: cityMap[row.cityName] || null,
    series: row.series,
  }));
}

// High-level normalization. `books` is { retailKey: Buffer } as produced by the
// retail adapter (HTTP or fixtures — identical downstream). `catalogItems` are
// the catalog entries that carry a `retailKey`/`retailSheet`. `cityMap` is the
// 都市名→slug table from config. Returns { items, missing }.
// ---- View helpers (pure) — consumed by scripts/build.mjs -----------------

// Latest point of a monthly series plus its前月比 (month-over-month %). Returns
// null for an empty series. Assumes the series is ascending by date.
export function latestChange(series) {
  if (!series || series.length === 0) return null;
  const last = series[series.length - 1];
  const prev = series.length >= 2 ? series[series.length - 2] : null;
  const momPct =
    prev && prev.price ? ((last.price - prev.price) / prev.price) * 100 : null;
  return { date: last.date, price: last.price, prevPrice: prev ? prev.price : null, momPct };
}

// Sorted unique "YYYY-MM-01" dates across a list of series, most recent last,
// capped to the last `limit` months so tables stay small.
export function monthsAcross(seriesList, limit = 12) {
  const set = new Set();
  for (const s of seriesList || []) for (const p of s || []) set.add(p.date);
  const all = [...set].sort();
  return limit ? all.slice(-limit) : all;
}

// Find a city entry (by slug) inside a retail record's `cities` array.
export function cityOf(record, citySlug) {
  return (record.cities || []).find((c) => c.citySlug === citySlug) || null;
}

export function normalizeRetail(books, catalogItems, cityMap = {}, opts = {}) {
  const items = [];
  const missing = [];
  const cache = new Map();
  const getWb = (key) => {
    if (!cache.has(key)) {
      const buf = books && books[key];
      cache.set(key, buf ? parseXlsx(buf) : null);
    }
    return cache.get(key);
  };

  for (const it of catalogItems) {
    if (!it.retailKey) continue;
    const wb = getWb(it.retailKey);
    if (!wb) {
      missing.push(it.slug);
      continue;
    }
    const cities = parseRetailWorkbook(wb, {
      sheetName: it.retailSheet,
      cityMap,
      now: opts.now,
    }).filter((c) => c.citySlug && c.series.length);

    if (cities.length === 0) {
      missing.push(it.slug);
      continue;
    }
    items.push({
      slug: it.slug,
      name: it.name,
      emoji: it.emoji,
      category: it.category,
      unit: it.unit,
      cities,
    });
  }
  return { items, missing };
}
