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

// A daily wholesale point is "buy now" (買い時) when its source-provided 平年比
// (normalRatio = price / seasonal-normal) drops below this threshold, i.e. the
// price is >10% under its平年 level. Matches the spec (normalRatio < 0.9).
export const BUY_RATIO_THRESHOLD = 0.9;

// Nearest daily point at least `days` before the last point (for a daily-based
// "recent move" used in the veg riser/faller ranking). Falls back to the first
// point when the window predates the available data.
function priceDaysAgo(series, days) {
  if (series.length === 0) return null;
  const lastMs = new Date(`${series[series.length - 1].date}T00:00:00Z`).getTime();
  const cutoff = lastMs - days * 86400000;
  let pick = series[0];
  for (const p of series) {
    const t = new Date(`${p.date}T00:00:00Z`).getTime();
    if (t <= cutoff) pick = p;
    else break;
  }
  return pick.price;
}

// Month-over-month / year-over-year from a monthly [{date,price}] series.
function monthlyChange(monthly, backMonths) {
  if (!monthly || monthly.length < 2) return null;
  const last = monthly[monthly.length - 1];
  const target = shiftMonths(ym(last.date), backMonths);
  const ref = findByYm(monthly, target);
  return ref ? pct(ref.price, last.price) : null;
}

// Vegetan daily items: primary series is the daily wholesale prices, and the
// authoritative 平年比 comes straight from the source (not recomputed). mom/yoy
// come from the item's monthly long-term series. Buy/ranking are daily-based.
export function computeVegDailyStats(item) {
  const s = item.series;
  if (!s || s.length === 0) return null;
  const latest = s[s.length - 1];
  const prev = s.length >= 2 ? s[s.length - 2] : null;
  const monthly = item.monthly || [];

  const prices = s.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const minPoint = s.find((p) => p.price === min);
  const maxPoint = s.find((p) => p.price === max);

  const normalRatio = latest.normalRatio;
  const vsNormalPct = normalRatio != null ? (normalRatio - 1) * 100 : null;
  const normal = latest.normalPrice != null ? latest.normalPrice : null;

  const isBuy = normalRatio != null && normalRatio < BUY_RATIO_THRESHOLD;
  const buyScore = normalRatio != null ? (1 - normalRatio) * 100 : 0;

  const wowPct = pct(priceDaysAgo(s, 7), latest.price); // recent (weekly) move
  const momPct = monthlyChange(monthly, 1);
  const yoyPct = monthlyChange(monthly, 12);

  return {
    slug: item.slug,
    daily: true,
    latest,
    prev,
    min,
    max,
    minPoint,
    maxPoint,
    normal,
    normalRatio,
    avgAll: mean(prices),
    momPct,
    yoyPct,
    vsNormalPct,
    wowPct,
    rankPct: wowPct, // veg ranking is daily-based
    isBuy,
    buyScore,
    pointCount: s.length,
    firstDate: s[0].date,
    lastDate: latest.date,
    monthlyCount: monthly.length,
    monthlyFirst: monthly.length ? monthly[0].date : null,
    monthlyLast: monthly.length ? monthly[monthly.length - 1].date : null,
  };
}

export function computeItemStats(item) {
  // Daily vegetable items get source-provided 平年比 + daily-based ranking.
  if (item && item.source === 'vegetan' && item.hasDaily) {
    return computeVegDailyStats(item);
  }

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

  const monthly = item.monthly || [];
  return {
    slug: item.slug,
    daily: false,
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
    rankPct: momPct, // monthly items rank on前月比
    isBuy,
    buyScore,
    pointCount: s.length,
    firstDate: s[0].date,
    lastDate: latest.date,
    monthlyCount: monthly.length,
    monthlyFirst: monthly.length ? monthly[0].date : null,
    monthlyLast: monthly.length ? monthly[monthly.length - 1].date : null,
  };
}

// Build ranking tables across all items. `rankPct` is the source-appropriate
// change metric (daily weekly move for veg, 前月比 for monthly items); it falls
// back to momPct so existing monthly-only callers keep working.
export function buildRankings(itemsWithStats) {
  const key = (x) => (x.stats.rankPct != null ? x.stats.rankPct : x.stats.momPct);
  const withMove = itemsWithStats.filter((x) => x.stats && key(x) != null);
  const risers = [...withMove].sort((a, b) => key(b) - key(a));
  const fallers = [...withMove].sort((a, b) => key(a) - key(b));

  const buys = itemsWithStats
    .filter((x) => x.stats && x.stats.isBuy)
    .sort((a, b) => b.stats.buyScore - a.stats.buyScore);

  return {
    risers: risers.slice(0, 5),
    fallers: fallers.slice(0, 5),
    buys: buys.slice(0, 8),
  };
}
