// Vegetan (独立行政法人農畜産業振興機構「ベジ探」) parsing + normalization.
// Pure functions over already-loaded xlsx Buffers, so this is unit-testable
// against the committed fixtures with no network or fs of its own.
//
// Two source shapes are normalized here (see docs/data-sources.md):
//
//   1. Daily wholesale books  (kakakugurafu/{youkeisai,kasai,konsai,imo}.xlsx)
//      One sheet per item. Each sheet stacks ~4 market blocks; we take the
//      FIRST block, whose title row names 東京都中央卸売市場. A block is:
//        [date row]  A = Excel serial for the month start, then day labels
//                    ("6/1","2","4",... crossing months as "7/2" etc.)
//        [入荷量]    arrival volume per day
//        [卸売価格]  wholesale price per day (¥/kg)  ← primary series value
//        [平均価格]  the seasonal normal (平年値) per day
//        [平年比]    ratio = 卸売価格 / 平年値
//      Cells may be null (future days) or the string "#N/A"; those are skipped.
//
//   2. Monthly long-term books (wp-content/uploads/{item}.xlsx)
//      A "Sheet１" grid: header row of year columns (和暦/西暦 mixed) + a
//      trailing 平年値 column; month rows "1月".."12月"; a 年平均値 row.
//
// Output per item: { daily: [{date,price,arrival,normalPrice,normalRatio}],
//                    monthly: [{date, price}] }, dates ascending.

import { parseXlsx } from './xlsx.mjs';
import { parseJpYear, excelSerialToYmd, pad2 } from './wareki.mjs';

function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '' || s === '#N/A' || /^#/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function isDateSerial(v) {
  return typeof v === 'number' && v > 40000 && v < 90000;
}

// Locate the four data rows following a date row by their leading labels,
// scanning a small window so we're robust to minor layout shifts.
function findLabeledRows(grid, dateRowIdx) {
  const want = {
    arrival: /入荷/,
    price: /卸売/,
    normalPrice: /平均/,
    normalRatio: /平年比/,
  };
  const found = {};
  for (let r = dateRowIdx + 1; r <= dateRowIdx + 8 && r < grid.length; r++) {
    const label = grid[r] && grid[r][0] != null ? String(grid[r][0]) : '';
    for (const [key, re] of Object.entries(want)) {
      if (found[key] == null && re.test(label)) found[key] = grid[r];
    }
    // Stop once we hit the next block's date row.
    if (r > dateRowIdx + 1 && isDateSerial(grid[r] && grid[r][0])) break;
  }
  return found;
}

