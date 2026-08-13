// アフィリエイト表示ブロック（純関数・依存ゼロ）。
//
// 法令順守の要点（景品表示法／ステルスマーケティング規制）:
//   * アフィリエイトリンクを出す場合、「広告である」ことを消費者が一目で分かる形で
//     明示しなければならない。本モジュールは PR 表記（disclosure）を必ず商品リンクの
//     直前・同一ブロック内に出力し、表記なしでリンクだけを出す経路を持たない。
//   * リンクには rel="sponsored noopener" を付与する（検索エンジンへの広告申告）。
//
// 表示条件（いずれかを満たさなければ何も出力しない = 空文字）:
//   * config/affiliates.json の enabled が true
//   * そのページ（品目 slug / ガイド slug）に紐づく商品が 1 件以上ある
// これにより、商品未登録の状態（既定）ではサイトに一切影響しない。

import { esc } from './html.mjs';

// context: { itemSlug } または { guideSlug }
export function selectProducts(config, context = {}) {
  if (!config || config.enabled !== true) return [];
  const products = Array.isArray(config.products) ? config.products : [];
  const { itemSlug, guideSlug } = context;
  return products.filter((p) => {
    if (!p || !p.url || !p.title) return false;
    if (itemSlug && Array.isArray(p.itemSlugs) && p.itemSlugs.includes(itemSlug)) return true;
    if (guideSlug && Array.isArray(p.guideSlugs) && p.guideSlugs.includes(guideSlug)) return true;
    return false;
  });
}

// 広告リンク1件。rel に sponsored を必ず含める。
function productCard(p) {
  const note = p.note ? `<p class="aff-note">${esc(p.note)}</p>` : '';
  return `<a class="card aff-card" href="${esc(p.url)}" target="_blank" rel="sponsored noopener">
  <span class="aff-title">${esc(p.title)}</span>
  ${note}
  <span class="aff-cta">商品を見る →</span>
</a>`;
}

// ページに差し込む関連商品ブロック。該当商品が無ければ空文字（＝何も表示しない）。
export function affiliateBlock(config, context = {}) {
  const products = selectProducts(config, context);
  if (products.length === 0) return '';
  const heading = (config && config.heading) || '関連商品';
  const disclosure =
    (config && config.disclosure) || '本ページには広告（アフィリエイトリンク）が含まれます。';
  return `
<h2>${esc(heading)}<span class="aff-badge">広告</span></h2>
<div class="notice aff-disclosure">${esc(disclosure)}</div>
<div class="grid aff-grid">${products.map(productCard).join('')}</div>`;
}

// Amazonアソシエイト参加時に義務づけられる定型文。off のときは空文字。
export function amazonStatement(config) {
  const a = config && config.amazonAssociate;
  if (!a || a.enabled !== true) return '';
  return String(a.statement || '');
}
