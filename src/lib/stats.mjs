// Derived statistics over a normalized price series. Pure + unit-testable.
// A "series" is an ascending array of { date: "YYYY-MM-DD", price: number }.

export function ym(date) {
  return String(date).slice(0, 7); // "YYYY-MM"
}
export function month(date) {
  return String(date).slice(5, 7); // "MM"
}

export function pct(from, to) {
  if (from == null || to == null || from === 0) return null;
  return ((to - from) / from) * 100;
}

export function mean(nums) {
  const xs = nums.filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Shift a "YYYY-MM" by -n months.
export function shiftMonths(yyyymm, n) {
  const [y, m] = yyyymm.split('-').map(Number);
  const total = y * 12 + (m - 1) - n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}`;
}

export function findByYm(series, targetYm) {
  return series.find((p) => ym(p.date) === targetYm) || null;
}

// "平年値" (normal value): average price for the same calendar month across
// all available years — the standard definition of a平年 comparison.
export function normalForMonth(series, mm) {
  const vals = series.filter((p) => month(p.date) === mm).map((p) => p.price);
  return mean(vals);
}

// Trailing moving average of the last n points.
export function movingAverage(series, n) {
  if (series.length === 0) return null;
  const slice = series.slice(-n);
  return mean(slice.map((p) => p.price));
}

export function computeItemStats(item) {
  const s = item.series;
  if (!s || s.length === 0) return null;

  const latest = s[s.length - 1];
  const prev = s.length >= 2 ? s[s.length - 2] : null;
  const latestYm = ym(latest.date);
  const yearAgo = findByYm(s, shiftMonths(latestYm, 12));

  const prices = s.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const minPoint = s.find((p) => p.price === min);
  const maxPoint = s.find((p) => p.price === max);

  const normal = normalForMonth(s, month(latest.date));
  const ma12 = movingAverage(s, 12);
  const avgAll = mean(prices);

  const momPct = prev ? pct(prev.price, latest.price) : null;
  const yoyPct = yearAgo ? pct(yearAgo.price, latest.price) : null;
  const vsNormalPct = normal != null ? pct(normal, latest.price) : null;
  const vsMa12Pct = ma12 != null ? pct(ma12, latest.price) : null;

  // Buy signal: cheaper than its seasonal normal AND cheaper than the recent
  // 12-point trend. buyScore is how far below normal (positive = cheaper).
  const belowNormal = vsNormalPct != null && vsNormalPct < 0;
  const belowTrend = vsMa12Pct != null && vsMa12Pct < 0;
  const isBuy = belowNormal && belowTrend;
  const buyScore = vsNormalPct != null ? -vsNormalPct : 0;

  return {
    slug: item.slug,
    latest,
    prev,
    yearAgo,
    min,
    max,
    minPoint,
    maxPoint,
    normal,
    ma12,
    avgAll,
    momPct,
    yoyPct,
    vsNormalPct,
    vsMa12Pct,
    isBuy,
    buyScore,
    pointCount: s.length,
    firstDate: s[0].date,
    lastDate: latest.date,
  };
}

// Build ranking tables across all items.
export function buildRankings(itemsWithStats) {
  const withMom = itemsWithStats.filter((x) => x.stats && x.stats.momPct != null);
  const risers = [...withMom].sort((a, b) => b.stats.momPct - a.stats.momPct);
  const fallers = [...withMom].sort((a, b) => a.stats.momPct - b.stats.momPct);

  const buys = itemsWithStats
    .filter((x) => x.stats && x.stats.isBuy)
    .sort((a, b) => b.stats.buyScore - a.stats.buyScore);

  return {
    risers: risers.slice(0, 5),
    fallers: fallers.slice(0, 5),
    buys: buys.slice(0, 8),
  };
}
