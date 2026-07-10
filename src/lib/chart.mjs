// Self-contained SVG line-chart generator. No external libraries, no CDN.
// Produces a responsive <svg> (viewBox based) that inherits colors via CSS.

import { esc } from './html.mjs';

function niceStep(range, targetTicks) {
  const rough = range / targetTicks;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const candidates = [1, 2, 2.5, 5, 10].map((c) => c * pow);
  return candidates.find((c) => c >= rough) || candidates[candidates.length - 1];
}

// series: [{date:"YYYY-MM-DD", price:number}] ascending.
export function lineChartSvg(series, opts = {}) {
  const width = opts.width || 720;
  const height = opts.height || 300;
  const pad = { top: 16, right: 16, bottom: 28, left: 52 };
  const cls = opts.className || 'spark';

  if (!series || series.length < 2) {
    return `<svg viewBox="0 0 ${width} ${height}" class="chart ${esc(cls)}" role="img" aria-label="データ不足のため描画できません"><text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="chart-empty">データ不足</text></svg>`;
  }

  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const prices = series.map((p) => p.price);
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  // pad the value range slightly
  const vpad = (max - min) * 0.08;
  min -= vpad;
  max += vpad;

  const n = series.length;
  const x = (i) => pad.left + (innerW * i) / (n - 1);
  const y = (v) => pad.top + innerH - (innerH * (v - min)) / (max - min);

  // Build line path
  let d = '';
  for (let i = 0; i < n; i++) {
    d += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(series[i].price).toFixed(1)} `;
  }
  // Area path (for subtle fill)
  const area = `${d}L${x(n - 1).toFixed(1)},${(pad.top + innerH).toFixed(1)} L${x(0).toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`;

  // Y gridlines / labels
  const step = niceStep(max - min, 4);
  const yTicks = [];
  const startTick = Math.ceil(min / step) * step;
  for (let v = startTick; v <= max; v += step) yTicks.push(v);

  const gridLines = yTicks
    .map((v) => {
      const yy = y(v).toFixed(1);
      const label = v.toLocaleString('ja-JP', { maximumFractionDigits: 0 });
      return `<line x1="${pad.left}" y1="${yy}" x2="${pad.left + innerW}" y2="${yy}" class="chart-grid"/><text x="${pad.left - 6}" y="${yy}" dy="3" text-anchor="end" class="chart-axis">${esc(label)}</text>`;
    })
    .join('');

  // X labels: show ~5 evenly spaced year markers
  // Year markers by default; "md" (month/day) for short daily ranges.
  const fmtX = (dateStr) => {
    if (opts.xFormat === 'md') {
      const [, mm, dd] = String(dateStr).split('-');
      return `${Number(mm)}/${Number(dd)}`;
    }
    return String(dateStr).slice(0, 4);
  };
  const xLabelCount = Math.min(5, n);
  const xLabels = [];
  for (let k = 0; k < xLabelCount; k++) {
    const i = Math.round(((n - 1) * k) / (xLabelCount - 1 || 1));
    xLabels.push(
      `<text x="${x(i).toFixed(1)}" y="${height - 8}" text-anchor="middle" class="chart-axis">${esc(fmtX(series[i].date))}</text>`
    );
  }

  // Last-point marker
  const last = series[n - 1];
  const lastX = x(n - 1).toFixed(1);
  const lastY = y(last.price).toFixed(1);

  const title = opts.title ? `<title>${esc(opts.title)}</title>` : '';

  return `<svg viewBox="0 0 ${width} ${height}" class="chart ${esc(cls)}" role="img" preserveAspectRatio="xMidYMid meet" aria-label="${esc(opts.ariaLabel || '価格推移チャート')}">${title}
<path d="${area}" class="chart-area"/>
${gridLines}
<path d="${d.trim()}" class="chart-line" fill="none"/>
<circle cx="${lastX}" cy="${lastY}" r="3.5" class="chart-dot"/>
${xLabels.join('')}
</svg>`;
}
