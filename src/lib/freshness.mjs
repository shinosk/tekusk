// Data freshness / "archive mode" detection. Pure functions, unit-testable.
//
// Why this exists: the site's public copy ("毎日自動更新", "今日の価格" etc.)
// is only honest while the underlying data source is actually live. The
// currently wired-up `commodity` adapter is a frozen 2017-06 archive (see
// docs/data-sources.md), so publishing "daily update" language against it
// would be misleading. Rather than hand-edit copy, the build derives whether
// the latest known data point is "stale" (older than STALE_THRESHOLD_DAYS)
// and switches every user-facing string accordingly. The moment a live
// source (e.g. the `estat` adapter once implemented) produces a recent date,
// `isArchiveMode` flips to false and the "daily update" copy returns
// automatically — no manual copy changes required.

export const STALE_THRESHOLD_DAYS = 90;

// Days between `dateStr` ("YYYY-MM-DD") and `now`. Missing/invalid dates are
// treated as infinitely stale so the site fails safe into "archive" framing
// rather than falsely claiming freshness.
export function daysSince(dateStr, now = new Date()) {
  if (!dateStr) return Infinity;
  const then = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`).getTime();
  if (Number.isNaN(then)) return Infinity;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (Number.isNaN(nowMs)) return Infinity;
  return Math.floor((nowMs - then) / 86400000);
}

export function isArchiveMode(latestDate, now = new Date(), thresholdDays = STALE_THRESHOLD_DAYS) {
  return daysSince(latestDate, now) > thresholdDays;
}

// "YYYY-MM-DD" -> "YYYY年M月". Kept local (rather than importing format.mjs)
// so this module has zero dependencies and stays trivially testable.
function ymLabel(dateStr) {
  if (!dateStr) return '—';
  const [y, m] = String(dateStr).split('-');
  return `${y}年${Number(m)}月`;
}

// Returns the bundle of copy variants the build/templates consume. Every
// string here is safe to interpolate into templates that don't otherwise
// escape their own static copy (matches the existing layout.mjs convention).
export function freshnessCopy(latestDate, now = new Date(), thresholdDays = STALE_THRESHOLD_DAYS) {
  const archive = isArchiveMode(latestDate, now, thresholdDays);

  if (!archive) {
    return {
      archive: false,
      label: ymLabel(latestDate),
      tagline: '野菜・果物・食品の市況価格を自動で毎日チェック',
      description:
        '野菜・果物をはじめとする食品コモディティの国際市況価格を毎日自動更新。品目別の価格推移、平年比、いまが買い時の品目をわかりやすく可視化するユーティリティサイトです。',
      indexTitle: '今週の野菜・食品価格ナビ',
      priceLabel: '最新価格',
      updateNotice: 'データは毎日自動で取得・更新しています。',
      footerNotice: '本サイトは公開オープンデータをもとに<strong>自動生成・毎日更新</strong>される情報サイトです。',
      banner: null,
    };
  }

  const label = ymLabel(latestDate);
  const banner = `本サイトのデータは${label}時点までの月次アーカイブです。`;
  return {
    archive: true,
    label,
    tagline: `国際市況の長期価格アーカイブ（1980〜2017年・月次）`,
    description: `野菜・果物をはじめとする食品コモディティの国際市況価格（月次・${label}まで）の長期アーカイブです。品目別の価格推移や平年比を可視化しています。最新のデータソースに切り替わり次第、自動で毎日更新に戻ります。`,
    indexTitle: '野菜・食品価格アーカイブ',
    priceLabel: '最新月の価格',
    updateNotice: banner,
    footerNotice: `本サイトのデータは${label}時点までの月次アーカイブです。編集者による手動更新は行っていません。`,
    banner,
  };
}
