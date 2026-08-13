import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { affiliateBlock, selectProducts, amazonStatement } from '../src/lib/affiliate.mjs';
import { CONFIG_DIR, PUBLIC_DIR } from '../src/lib/paths.mjs';

const SAMPLE = {
  enabled: true,
  disclosure: '本ページには広告（アフィリエイトリンク）が含まれます。',
  heading: '関連商品',
  products: [
    {
      id: 'p1',
      title: '野菜保存容器',
      note: '葉物の鮮度保持に使える容器です。',
      url: 'https://example.com/p1',
      provider: 'rakuten',
      itemSlugs: ['cabbage'],
      guideSlugs: [],
    },
    {
      id: 'p2',
      title: '旬の野菜レシピ本',
      url: 'https://example.com/p2',
      provider: 'amazon',
      itemSlugs: [],
      guideSlugs: ['seasonal-buying-tips'],
    },
  ],
};

// ---- 表示条件（既定は「何も出さない」） ------------------------------------

test('enabled=false なら商品があっても何も出力しない', () => {
  const off = { ...SAMPLE, enabled: false };
  assert.equal(affiliateBlock(off, { itemSlug: 'cabbage' }), '');
  assert.deepEqual(selectProducts(off, { itemSlug: 'cabbage' }), []);
});

test('products が空なら何も出力しない', () => {
  const empty = { ...SAMPLE, products: [] };
  assert.equal(affiliateBlock(empty, { itemSlug: 'cabbage' }), '');
});

test('設定が欠落・壊れていても例外を投げず空文字を返す（fail-safe）', () => {
  assert.equal(affiliateBlock(null, { itemSlug: 'cabbage' }), '');
  assert.equal(affiliateBlock(undefined, {}), '');
  assert.equal(affiliateBlock({}, { itemSlug: 'cabbage' }), '');
  assert.equal(affiliateBlock({ enabled: true }, { itemSlug: 'cabbage' }), '');
});

test('紐付けの無いページには出さない（無関係な品目に汎用表示しない）', () => {
  assert.equal(affiliateBlock(SAMPLE, { itemSlug: 'tomato' }), '');
  assert.equal(affiliateBlock(SAMPLE, { guideSlug: 'origin-and-market-price' }), '');
  assert.equal(affiliateBlock(SAMPLE, {}), '');
});

// ---- 出力する場合は必ず「広告である」ことを明示する（ステマ規制対応） -------

test('出力時はPR表記と rel="sponsored" が必ず含まれる（品目ページ）', () => {
  const html = affiliateBlock(SAMPLE, { itemSlug: 'cabbage' });
  assert.notEqual(html, '');
  assert.match(html, /広告/, 'PR表記（広告）が含まれること');
  assert.match(html, /アフィリエイトリンク/, '開示文が含まれること');
  assert.match(html, /rel="sponsored noopener"/, 'sponsored 属性が付くこと');
  assert.match(html, /target="_blank"/);
  assert.match(html, /野菜保存容器/);
  // 紐付いていない商品は出さない
  assert.doesNotMatch(html, /旬の野菜レシピ本/);
});

test('ガイド記事の紐付けでも同様にPR表記付きで出力される', () => {
  const html = affiliateBlock(SAMPLE, { guideSlug: 'seasonal-buying-tips' });
  assert.match(html, /旬の野菜レシピ本/);
  assert.match(html, /広告/);
  assert.match(html, /rel="sponsored noopener"/);
});

test('リンクを含む出力には必ず開示文が先に現れる', () => {
  const html = affiliateBlock(SAMPLE, { itemSlug: 'cabbage' });
  const discIdx = html.indexOf('アフィリエイトリンク');
  const linkIdx = html.indexOf('<a class="card aff-card"');
  assert.ok(discIdx >= 0 && linkIdx >= 0);
  assert.ok(discIdx < linkIdx, '開示文が商品リンクより前に出ること');
});

test('タイトルやURLが欠けた不正な商品は出力対象から除外される', () => {
  const broken = {
    ...SAMPLE,
    products: [{ id: 'x', itemSlugs: ['cabbage'] }, { id: 'y', title: 'タイトルのみ', itemSlugs: ['cabbage'] }],
  };
  assert.equal(affiliateBlock(broken, { itemSlug: 'cabbage' }), '');
});

// ---- Amazonアソシエイトの定型文 --------------------------------------------

test('amazonStatement は enabled のときだけ文言を返す', () => {
  assert.equal(amazonStatement({ amazonAssociate: { enabled: false, statement: 'X' } }), '');
  assert.equal(amazonStatement({}), '');
  assert.equal(amazonStatement({ amazonAssociate: { enabled: true, statement: 'X' } }), 'X');
});

// ---- リポジトリの既定状態と、生成物への影響 --------------------------------

test('コミットされた config/affiliates.json は既定で無効・商品ゼロ', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'affiliates.json'), 'utf8'));
  assert.equal(cfg.enabled, false, '本番で勝手に広告が出ないこと');
  assert.deepEqual(cfg.products, []);
  assert.ok(cfg.disclosure && cfg.disclosure.length > 0, '開示文が用意されていること');
});

test('既定状態のビルド出力に広告ブロックが含まれない', (t) => {
  const item = path.join(PUBLIC_DIR, 'items/tomato/index.html');
  if (!fs.existsSync(item)) {
    t.skip('no build output — run `npm run build` first');
    return;
  }
  assert.doesNotMatch(fs.readFileSync(item, 'utf8'), /aff-card/);
});

test('プライバシーポリシーにアフィリエイトの開示がある', (t) => {
  const p = path.join(PUBLIC_DIR, 'privacy/index.html');
  if (!fs.existsSync(p)) {
    t.skip('no build output — run `npm run build` first');
    return;
  }
  const html = fs.readFileSync(p, 'utf8');
  assert.match(html, /アフィリエイトプログラムについて/);
  assert.match(html, /販売主体ではありません/);
});