// Parse the first (東京) market block of a daily item sheet into daily points.
export function parseDailySheet(grid) {
  let dateRowIdx = -1;
  for (let r = 0; r < grid.length; r++) {
    if (isDateSerial(grid[r] && grid[r][0])) {
      dateRowIdx = r;
      break;
    }
  }
  if (dateRowIdx === -1) return [];

  const dateRow = grid[dateRowIdx];
  const anchor = excelSerialToYmd(dateRow[0]);
  if (!anchor) return [];
  const rows = findLabeledRows(grid, dateRowIdx);
  if (!rows.price) return [];

  let year = anchor.year;
  let month = anchor.month;
  let prevMonth = null;
  const out = [];

  for (let c = 1; c < dateRow.length; c++) {
    const rawLabel = dateRow[c];
    if (rawLabel == null || String(rawLabel).trim() === '') continue;
    const label = String(rawLabel).trim();

    let day;
    const md = label.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
    if (md) {
      month = parseInt(md[1], 10);
      day = parseInt(md[2], 10);
    } else {
      const d = label.match(/(\d{1,2})/);
      if (!d) continue;
      day = parseInt(d[1], 10);
    }
    // Roll the year forward when the month wraps (e.g. Dec -> Jan).
    if (prevMonth != null && month < prevMonth) year += 1;
    prevMonth = month;

    const price = num(rows.price[c]);
    if (price == null) continue; // no wholesale price yet ⇒ skip the day

    out.push({
      date: `${year}-${pad2(month)}-${pad2(day)}`,
      price,
      arrival: rows.arrival ? num(rows.arrival[c]) : null,
      normalPrice: rows.normalPrice ? num(rows.normalPrice[c]) : null,
      normalRatio: rows.normalRatio ? num(rows.normalRatio[c]) : null,
    });
  }

  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

// Pick the data-bearing sheet of a monthly workbook (skip the "Graph" chart
// sheet). Returns { grid, headerIdx, yearCols:[{c,year}] } or null.
function findMonthlySheet(wb) {
  for (const name of wb.sheetNames) {
    const grid = wb.sheet(name);
    for (let r = 0; r < Math.min(grid.length, 6); r++) {
      const row = grid[r] || [];
      const yearCols = [];
      for (let c = 0; c < row.length; c++) {
        const y = parseJpYear(row[c]);
        if (y) yearCols.push({ c, year: y });
      }
      if (yearCols.length >= 2) return { grid, headerIdx: r, yearCols };
    }
  }
  return null;
}

// Parse a monthly long-term workbook into [{date:"YYYY-MM-01", price}].
export function parseMonthlyWorkbook(wb) {
  const found = findMonthlySheet(wb);
  if (!found) return [];
  const { grid, headerIdx, yearCols } = found;
  const out = [];

  // The workbooks carry one UNLABELED leading data column (the earliest year,
  // 2005) whose header cell is blank — confirmed by the 平年値 column equaling
  // avg(2021-2025) under strict index alignment. Recover it as (firstYear-1)
  // when that column holds numeric month data, so the long-term chart reaches
  // back to 2005 as intended.
  const labeled = new Set(yearCols.map((y) => y.c));
  const minCol = Math.min(...yearCols.map((y) => y.c));
  const minYear = yearCols.find((y) => y.c === minCol).year;
  const leadCol = minCol - 1;
  if (leadCol >= 2 && !labeled.has(leadCol) && parseJpYear(grid[headerIdx][leadCol]) == null) {
    let hasData = false;
    for (let r = headerIdx + 1; r < grid.length && !hasData; r++) {
      const row = grid[r] || [];
      if (/^\d{1,2}\s*月/.test(String(row[1] || '')) && num(row[leadCol]) != null) hasData = true;
    }
    if (hasData) yearCols.push({ c: leadCol, year: minYear - 1 });
  }

  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    // Month label lives in an early column; "1月".."12月". Skip 年平均値.
    let month = null;
    for (let c = 0; c <= 2 && c < row.length; c++) {
      const m = row[c] != null && String(row[c]).match(/^(\d{1,2})\s*月/);
      if (m) {
        month = parseInt(m[1], 10);
        break;
      }
    }
    if (month == null || month < 1 || month > 12) continue;

    for (const { c, year } of yearCols) {
      const price = num(row[c]);
      if (price == null) continue;
      out.push({ date: `${year}-${pad2(month)}-01`, price });
    }
  }

  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

// High-level normalization. `books` is { daily: {bookKey: Buffer},
// monthly: {monthlyKey: Buffer} } as produced by the vegetan adapter (from
// HTTP or fixtures — the path is identical downstream). Returns an array of
// item records mirroring the catalog metadata plus daily/monthly series.
export function normalizeVegetan(books, catalogItems) {
  const dailyWorkbooks = new Map(); // bookKey -> parsed workbook (cached)
  const getDaily = (key) => {
    if (!key) return null;
    if (!dailyWorkbooks.has(key)) {
      const buf = books.daily && books.daily[key];
      dailyWorkbooks.set(key, buf ? parseXlsx(buf) : null);
    }
    return dailyWorkbooks.get(key);
  };

  const items = [];
  const missing = [];
  for (const it of catalogItems) {
    let daily = [];
    if (it.dailyBook && it.dailySheet) {
      const wb = getDaily(it.dailyBook);
      if (wb && wb.sheetNames.includes(it.dailySheet)) {
        daily = parseDailySheet(wb.sheet(it.dailySheet));
      }
    }

    let monthly = [];
    const mbuf = books.monthly && books.monthly[it.monthlyKey];
    if (mbuf) monthly = parseMonthlyWorkbook(parseXlsx(mbuf));

    if (daily.length === 0 && monthly.length === 0) {
      missing.push(it.slug);
      continue;
    }

    // Primary series consumed by the rest of the system: the daily wholesale
    // prices when available, otherwise the monthly long-term series (used for
    // monthly-only items like アスパラガス・さつまいも・ごぼう・れんこん).
    const series = daily.length ? daily : monthly.map((m) => ({ ...m }));

    items.push({
      slug: it.slug,
      name: it.name,
      emoji: it.emoji,
      category: it.category,
      unit: it.unit,
      origin: it.origin,
      season: it.season,
      buyKeyword: it.buyKeyword,
      source: 'vegetan',
      hasDaily: daily.length > 0,
      series,
      monthly,
    });
  }

  return { items, missing };
}
