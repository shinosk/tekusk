# 青果・食品価格ナビ（tekusk）

野菜・果物をはじめとする食品コモディティの市況価格を、公開オープンデータから
**毎日自動で取得・可視化・公開** する静的サイトジェネレータです。
フレームワーク不使用・**外部npm依存ゼロ**（Node.js 標準APIのみ）。

- 品目別の価格推移（SVGチャート・自前生成、CDN不使用）
- 前月比・前年比・**平年比**、そして「いまが買い時」の割安品目判定
- 値上がり／値下がりランキング、機械生成の週報
- SEO一式（title/description、JSON-LD Dataset・BreadcrumbList、OGP、sitemap.xml、robots.txt）
- AdSense広告スロット（設定時のみ出力）
- 全ページ100KB以下・レスポンシブ・日本語

## クイックスタート

```bash
npm run fetch      # オープンデータを取得し data/ に正規化して蓄積
npm run build      # data/ から public/ に静的HTMLを生成
npm test           # 単体テスト（正規化・統計・ビルド）
npm run serve      # http://localhost:8080 でプレビュー
# もしくは
npm run update     # fetch → build を一括実行
```

生成物は `public/`（`.gitignore` 済み）。`data/` は git にコミットして**時系列DB**として履歴を蓄積します。

## データソースについて（重要）

本システムの**本番想定ソースは日本国内の青果価格**（農林水産省 食品価格動向調査 / e-Stat 等、
政府標準利用規約に基づき出典表示で二次利用可）です。

一方、このリポジトリを構築したビルド環境は egress 制限により日本政府系ホストへ到達できなかったため、
**実際に機械取得を確認できた唯一の実データ**である
[Frictionless Data「Commodity Prices」](https://github.com/datasets/commodity-prices)（ODC-PDDL / IMF原データ）
を採用してパイプラインをエンドツーエンドで検証・稼働させています。
検証の詳細・各ソースの実測結果・差異の開示は [`docs/data-sources.md`](docs/data-sources.md) を参照してください。

### データ鮮度に応じたコピーの自動切替
現在の `commodity` ソースは2017年6月で更新が止まったアーカイブです。
ビルド時（`scripts/build.mjs`）に全品目の最新データ日付を判定し、
**最新日付が90日より古い場合**は「毎日自動更新」「今日の」等の現在性を示す表現を自動的に排し、
「国際市況の長期価格アーカイブ」といった実態に即したコピーへ切り替え、
全ページ上部に「本サイトのデータは YYYY年M月 時点までの月次アーカイブです」という
バナーを表示します（判定ロジックは `src/lib/freshness.mjs`）。
本番ソースに切り替わり最新日付が90日以内に収まれば、これらは自動的に「毎日自動更新」系のコピーへ戻ります
（手動でのコピー書き換えは不要）。

### 本番ソースへの切り替え
データ取得は**アダプタ方式**（`src/lib/sources.mjs`）。`estat` アダプタの `fetchCsv` を実装し、
必要に応じて `config/items.json` の列マッピングを差し替えるだけで、サイト生成側は無改修で切り替わります。

```bash
node scripts/fetch.mjs --source=estat   # 本番ソース（要ネットワーク到達）
```

> 補足: Node.js のグローバル `fetch` はプロキシ環境では `NODE_USE_ENV_PROXY=1` が必要な場合があります
> （GitHub Actions の通常ランナーでは不要）。

### プローブ基盤（実データ確認 → estatアダプタ実装への橋渡し）
開発サンドボックスからは日本政府系ホストが egress 403 で到達不能なため、
`scripts/probe.mjs` と `.github/workflows/probe.yml`（`workflow_dispatch` 専用）を用意しています。
本番の GitHub Actions ランナーから候補エンドポイント（東京都中央卸売市場・ベジ探・農水省・e-Stat）に
実際に到達できるかを確認し、応答（HTML/CSV/Excel/ZIP）の生サンプルを `data/raw-samples/` に
保存してリポジトリへコミットバックする仕組みです。

開発フロー:
1. GitHub Actions の Actions タブから `Probe production data sources` を手動実行（`workflow_dispatch`）
2. ランナーが `node scripts/probe.mjs` を実行し、各URLのHTTPステータス・content-type・本文サンプルを
   `data/raw-samples/index.json` と `data/raw-samples/files/` に保存、差分があれば自動コミット・プッシュ
3. プルした `data/raw-samples/` の中身（実際の列構成・ファイル形式・リンク構造）を確認する
4. その実データをもとに `src/lib/sources.mjs` の `estatAdapter.fetchCsv` と、必要なら
   `config/items.json` の列マッピングを実装する（現状は「憶測でパーサを書かない」ため意図的にスタブ）
5. `node scripts/fetch.mjs --source=estat` で本番ソースに切り替える。サイト生成側（`build.mjs`他）は無改修

ローカルでも `node scripts/probe.mjs` を直接実行可能です。どのURLが失敗しても他のURLの取得を継続し、
結果はすべて `data/raw-samples/index.json` に記録したうえで必ず終了コード0で終わります
（全滅環境でもワークフローを壊しません）。再実行時は `data/raw-samples/` を上書きするため、
実行のたびにディレクトリが肥大化することはありません。

## 運用フロー（完全自動）

`.github/workflows/update.yml` が日次（JST 07:00 / 22:00 UTC）に実行:

1. `npm test` で回帰チェック
2. `node scripts/fetch.mjs` でデータ取得（**fail-safe**: 失敗時は既存データを壊さず継続）
3. `data/` に差分があれば自動コミット＆プッシュ（＝時系列の蓄積）
4. `node scripts/build.mjs` で `public/` を生成
5. `actions/deploy-pages` で GitHub Pages へデプロイ

手動実行は Actions の `workflow_dispatch` から可能です。

## ディレクトリ構成

```
config/        site.json（サイト/収益化設定）, items.json（品目カタログ）
data/          正規化済みJSON（items/<slug>.json, meta.json）＝gitで履歴管理
                raw-samples/（probe.mjs が保存する本番ソースの生サンプル。実行のたびに上書き）
public/        ビルド成果物（gitignore）
scripts/       fetch.mjs, build.mjs, serve.mjs, probe.mjs
src/lib/       csv, normalize, stats, chart, report, format, html, sources, paths, freshness
src/templates/ layout.mjs（ページシェル・CSS・広告スロット・データ鮮度バナー）
docs/          data-sources.md, architecture.md
.github/workflows/update.yml, probe.yml
test/          normalize / stats / build / freshness のユニットテスト
```

## 収益化の設定

`config/site.json`:
- `adsenseClientId` を設定すると全ページに AdSense タグを出力（未設定なら一切出力しない）。
- `adsenseSlotTop` / `adsenseSlotItem` でスロットIDを指定。
- `affiliate.enabled` と品目の `buyKeyword` でアフィリエイト導線を拡張可能。

## ライセンス / 免責
- 生成データの出典・ライセンスは各ページの「データ出典」および `data/meta.json` に明記。
- 価格は参考値であり、実取引を保証するものではありません。
