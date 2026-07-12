// Machine-generated natural-language summaries built from the data.
// Template sentences +数値埋め込み. No hallucinated facts — every number
// comes straight from the computed stats.
//
// Two flavors are supported, keyed off `stats.daily`:
//   * daily (vegetan): the change metric is the recent daily move (rankPct,
//     直近1週間) and the buy signal is the source-provided 平年比.
//   * monthly (commodity archive): the change metric is 前月比 as before.

import { fmtMonth, fmtDate, fmtPct, fmtNum, trendWord } from './format.mjs';
import { latestChange, cityOf } from './retail.mjs';

function joinNames(list, max = 3) {
  const names = list.slice(0, max).map((x) => x.item.name);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join('、') + '、' + names[names.length - 1];
}

const isDaily = (e) => !!(e && e.stats && e.stats.daily);
const move = (e) => (e.stats.rankPct != null ? e.stats.rankPct : e.stats.momPct);
const moveLabel = (e) => (isDaily(e) ? '直近1週間で' : '前月比');

// One-line teaser for the top page.
export function headline(meta, rankings) {
  const riser = rankings.risers[0];
  const faller = rankings.fallers[0];
  const daily = isDaily(riser) || isDaily(faller);
  const label = daily ? fmtDate(meta.latestDate) : fmtMonth(meta.latestDate);
  const parts = [`${label}の最新集計です。`];
  if (riser && move(riser) != null) {
    parts.push(`もっとも値上がりしたのは${riser.item.name}（${moveLabel(riser)}${fmtPct(move(riser))}）。`);
  }
  if (faller && move(faller) != null) {
    parts.push(`もっとも値下がりしたのは${faller.item.name}（${moveLabel(faller)}${fmtPct(move(faller))}）です。`);
  }
  return parts.join('');
}

// Full weekly report: array of paragraphs (plain text).
// `freshness` (from src/lib/freshness.mjs) is optional; when it flags the
// data as an archive, the closing paragraph switches from a "daily update"
// claim to an honest archive disclosure instead.
export function weeklyReport(meta, itemsWithStats, rankings, freshness = null) {
  const monthLabel = fmtMonth(meta.latestDate);
  const archive = !!(freshness && freshness.archive);
  const daily = itemsWithStats.some(isDaily);
  const asOfLabel = daily ? fmtDate(meta.latestDate) : monthLabel;
  const p = [];

  p.push(
    `${asOfLabel}時点の${meta.source.title}をもとに、主要${itemsWithStats.length}品目の価格動向を自動集計しました。` +
      `本レポートはデータから機械的に生成しています。`
  );

  const risers = rankings.risers.filter((x) => move(x) > 0);
  const fallers = rankings.fallers.filter((x) => move(x) < 0);

  if (risers.length) {
    const top = risers[0];
    p.push(
      `${daily ? '直近1週間で' : '前月と比べて'}値上がりが目立ったのは${joinNames(risers)}などです。` +
        `とくに${top.item.name}は${moveLabel(top)}${fmtPct(move(top))}と大きく上昇し、` +
        `最新価格は${fmtNum(top.stats.latest.price, daily ? 0 : 1)}（${top.item.unit}）となりました。`
    );
  }
  if (fallers.length) {
    const top = fallers[0];
    p.push(
      `一方、値下がりしたのは${joinNames(fallers)}など。` +
        `${top.item.name}は${moveLabel(top)}${fmtPct(move(top))}で、家計にはうれしい動きとなっています。`
    );
  }

  const buys = rankings.buys;
  if (buys.length) {
    const b = buys[0];
    p.push(
      `「いまが買い時」と判定されたのは${joinNames(buys, 4)}などです。` +
        (daily
          ? `これらは当日の卸売価格が平年値（過去5か年の同時期平均）を10%以上下回っており、割安と考えられます。`
          : `これらは平年（同じ月の過去平均）や直近12か月の水準を下回っており、割安と考えられます。`) +
        `なかでも${b.item.name}は平年比${fmtPct(b.stats.vsNormalPct)}と割安感が強い状況です。`
    );
  } else {
    p.push(
      daily
        ? '今回の集計では、平年比が買い時ライン（平年より10%以上割安）に達した野菜はありませんでした。'
        : '今回の集計では、平年・直近水準をともに下回る明確な「買い時」品目はありませんでした。'
    );
  }

  p.push(
    archive
      ? `価格はあくまで国際市況の参考値です。品目ごとの詳しい推移は各品目ページのチャートをご覧ください。` +
          `本サイトのデータは${monthLabel}時点までの月次アーカイブです。`
      : `掲載価格は東京都中央卸売市場などの卸売価格（円/kg）の参考値です。品目ごとの日次・長期の推移は各品目ページのチャートをご覧ください。` +
          `本サイトは毎日自動でデータを取得・更新しています。`
  );

  return {
    title: archive
      ? `${monthLabel} 価格アーカイブ`
      : daily
        ? `${monthLabel} 野菜価格まとめレポート`
        : `${monthLabel} 価格まとめレポート`,
    paragraphs: p,
    monthLabel,
  };
}

