// Machine-generated natural-language summaries built from the data.
// Template sentences +数値埋め込み. No hallucinated facts — every number
// comes straight from the computed stats.

import { fmtMonth, fmtPct, fmtNum, trendWord } from './format.mjs';

function joinNames(list, max = 3) {
  const names = list.slice(0, max).map((x) => x.item.name);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join('、') + '、' + names[names.length - 1];
}

// One-line teaser for the top page.
export function headline(meta, rankings) {
  const monthLabel = fmtMonth(meta.latestDate);
  const riser = rankings.risers[0];
  const faller = rankings.fallers[0];
  const parts = [`${monthLabel}の最新集計です。`];
  if (riser && riser.stats.momPct != null) {
    parts.push(`もっとも値上がりしたのは${riser.item.name}（前月比${fmtPct(riser.stats.momPct)}）。`);
  }
  if (faller && faller.stats.momPct != null) {
    parts.push(`もっとも値下がりしたのは${faller.item.name}（前月比${fmtPct(faller.stats.momPct)}）です。`);
  }
  return parts.join('');
}

// Full weekly report: array of paragraphs (plain text).
export function weeklyReport(meta, itemsWithStats, rankings) {
  const monthLabel = fmtMonth(meta.latestDate);
  const p = [];

  p.push(
    `${monthLabel}時点の${meta.source.title}をもとに、主要${itemsWithStats.length}品目の価格動向を自動集計しました。` +
      `本レポートはデータから機械的に生成しています。`
  );

  const risers = rankings.risers.filter((x) => x.stats.momPct > 0);
  const fallers = rankings.fallers.filter((x) => x.stats.momPct < 0);

  if (risers.length) {
    const top = risers[0];
    p.push(
      `前月と比べて値上がりが目立ったのは${joinNames(risers)}などです。` +
        `とくに${top.item.name}は前月比${fmtPct(top.stats.momPct)}と大きく上昇し、` +
        `最新価格は${fmtNum(top.stats.latest.price)}（${top.item.unit}）となりました。`
    );
  }
  if (fallers.length) {
    const top = fallers[0];
    p.push(
      `一方、値下がりしたのは${joinNames(fallers)}など。` +
        `${top.item.name}は前月比${fmtPct(top.stats.momPct)}で、家計にはうれしい動きとなっています。`
    );
  }

  const buys = rankings.buys;
  if (buys.length) {
    const b = buys[0];
    p.push(
      `「いまが買い時」と判定されたのは${joinNames(buys, 4)}などです。` +
        `これらは平年（同じ月の過去平均）や直近12か月の水準を下回っており、割安と考えられます。` +
        `なかでも${b.item.name}は平年比${fmtPct(b.stats.vsNormalPct)}と割安感が強い状況です。`
    );
  } else {
    p.push('今回の集計では、平年・直近水準をともに下回る明確な「買い時」品目はありませんでした。');
  }

  p.push(
    `価格はあくまで国際市況の参考値です。品目ごとの詳しい推移は各品目ページのチャートをご覧ください。` +
      `本サイトは毎日自動でデータを取得・更新しています。`
  );

  return { title: `${monthLabel} 価格まとめレポート`, paragraphs: p, monthLabel };
}

// Per-item short description sentence.
export function itemBlurb(item, stats) {
  const monthLabel = fmtMonth(stats.latest.date);
  const dir = trendWord(stats.momPct);
  let s = `${item.name}（${item.origin}）の${monthLabel}の価格は${fmtNum(stats.latest.price)}${item.unit}で、前月比${fmtPct(stats.momPct)}の${dir}です。`;
  if (stats.vsNormalPct != null) {
    const rel = stats.vsNormalPct < 0 ? '平年より割安' : '平年より割高';
    s += `平年比は${fmtPct(stats.vsNormalPct)}（${rel}）となっています。`;
  }
  return s;
}
