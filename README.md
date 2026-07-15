# 買い時ナビ（tekusk）

日本の野菜・果物の価格（独立行政法人農畜産業振興機構「**ベジ探**」・農林水産省「青果物卸売市場調査」等）を、
公開オープンデータから **毎日自動で取得・可視化・公開** する静的サイトジェネレータです。
フレームワーク不使用・**外部npm依存ゼロ**（Node.js 標準APIのみ。xlsxパーサも自作）。

公開サイト: https://kaidoki-navi.net/

- 野菜19品目の**日次卸売価格**（東京都中央卸売市場）＋ **2005年からの長期月次価格**の2段チャート
- ベジ探提供の**平年比**（当日価格÷過去5か年同時期平均）による「いまが買い時」判定（平年比 < 0.9）
- 日次ベースの値上がり／値下がりランキング、機械生成の週報
- 都市別の小売価格（月次調査・9都市＋全国）
- 果実12品目の産地別シェア・消費地域別卸売価格（農林水産省「青果物卸売市場調査」・e-Stat、年次確報）
- 国際コモディティ26品目（1980〜2017年・月次）は「国際市況アーカイブ」として維持
- SEO一式（title/description、JSON-LD Dataset・BreadcrumbList、OGP、sitemap.xml、robots.txt）
- 全ページ100KB以下・レスポンシブ・日本語

## アーキテクチャ

公開オープンデータを日次で取得・正規化してリポジトリ内JSON（`data/`）に時系列として蓄積し、
そこから静的HTMLを `public/` に生成して GitHub Pages に配信する構成です。

- **依存ゼロの静的サイトジェネレータ**: フレームワーク不使用。xlsxのZIP/XML解析・CSVパーサ・
  SVGチャート・ローカルサーバまで、すべて Node.js 標準APIのみで自作しています
  （サプライチェーンリスクの最小化が狙いです）。
- **GitHub Actions パイプライン**: `.github/workflows/update.yml` が日次でデータ取得→ビルド→
  GitHub Pages デプロイまでを自動実行します（`.github/workflows/probe.yml` は開発用の実データ収集
  ワークフローです）。
- **fail-safe 設計**: データ取得（`scripts/fetch.mjs`）が失敗しても既存の `data/` を一切壊さず
  終了コード0で継続します。ソースごとの鮮度判定（`src/lib/freshness.mjs`）により、更新が止まった
  ソース（国際市況アーカイブ等）のページは自動でアーカイブ表示に切り替わります。
- **純関数コア**: xlsx/和暦変換/正規化/統計/鮮度判定などのロジックはI/Oを持たない純関数として実装し、
  `node --test` で単体テストしています。

詳細は [docs/architecture.md](docs/architecture.md)（モジュール構成・データフロー）、
[docs/data-sources.md](docs/data-sources.md)（データソースの実装状況）を参照してください。

## 開発方法

```bash
npm test           # 単体テスト（xlsx・和暦・vegetan正規化・統計・鮮度・ビルドE2E）
node scripts/fetch.mjs --source=vegetan --fixtures   # フィクスチャからデータ生成（開発用・ネットワーク不要）
npm run build      # data/ から public/ に静的HTMLを生成
npm run serve      # http://localhost:8080 でプレビュー
# もしくは
npm run update     # fetch → build を一括実行
```

生成物は `public/`（`.gitignore` 済み）。`data/` は git にコミットして**時系列DB**として履歴を蓄積します。

### フィクスチャ開発フロー

開発サンドボックスからは `vegetan.alic.go.jp` 等の外部ホストへ到達できない場合があります。
そのため、本番の GitHub Actions ランナーで取得した実レスポンス（`data/raw-samples/files/` /
`test/fixtures/`）をフィクスチャとして使い、パーサの開発・テストを行います。

```bash
node scripts/fetch.mjs --source=vegetan --fixtures   # 開発: フィクスチャから
node scripts/fetch.mjs --source=vegetan              # 本番: HTTP から（要ネットワーク到達）
node scripts/fetch.mjs --source=retail --fixtures    # 都市別小売価格（フィクスチャ）
node scripts/fetch.mjs --source=estat --fixtures     # e-Stat（フィクスチャ）
node scripts/fetch.mjs --source=commodity            # 凍結アーカイブの再取得（差分ゼロで無害）
```

## 運用フロー（自動）

`.github/workflows/update.yml` が日次（JST 07:00 / 22:00 UTC）に実行:

1. `npm test` で回帰チェック
2. `node scripts/fetch.mjs --source=vegetan` → `--source=retail` → `--source=estat` →
   `--source=commodity` の順にデータ取得（fail-safe: 失敗時は既存データを壊さず継続）
3. `data/` に差分があれば自動コミット＆プッシュ（＝日次時系列の蓄積）
4. `node scripts/build.mjs` で `public/` を生成
5. `actions/deploy-pages` で GitHub Pages へデプロイ

手動実行は Actions の `workflow_dispatch` から可能です。

### SNS自動投稿（X）

日次パイプラインでビルド後に、その日の「買い時／注目の値動き」＋サイトへのリンクを
**1日1回** 用意します（`scripts/post-x.mjs`）。投稿方法は2つのスイッチで切り替えます。