// Machine-generated one-paragraph overview of the monthly city retail survey,
// built from the全国 (national) series of each retail record. Returns '' when
// there is no usable data. Honest framing: this is a MONTHLY survey, so the
// copy never claims daily updates.
export function retailWeeklyParagraph(retailRecords, cityList = []) {
  const nat = (retailRecords || [])
    .map((rec) => ({ rec, lc: latestChange((cityOf(rec, 'national') || {}).series) }))
    .filter((x) => x.lc);
  if (nat.length === 0) return '';

  const latestDate = nat.map((x) => x.lc.date).sort().slice(-1)[0];
  const monthLabel = fmtMonth(latestDate);
  const withMom = nat.filter((x) => x.lc.momPct != null);
  const parts = [
    `都市別の小売価格（月次調査）では、${monthLabel}の全国平均をもとに主要${nat.length}品目・${cityList.length}都市の店頭価格をまとめています。`,
  ];
  if (withMom.length) {
    const riser = [...withMom].sort((a, b) => b.lc.momPct - a.lc.momPct)[0];
    const faller = [...withMom].sort((a, b) => a.lc.momPct - b.lc.momPct)[0];
    if (riser && riser.lc.momPct > 0) {
      parts.push(
        `前月と比べて全国平均が上がったのは${riser.rec.name}（前月比${fmtPct(riser.lc.momPct)}、${fmtNum(riser.lc.price, 0)}円/kg）などです。`
      );
    }
    if (faller && faller.lc.momPct < 0 && faller.rec.slug !== riser.rec.slug) {
      parts.push(
        `一方、${faller.rec.name}は前月比${fmtPct(faller.lc.momPct)}と値下がりし、家計にはうれしい動きとなりました。`
      );
    }
  }
  parts.push('小売価格は卸売価格（日次）とは別の月次調査で、都市ごとの傾向は小売価格ページから確認できます。');
  return parts.join('');
}

// Per-item short description sentence.
export function itemBlurb(item, stats) {
  if (stats.daily) {
    const dayLabel = fmtDate(stats.latest.date);
    const dir = trendWord(stats.wowPct);
    let s = `${item.name}（${item.origin}）の${dayLabel}の卸売価格は${fmtNum(stats.latest.price, 0)}${item.unit}で、直近1週間で${fmtPct(stats.wowPct)}の${dir}です。`;
    if (stats.vsNormalPct != null) {
      const rel = stats.vsNormalPct < 0 ? '平年より割安' : '平年より割高';
      s += `平年比は${fmtPct(stats.vsNormalPct)}（${rel}）となっています。`;
    }
    return s;
  }
  const monthLabel = fmtMonth(stats.latest.date);
  const dir = trendWord(stats.momPct);
  let s = `${item.name}（${item.origin}）の${monthLabel}の価格は${fmtNum(stats.latest.price)}${item.unit}で、前月比${fmtPct(stats.momPct)}の${dir}です。`;
  if (stats.vsNormalPct != null) {
    const rel = stats.vsNormalPct < 0 ? '平年より割安' : '平年より割高';
    s += `平年比は${fmtPct(stats.vsNormalPct)}（${rel}）となっています。`;
  }
  return s;
}
