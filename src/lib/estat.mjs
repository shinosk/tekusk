// e-Stat (政府統計) adapter for 農林水産省「青果物卸売市場調査」(statsCode=00500226).
//
// This survey is ANNUAL (年次公表): the 令和6年（2024年）調査分 was published on
// 2026-03-31, so it is NOT a live/daily feed. The site keeps ベジ探 (vegetan) as
// the daily-fresh source and uses e-Stat as the "public-record detailed data"
// layer: per-item 産地別 (origin) shares + 消費地域別 (consumption-region) monthly
// wholesale prices for the latest published year.
//
// The pure functions here (discovery parsing, normalization, origin-share math)
// take already-loaded JSON and are unit-testable against the committed fixtures
// in test/fixtures/estat/. All network / appId handling lives in the adapter
// object at the bottom (which delegates its parsing to these pure functions), so
// the fetch→normalize path is identical for --fixtures and live HTTP, exactly
// like the vegetan/retail adapters.

// The two target table families under statsCode=00500226. Both contain the
// substring「主要消費地域別」which is what discovery searches on.
export const ESTAT_TABLE_CATEGORY_RE = /主要消費地域別/;

// ---- small helpers ---------------------------------------------------------

// e-Stat numeric cell -> number|null. Suppressed / not-applicable cells are
// the strings "-" and "…"; anything non-finite becomes null so downstream math
// simply skips it (works on the truncated 10000-row fixtures too).
export function estatNum(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw).trim();
  if (s === '' || s === '-' || s === '…' || s === '***' || s === 'X') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// "202401-202412" | "202401" -> 2024 (the survey's calendar year).
