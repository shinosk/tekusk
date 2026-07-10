# 野菜価格ナビ（tekusk）

日本の野菜卸売価格（独立行政法人農畜産業振興機構「**ベジ探**」）を、公開オープンデータから
**毎日自動で取得・可視化・公開** する静的サイトジェネレータです。
フレームワーク不使用・**外部npm依存ゼロ**（Node.js 標準APIのみ。xlsxパーサも自作）。

- 野菜19品目の**日次卸売価格**（東京都中央卸売市場）＋ **2005年からの長期月次価格**の2段チャート
- ベジ探提供の**平年比**（当日価格÷過去5か年同時期平均）による「いまが買い時」判定（平年比 < 0.9）
- 日次ベースの値上がり／値下がりランキング、機械生成の週報
- 国際コモディティ26品目（1980〜2017年・月次）は「国際市況アーカイブ」として維持
- SEO一式（title/description、JSON-LD Dataset・BreadcrumbList、OGP、sitemap.xml、robots.txt）
- AdSense広告スロット（設定時のみ出力）
- 全ページ100KB以下・レスポンシブ・日本語

## クイックスタート

```bash
npm run fetch      # ベジ探＋コモディティのデータを取得し data/ に正規化して蓄積
npm run build      # data/ から public/ に静的HTMLを生成
npm test           # 単体テスト（xlsx・和暦・vegetan正規化・統計・鮮度・ビルドE2E）
npm run serve      # http://localhost:8080 でプレビュー
# もしくは
npm run update     # fetch → build を一括実行
```

生成物は `public/`（`.gitignore` 済み）。`data/` は git にコミットして**時系列DB**として履歴を蓄積します。

## データソース

### 本番ソース: ベジ探（vegetan アダプタ）
独立行政法人農畜産業振興機構「ベジ探」（https://vegetan.alic.go.jp/）の公開 .xlsx を日次取得します。

| 系列 | URL | 構造 |
|---|---|---|
| 日次卸売 | `kakakugurafu/{youkeisai,kasai,konsai,imo}.xlsx`（葉茎菜・果菜・根菜・いも類） | 品目別シート。1シートに市場ブロック×4（東京・名古屋・大阪・福岡）。各ブロックは日付行＋「入荷量」「卸売価格」「平均価格（平年値）」「平年比」の行。**先頭の東京都中央卸売市場ブロックを採用**。当月分のみの提供のため、日次の蓄積は `data/` への追記マージで実現 |
| 月次長期 | `wp-content/uploads/{item}.xlsx`（19品目。`rettuce`・`wthite-potato`・`burdosk` 等**先方のtypoごと正確に**） | 行=月（1〜12月）、列=年（「平成18年」「2008年」の和暦・西暦混在＋先頭に**無ラベルの2005年列**＋末尾に平年値列）。単位は円/kg |
| 都市別小売 | `kouri_cyousa/*.xlsx` | **今回は実装スコープ外**（フィクスチャは取得済み。将来の拡張用） |

品目slug ↔ xlsxファイル名・シート名の対応は `config/items.json` の各品目の
`monthlyKey` / `dailyBook` / `dailySheet` フィールドが正です。

**出典表記**: 全野菜ページに「出典：独立行政法人農畜産業振興機構『ベジ探』のデータを加工して作成」を表示しています。

**著作権について**: ベジ探の著作権ページ（https://vegetan.alic.go.jp/chosaku.html）は「著作権は機構に帰属し、
私的使用・引用等を除き無断転載・複製不可」という一般的な著作権表示であり、政府標準利用規約のような
オープンライセンスではありません。本サイトはページを複製せず、価格等の数値（事実データ）を独自に
集計・可視化しています。法的な整理とリスク評価は [docs/legal-notes.md](docs/legal-notes.md) を参照してください。

### フィクスチャ開発フロー（重要）
開発サンドボックスからは `vegetan.alic.go.jp` へ egress 403 で到達できません（本番の GitHub Actions
ランナーからは 200 を確認済み）。そのため:

1. `.github/workflows/probe.yml` を本番ランナーで実行し、実レスポンスを `data/raw-samples/files/` にコミットバック
2. その**実ファイルをフィクスチャ**として `src/lib/xlsx.mjs` / `src/lib/vegetan.mjs` のパーサを開発・テスト
3. `node scripts/fetch.mjs --source=vegetan --fixtures` でフィクスチャから `data/items/` を生成して検証
4. 本番は同じ正規化経路で HTTP から取得（**fetch→normalize の経路はフィクスチャ/HTTP共通**）