- **2段のスイッチ**（`config/site.json` の `social.x`）:
  - `enabled`: 機能全体の ON/OFF（`false` で完全停止）。
  - `autoPost`: **課金スイッチ**。`false`（既定＝手動投稿モード）なら X API を呼ばず、
    `data/social/x-draft.md` にコピペ用の投稿文＋ワンタップ投稿リンク（Web Intent）を生成するだけ
    ＝ **X API の費用ゼロ**。運営者はそれをコピペ／タップで手動投稿します。
    `true` にし Secrets を設定すると API で自動投稿に切り替わります。
- **依存ゼロの OAuth 1.0a**: 自動投稿時は X API v2 の `POST /2/tweets` を OAuth 1.0a User Context で呼びます。
  HMAC-SHA1 署名・RFC 3986 パーセントエンコードは `node:crypto` のみで自作しています
  （`src/lib/social.mjs`。純関数なので `test/social.test.mjs` で署名の決定性を固定ベクトルで検証）。
- **必要な GitHub Secrets（自動投稿時のみ）**: `X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_SECRET`。
  値はコミットもログ出力もしません。未設定なら「skipping（no credentials）」として何もせず `exit 0`。
- **冪等**: `data/social/x-state.json` に最後に処理した集計日（ドラフトは `lastDraftKey`、投稿は `lastPostKey`）を保存し、
  新しい `meta.latestDate` のときだけ更新／投稿します（同じ集計日に二重投稿しません）。
- **fail-safe**: API・ネットワーク失敗でも `exit 0`（日次ワークフローを壊さない）。`--strict` でのみ失敗を返します。
- 動作確認: `node scripts/post-x.mjs --dry-run`（本文を出力するだけ・認証不要）。`--force` で冪等スキップを無視。

## ディレクトリ構成

```
config/        site.json（サイト設定）, items.json（品目カタログ＋slug↔xlsx対応表）
data/          正規化済みJSON（items/<slug>.json, retail/, estat/, meta.json）＝gitで履歴管理
                raw-samples/（probe.mjs が保存する本番ソースの生サンプル＝パーサ開発用フィクスチャ）
public/        ビルド成果物（gitignore）
scripts/       fetch.mjs, build.mjs, serve.mjs, probe.mjs
src/lib/       xlsx（依存ゼロxlsxパーサ）, wareki（和暦変換）, vegetan（ベジ探正規化）,
                retail, estat, csv, normalize, stats, chart, report, format, html, sources,
                paths, freshness
src/templates/ layout.mjs（ページシェル・CSS・広告スロット・ソース別鮮度バナー）
docs/          data-sources.md, architecture.md
.github/workflows/update.yml, probe.yml
test/          xlsx / wareki / vegetan / retail / estat / normalize / stats / freshness / build のユニットテスト
```

## データソースとライセンス

### ベジ探（vegetan / retail アダプタ）
独立行政法人農畜産業振興機構「ベジ探」（https://vegetan.alic.go.jp/）の公開 .xlsx を取得しています。

- 全ページに「出典：独立行政法人農畜産業振興機構『ベジ探』のデータを加工して作成」を表示。
- ベジ探の著作権ページ（https://vegetan.alic.go.jp/chosaku.html）は「著作権は機構に帰属し、
  私的使用・引用等を除き無断転載・複製不可」という一般的な著作権表示であり、政府標準利用規約のような
  オープンライセンスではありません。本サイトはページを複製せず、価格等の数値（事実データ）を独自に
  集計・可視化しています。

### e-Stat「青果物卸売市場調査」（estat アダプタ）
農林水産省「青果物卸売市場調査」（e-Stat API v3・`statsCode=00500226`）の年次確報を取得しています。

- 出典：農林水産省「青果物卸売市場調査」（e-Stat）を加工して作成（政府標準利用規約準拠。
  出典表示のうえで二次利用可）。

### 国際コモディティ（commodity アダプタ）
[Frictionless Data「Commodity Prices」](https://github.com/datasets/commodity-prices)
（ODC-PDDL-1.0 / IMF原データ、更新停止済みの月次アーカイブ）を `/archive/` 配下で維持しています。

生成データの出典・ライセンスは各ページの「データ出典」および `data/meta.json` に明記しています。

## 独自ドメインへの移行

独自ドメインで公開する場合は、`config/site.json` の `baseUrl` を新しいドメインの URL に、
`customDomain` にそのドメイン名（例: `example.com`）を設定するだけで移行できます。
既存の `sitePathPrefix` 機構（`src/templates/layout.mjs`）が `baseUrl` のパス部分をもとに
サイト内リンクのプレフィックスを自動調整するため、コード変更は不要です。ビルド時に `customDomain` が
設定されていれば `public/CNAME`（GitHub Pages 用）が自動生成され、`adsenseClientId` も設定されていれば
`public/ads.txt` も併せて生成されます（`customDomain` が空の場合はどちらも生成されません）。

## ライセンス

© 2026 サイト運営者. コードおよびコンテンツの無断転載を禁じます（No license granted）。