export function surveyYear(surveyDate) {
  const m = String(surveyDate || '').match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

// The annual data for calendar year Y is published ~15 months after year end
// (2024 → 2026-03-31). This estimates the newest year that could plausibly be
// available now, so the daily cron can decide to skip all API calls when the
// committed data already covers it. Conservative: only counts a year as
// available from April of Y+2 onward.
export function expectedLatestYear(now = new Date()) {
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth() + 1;
  return mo >= 4 ? y - 2 : y - 3;
}

// Always return an array for e-Stat fields that are an object when there is a
// single element and an array when there are many.
function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// ---- discovery (getStatsList / catalog-tail) ------------------------------

// Normalize a getStatsList response into a flat list of candidate tables that
// belong to the「主要消費地域別」families.
export function listTables(listJson) {
  const root = listJson && listJson.GET_STATS_LIST;
  const inf = root && root.DATALIST_INF;
  if (!inf) return [];
  return asArray(inf.TABLE_INF)
    .map((t) => {
      const spec = t.TITLE_SPEC || {};
      const title = t.TITLE && typeof t.TITLE === 'object' ? t.TITLE.$ : t.TITLE;
      return {
        id: String(t['@id']),
        category: spec.TABLE_CATEGORY || '',
        tableName: spec.TABLE_NAME || '',
        sub: spec.TABLE_SUB_CATEGORY1 || '',
        title: title || '',
        year: surveyYear(t.SURVEY_DATE),
        openDate: t.OPEN_DATE || '',
        cycle: t.CYCLE || '',
      };
    })
    .filter((t) => ESTAT_TABLE_CATEGORY_RE.test(t.category));
}

// Latest published survey year present in a table list (max SURVEY year).
export function latestListYear(tables) {
  let y = null;
  for (const t of tables) if (t.year != null && (y == null || t.year > y)) y = t.year;
  return y;
}

// Resolve which statsDataId serves each catalog item for a given year.
// Matching rule: TABLE_NAME === item.estatTitle, and — for items that carry an
// `estatVariety` (multi-variety fruits like りんご/ぶどう/メロン/日本なし/かき where
// we want the「計」table) — TABLE_SUB_CATEGORY1 === that variety. Items without
// a variety match a table with no sub-category (or fall back to the「計」sub).
// Returns [{ item, id, year, title }]; items with no match are skipped.
export function resolveItemTables(tables, items, year) {
  const byYear = tables.filter((t) => year == null || t.year === year);
  const out = [];
  for (const it of items) {
    if (!it.estatTitle) continue;
    const candidates = byYear.filter((t) => t.tableName === it.estatTitle);
    if (candidates.length === 0) continue;
    let hit;
    if (it.estatVariety) {
      hit = candidates.find((t) => t.sub === it.estatVariety);
    } else {
      hit =
        candidates.find((t) => !t.sub) ||
        candidates.find((t) => t.sub === '計') ||
        candidates[0];
    }
    if (!hit) continue;
    out.push({ item: it, id: hit.id, year: hit.year, title: hit.title });
  }
  return out;
}

// ---- getStatsData parsing / normalization ----------------------------------

const members = (o) => asArray(o && o.CLASS);

// month number (1..12) from an e-Stat time label. Handles both the vegetable
// tables ("2024年1月") and the fruit tables where 対象月 members are bare "1".."12".
function monthOfName(name) {
  const s = String(name == null ? '' : name);
  let m = s.match(/(\d{1,2})月/);
  if (!m) m = s.match(/^\s*(\d{1,2})\s*$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 12 ? n : null;
}

// The survey ships青果 tables in TWO shapes:
//   * VEGETABLE: 4 axes — 産地(48, has「計」) × 数量/価格 × 消費地域(12) × 対象月(13).
//   * FRUIT:     3 axes — 対象月(cat01) × 数量/価格 × 消費地域・産地(compound, members
//     like「東京都_産地計」= market total and「東京都_産地計_青森」= that market's
//     top origins). No separate 産地 or time axis.
// describeAxes detects which and returns the axis @ids + resolved special codes.
export function describeAxes(statData) {
  const objs = asArray(statData && statData.CLASS_INF && statData.CLASS_INF.CLASS_OBJ);
  const find = (pred) => objs.find(pred);

  const measure = find((o) => /数量/.test(o['@name'] || '') && /価格/.test(o['@name'] || ''));
  if (!measure) return null;
  const measureMembers = members(measure);
  const qtyCode = (measureMembers.find((c) => /数量/.test(c['@name'])) || {})['@code'];
  const priceMember = measureMembers.find((c) => /価格/.test(c['@name'])) || {};

  // 産地-only axis (vegetable path): name mentions 産地 but not 消費地域, has「計」.
  const originAxis = find(
    (o) =>
      o !== measure &&
      /産地/.test(o['@name'] || '') &&
      !/消費地域/.test(o['@name'] || '') &&
      members(o).some((c) => c['@name'] === '計')
  );
  const regionAxis = find((o) => o !== measure && /消費地域/.test(o['@name'] || ''));
  if (!regionAxis) return null;

  const base = {
    measureId: measure['@id'],
    regionId: regionAxis['@id'],
    qtyCode: qtyCode != null ? String(qtyCode) : null,
    priceCode: priceMember['@code'] != null ? String(priceMember['@code']) : null,
    priceUnit: priceMember['@unit'] || '円/kg',
  };

  if (originAxis) {
    // VEGETABLE (4-axis)
    const time = find((o) => o['@id'] === 'time' || /対象月|時間/.test(o['@name'] || ''));
    if (!time) return null;
    const monthOfCode = new Map();
    for (const c of members(time)) {
      const mm = monthOfName(c['@name']);
      if (mm) monthOfCode.set(String(c['@code']), mm);
    }
    const regionNames = new Map();
    for (const c of members(regionAxis)) regionNames.set(String(c['@code']), c['@name']);
    return {
      ...base,
      kind: 'veg',
      originId: originAxis['@id'],
      timeId: time['@id'],
      originTotal: (members(originAxis).find((c) => c['@name'] === '計') || {})['@code'] != null
        ? String((members(originAxis).find((c) => c['@name'] === '計') || {})['@code'])
        : null,
      timeTotal: (members(time).find((c) => c['@name'] === '計') || {})['@code'] != null
        ? String((members(time).find((c) => c['@name'] === '計') || {})['@code'])
        : null,
      regionNames,
      regionOrder: members(regionAxis).map((c) => c['@name']),
      originNames: new Map(members(originAxis).map((c) => [String(c['@code']), c['@name']])),
      monthOfCode,
    };
  }

  // FRUIT (3-axis). The remaining axis (not measure, not region) is 対象月.
  const time = find((o) => o !== measure && o !== regionAxis);
  if (!time) return null;
  const monthOfCode = new Map();
  for (const c of members(time)) {
    const mm = monthOfName(c['@name']);
    if (mm) monthOfCode.set(String(c['@code']), mm);
  }
  const timeTotal = (members(time).find((c) => c['@name'] === '計') || {})['@code'];
  // Parse each compound region·origin member: "市場_産地計" = market total,
  // "市場_産地計_産地名" = that market's named origin. regionOrder preserves the
  // survey order of the market totals.
  const regionOfCode = new Map(); // code -> market name (for totals only)
  const originOfCode = new Map(); // code -> { market, origin }
  const regionOrder = [];
  for (const c of members(regionAxis)) {
    const code = String(c['@code']);
    const name = String(c['@name']);
    const parts = name.split('_産地計');
    const market = parts[0];
    if (parts.length >= 2 && parts[1] && parts[1].startsWith('_')) {
      originOfCode.set(code, { market, origin: parts[1].slice(1) });
    } else {
      regionOfCode.set(code, market);
      if (!regionOrder.includes(market)) regionOrder.push(market);
    }
  }
  return {
    ...base,
    kind: 'fruit',
    timeId: time['@id'],
    timeTotal: timeTotal != null ? String(timeTotal) : null,
    monthOfCode,
    regionOfCode,
    originOfCode,
    regionOrder,
  };
}

// Extract, for either structure, the maps the finalizer needs:
//   regionMonth: Map(regionName -> Map(month -> {price,qty}))  — from the origin
//     total slice (供給 into each consumption market, by month)
//   originQty:   Map(originName -> annual quantity, summed across markets)
//   totalQty:    national annual quantity (sum of the region totals)
function extract(values, ax) {
  const mKey = '@' + ax.measureId;
  const rKey = '@' + ax.regionId;
  const tKey = '@' + ax.timeId;
  const regionMonth = new Map();
  const originQty = new Map();
  let totalQty = 0;

  const setSlot = (region, month, measureCode, val) => {
    if (!regionMonth.has(region)) regionMonth.set(region, new Map());
    const slot = regionMonth.get(region).get(month) || { price: null, qty: null };
    if (measureCode === ax.priceCode) slot.price = val;
    else if (measureCode === ax.qtyCode) slot.qty = val;
    regionMonth.get(region).set(month, slot);
  };

  for (const v of values) {
    const measureCode = String(v[mKey]);
    const timeCode = String(v[tKey]);
    const val = estatNum(v.$);
    if (val == null) continue;
    const isAnnual = timeCode === ax.timeTotal;
    const month = ax.monthOfCode.get(timeCode);

    if (ax.kind === 'veg') {
      const oKey = '@' + ax.originId;
      const originCode = String(v[oKey]);
      const isOriginTotal = originCode === ax.originTotal;
      if (isOriginTotal && month) {
        const region = ax.regionNames.get(String(v[rKey]));
        if (region) setSlot(region, month, measureCode, val);
      }
      if (isAnnual && measureCode === ax.qtyCode) {
        if (isOriginTotal) {
          totalQty += val;
        } else {
          const name = ax.originNames.get(originCode) || originCode;
          originQty.set(name, (originQty.get(name) || 0) + val);
        }
      }
    } else {
      // fruit: region·origin encoded in the region axis code
      const code = String(v[rKey]);
      const regionMarket = ax.regionOfCode.get(code);
      const originInfo = ax.originOfCode.get(code);
      if (regionMarket && month) setSlot(regionMarket, month, measureCode, val);
      if (isAnnual && measureCode === ax.qtyCode) {
        if (regionMarket) totalQty += val;
        else if (originInfo) originQty.set(originInfo.origin, (originQty.get(originInfo.origin) || 0) + val);
      }
    }
  }
  return { regionMonth, originQty, totalQty };
}

// Normalize a full getStatsData response for one catalog item into the compact
// record persisted to data/estat/<slug>.json. `resolved` carries the discovered
// { id, year, title }. Returns null when the response can't be interpreted.
export function normalizeEstat(dataJson, item, resolved = {}) {
  const statData = dataJson && dataJson.GET_STATS_DATA && dataJson.GET_STATS_DATA.STATISTICAL_DATA;
  if (!statData) return null;
  const ax = describeAxes(statData);
  if (!ax) return null;

  const values = asArray(statData.DATA_INF && statData.DATA_INF.VALUE);
  const { regionMonth, originQty, totalQty } = extract(values, ax);

  // regions: keep the survey's display order, drop empty ones.
  const regions = {};
  for (const name of ax.regionOrder) {
    const mm = regionMonth.get(name);
    if (!mm) continue;
    const arr = [...mm.entries()]
      .map(([month, s]) => ({ month, price: s.price, qty: s.qty }))
      .filter((p) => p.price != null || p.qty != null)
      .sort((a, b) => a.month - b.month);
    if (arr.length) regions[name] = arr;
  }
  const regionsOrder = ax.regionOrder.filter((n) => regions[n]);

  // national: quantity-weighted average price per month across regions.
  const national = [];
  for (let month = 1; month <= 12; month++) {
    let wsum = 0;
    let qsum = 0;
    let priceOnly = [];
    for (const name of regionsOrder) {
      const p = regions[name].find((x) => x.month === month);
      if (!p) continue;
      if (p.price != null && p.qty != null && p.qty > 0) {
        wsum += p.price * p.qty;
        qsum += p.qty;
      } else if (p.price != null) {
        priceOnly.push(p.price);
      }
    }
    let price = qsum > 0 ? wsum / qsum : priceOnly.length ? priceOnly.reduce((a, b) => a + b, 0) / priceOnly.length : null;
    if (price != null) national.push({ month, price: Math.round(price), qty: qsum || null });
  }

  // origins: top-5 産地 by annual quantity, share vs the national total. When the
  // 計 total is unavailable, fall back to the sum of the ranked origins.
  const denom = totalQty > 0 ? totalQty : [...originQty.values()].reduce((a, q) => a + q, 0);
  const origins = [...originQty.entries()]
    .map(([name, qty]) => ({ name, qty }))
    .filter((o) => o.qty > 0)
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 5)
    .map((o) => ({ name: o.name, qty: o.qty, share: denom > 0 ? o.qty / denom : null }));

  if (regionsOrder.length === 0 && origins.length === 0) return null;

  return {
    slug: item.slug,
    name: item.name,
    emoji: item.emoji,
    category: item.category,
    unit: item.unit || '円/kg',
    source: 'estat',
    year: resolved.year != null ? resolved.year : surveyYear(statData.TABLE_INF && statData.TABLE_INF.SURVEY_DATE),
    statsDataId: resolved.id || (statData.TABLE_INF && String(statData.TABLE_INF['@id'])) || null,
    title: resolved.title || (statData.TABLE_INF && statData.TABLE_INF.TITLE && statData.TABLE_INF.TITLE.$) || '',
    priceUnit: ax.priceUnit,
    regionsOrder,
    regions,
    national,
    origins,
  };
}