```bash
node scripts/fetch.mjs --source=vegetan --fixtures   # 開発: 実フィクスチャから
node scripts/fetch.mjs --source=vegetan              # 本番: HTTP から（要ネットワーク到達）
node scripts/fetch.mjs --source=commodity            # 凍結アーカイブの再取得（差分ゼロで無害）
```

> 注意: `scripts/probe.mjs` は再実行時に `data/raw-samples/` を上書きします。vegetan アダプタの
> テストと `--fixtures` モードが読む実ファイルは `test/fixtures/vegetan/` に恒久保存してあるため、
> プローブの再実行でテストが壊れることはありません。フィクスチャを更新する際は raw-samples から
> コピーし直して差分を確認してください。

### アーカイブソース: 国際コモディティ（commodity アダプタ）
[Frictionless Data「Commodity Prices」](https://github.com/datasets/commodity-prices)（ODC-PDDL / IMF原データ）。
2017年6月で更新停止した月次アーカイブで、`/archive/` 配下に「国際市況アーカイブ」として維持しています。

### データ鮮度の自動判定（**データソース単位**）
`src/lib/freshness.mjs` がビルド時に**データソースごと**に最新データ日付を判定します
（90日閾値）。vegetan がライブな間、野菜ページは「毎日自動更新」系のコピー、
commodity のページ（`/archive/` と各品目）はアーカイブバナー付きの表示になります。
同じビルド内でページ単位に正しく出し分けられます。

## 運用フロー（完全自動）

`.github/workflows/update.yml` が日次（JST 07:00 / 22:00 UTC）に実行:

1. `npm test` で回帰チェック
2. `node scripts/fetch.mjs --source=vegetan` → `--source=commodity` の順にデータ取得
   （**fail-safe**: 失敗時は既存データを壊さず継続。commodity は凍結済みなので失敗しても差分ゼロ）
3. `data/` に差分があれば自動コミット＆プッシュ（＝日次時系列の蓄積。過去日の値が再取得で変わったら上書き）
4. `node scripts/build.mjs` で `public/` を生成
5. `actions/deploy-pages` で GitHub Pages へデプロイ

手動実行は Actions の `workflow_dispatch` から可能です。

## ディレクトリ構成

```
config/        site.json（サイト/収益化設定）, items.json（品目カタログ＋slug↔xlsx対応表）
data/          正規化済みJSON（items/<slug>.json, meta.json）＝gitで履歴管理
                raw-samples/（probe.mjs が保存する本番ソースの生サンプル＝パーサ開発用フィクスチャ）
public/        ビルド成果物（gitignore）
scripts/       fetch.mjs, build.mjs, serve.mjs, probe.mjs
src/lib/       xlsx（依存ゼロxlsxパーサ）, wareki（和暦変換）, vegetan（ベジ探正規化）,
                csv, normalize, stats, chart, report, format, html, sources, paths, freshness
src/templates/ layout.mjs（ページシェル・CSS・広告スロット・ソース別鮮度バナー）
docs/          data-sources.md, architecture.md
.github/workflows/update.yml, probe.yml
test/          xlsx / wareki / vegetan / normalize / stats / freshness / build のユニットテスト
```

## 収益化の設定

`config/site.json`:
- `adsenseClientId` を設定すると全ページに AdSense タグを出力（未設定なら一切出力しない）。
- `adsenseSlotTop` / `adsenseSlotItem` でスロットIDを指定。
- `affiliate.enabled` と品目の `buyKeyword` でアフィリエイト導線を拡張可能。

## ライセンス / 免責
- 野菜価格: 出典：独立行政法人農畜産業振興機構『ベジ探』のデータを加工して作成
  （原資料: 農林水産省「青果物卸売市場調査（日別調査）」等）。
- 国際市況アーカイブ: ODC-PDDL-1.0（Frictionless Data / IMF原データ）。
- 生成データの出典・ライセンスは各ページの「データ出典」および `data/meta.json` に明記。
- 価格は参考値であり、実取引を保証するものではありません。
