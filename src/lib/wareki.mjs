// Japanese calendar helpers, dependency-free and pure (unit-testable).
//
// Vegetan's monthly long-term workbooks label year columns with a mix of
// Japanese era years (和暦, e.g. "平成18年") and Western years (西暦, e.g.
// "2008年"), sometimes with trailing furigana ("平成18年ヘイセイネン").
// parseJpYear normalizes any of these to a 4-digit Western year.

// Era name -> Gregorian year of its 元年 (year 1).
const ERAS = [
  ['令和', 2019],
  ['平成', 1989],
  ['昭和', 1926],
  ['大正', 1912],
  ['明治', 1868],
];

// "平成18年" -> 2006, "令和8年" -> 2026, "2008年" -> 2008, "令和元年" -> 2019.
// Returns null when the cell is not a recognizable year (e.g. "平年値").
export function parseJpYear(cell) {
  if (cell == null) return null;
  const s = String(cell).trim();
  if (s === '') return null;

  for (const [name, base] of ERAS) {
    const m = s.match(new RegExp(`${name}\\s*(元|[0-9]+)\\s*年`));
    if (m) {
      const n = m[1] === '元' ? 1 : parseInt(m[1], 10);
      if (Number.isFinite(n)) return base + n - 1;
    }
  }
  // Western year: "2008年" or a bare 4-digit "2008" (but not a longer number).
  const m = s.match(/(?:^|[^0-9])((?:19|20)\d{2})\s*年/) || s.match(/^\s*((?:19|20)\d{2})\s*$/);
  if (m) return parseInt(m[1], 10);
  return null;
}

// Excel stores dates as a serial day count from 1899-12-30 (the "1900 date
// system", accounting for Excel's fictional 1900-02-29). For the serials we
// see (>= 60) this simple offset is exact. Returns { year, month, day }.
export function excelSerialToYmd(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.round(n) * 86400000;
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}
