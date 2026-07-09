// Japanese-friendly formatting helpers.

export function fmtNum(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('ja-JP', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtPct(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toLocaleString('ja-JP', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

// "YYYY-MM-DD" -> "YYYY年M月"
export function fmtMonth(date) {
  if (!date) return '—';
  const [y, m] = String(date).split('-');
  return `${y}年${Number(m)}月`;
}

// "YYYY-MM-DD" -> "YYYY年M月D日"
export function fmtDate(date) {
  if (!date) return '—';
  const [y, m, d] = String(date).split('-');
  return `${y}年${Number(m)}月${Number(d)}日`;
}

// Direction word for a percentage change.
export function trendWord(pct) {
  if (pct == null) return '横ばい';
  if (pct > 1) return '値上がり';
  if (pct < -1) return '値下がり';
  return 'ほぼ横ばい';
}

export function trendClass(pct) {
  if (pct == null) return 'flat';
  if (pct > 1) return 'up';
  if (pct < -1) return 'down';
  return 'flat';
}
