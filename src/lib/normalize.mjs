// Normalization: turn a wide CSV (one column per commodity, one row per date)
// into per-item time series. Pure functions only, so this is unit-testable
// without any network or filesystem access.

import { parseCsv, parseNumber } from './csv.mjs';

// Normalize a date cell to an ISO "YYYY-MM-DD" string.
// The source uses month-start dates like "1980-02-01".
export function normalizeDate(cell) {
  if (!cell) return null;
  const s = String(cell).trim();
  const m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (!m) return null;
  const day = m[3] || '01';
  return `${m[1]}-${m[2]}-${day}`;
}

// Build a { column -> series } map from parsed CSV, keeping only valid points.
// series entries: { date: "YYYY-MM-DD", price: number }, sorted ascending.
export function buildSeriesByColumn(header, rows, columns) {
  const dateIdx = header.indexOf('Date');
  if (dateIdx === -1) {
    throw new Error('normalize: CSV is missing a "Date" column');
  }
  const colIdx = new Map();
  for (const col of columns) {
    const idx = header.indexOf(col);
    colIdx.set(col, idx); // may be -1 if absent; handled below
  }

  const out = new Map();
  for (const col of columns) out.set(col, []);

  for (const row of rows) {
    const date = normalizeDate(row[dateIdx]);
    if (!date) continue;
    for (const col of columns) {
      const idx = colIdx.get(col);
      if (idx == null || idx < 0) continue;
      const price = parseNumber(row[idx]);
      if (price == null) continue;
      out.get(col).push({ date, price });
    }
  }

  for (const [, series] of out) {
    series.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  return out;
}

// Merge two ascending series by date. Incoming points win on date collision.
// Keeps the accumulated history intact so incremental sources accumulate and
// a re-fetch of the same data is idempotent.
export function mergeSeries(existing = [], incoming = []) {
  const byDate = new Map();
  for (const p of existing) byDate.set(p.date, p.price);
  for (const p of incoming) byDate.set(p.date, p.price);
  return [...byDate.entries()]
    .map(([date, price]) => ({ date, price }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// High-level: raw CSV text + item catalog -> array of normalized item records.
// Each record: { ...itemMeta, series }. Items with an unknown/empty column are
// skipped (returned in `missing`) rather than throwing, so one bad mapping does
// not break the whole build.
export function normalizeItems(csvText, catalogItems) {
  const { header, rows } = parseCsv(csvText);
  const columns = catalogItems.map((it) => it.column);
  const seriesByCol = buildSeriesByColumn(header, rows, columns);

  const items = [];
  const missing = [];
  for (const it of catalogItems) {
    const series = seriesByCol.get(it.column) || [];
    if (series.length === 0) {
      missing.push(it.slug);
      continue;
    }
    items.push({
      slug: it.slug,
      name: it.name,
      emoji: it.emoji,
      category: it.category,
      unit: it.unit,
      origin: it.origin,
      season: it.season,
      buyKeyword: it.buyKeyword,
      column: it.column,
      series,
    });
  }
  return { items, missing, rowCount: rows.length, header };
}
