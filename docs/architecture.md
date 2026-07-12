# アーキテクチャ

## 概要
公開オープンデータを日次で取得し、正規化してリポジトリ内 JSON（時系列DB）に蓄積、
そこから静的HTMLを生成して GitHub Pages に配信する、完全自動運用の静的サイトジェネレータ。
フレームワーク不使用・**外部npm依存ゼロ**（Node.js 標準APIのみ。xlsxのZIP/XML解析も自作）。

主役は日本の野菜卸売価格（`vegetan` アダプタ＝ベジ探）。国際コモディティ（`commodity`）は
2017年で凍結されたアーカイブとして `/archive/` 配下に維持する。

## データフロー

```
[ベジ探 .xlsx（日次卸売×4ブック + 月次長期×19）]   [コモディティCSV（凍結）]
      │  scripts/fetch.mjs --source=vegetan            │  --source=commodity
      │  (adapter.fetchRaw → xlsx.mjs → vegetan.mjs 正規化 → mergeByDate)
      ▼                                                ▼
   data/items/<slug>.json   ← gitにコミット＝時系列DB（日次は追記蓄積・再取得で上書き）
   data/meta.json           ← sources: { vegetan: {...}, commodity: {...} }（ソース別）
      │  scripts/build.mjs   (ソース別鮮度判定 → 統計計算 → テンプレート → SVGチャート)
      ▼
   public/                  ← ビルド成果物（.gitignore）
      │  GitHub Actions: actions/deploy-pages
      ▼
   GitHub Pages
```

## フィクスチャ開発フロー（ベジ探）

開発サンドボックスは egress 制限で `vegetan.alic.go.jp` へ到達できない（403）。
本番 GitHub Actions ランナーで `scripts/probe.mjs` を実行して実レスポンスを
`data/raw-samples/files/` にコミットバックし、その**実ファイルをフィクスチャ**として
パーサを開発・テストする。

```
probe.yml (workflow_dispatch, 本番ランナー)
   → data/raw-samples/files/*.xlsx をコミットバック
   → src/lib/xlsx.mjs / vegetan.mjs をフィクスチャに対して開発・テスト
   → node scripts/fetch.mjs --source=vegetan --fixtures で検証
   → 本番は同一の正規化経路で HTTP 取得（経路はフィクスチャ/HTTP共通、
     分岐は vegetanAdapter.fetchRaw のバイト入手部分のみ）
```

「実データを見ないまま憶測でパーサを書かない」方針はこの仕組みで維持している。
probe.mjs の SEED_URLS は round 4 で次期データソース候補（e-Stat「青果物卸売市場調査」
`toukei=00500226` と 東京都中央卸売市場の月報・日報一覧）を指す。e-Stat のファイル直リンク
`/stat-search/file-download?statInfId=...` をリンク追跡対象に追加し、MAX_TEXT_BYTES を 1MB に
引き上げて東京都の大きな一覧ページ（〜750KB）を全文保存する。

## ベジ探データの構造（フィクスチャで確認済みの事実）

- **日次卸売** `kakakugurafu/{youkeisai,kasai,konsai,imo}.xlsx`
  - ブック=部類（葉茎菜・果菜・根菜・いも類）、シート=品目（例「トマト」）＋「集計表」
  - 1シートに約40行×4ブロック＝市場別（先頭行タイトルで確認: 東京都中央卸売市場・
    名古屋市・大阪市・福岡市）。**先頭の東京ブロックを採用**
  - ブロック構造: 日付行（先頭セル=月初日のExcelシリアル値、以降 "6/1","2",...,"7/2" と
    月をまたぐラベル）→「入荷量」「卸売価格」「平均価格」（=平年値）「平年比」の行
  - 当月+翌月分のセル枠があり、未来日は null/#N/A → スキップ。日次の長期蓄積は
    data/ への mergeByDate 追記で実現（過去日の再取得値は上書き）
- **月次長期** `wp-content/uploads/{item}.xlsx`（19品目、ファイル名は先方のtypoごと:
  `rettuce`, `wthite-potato`, `burdosk` 等）
  - シート「Sheet１」: 行=月（1月〜12月）、列=年。年見出しは和暦・西暦混在
    （「平成18年」「2008年」）＋**先頭に無ラベルの2005年列**＋末尾に「平年値」列
    （平年値=直近5か年平均であることを実データで検算して列対応を確定）
  - 単位: 円/kg。当年の未来月も埋まっているため fetch 時に当月までにキャップ
- **都市別小売** `kouri_cyousa/{name}.xlsx`（品目別。先方表記の romaji: `kyabetu`,
  `negi`, `tomato` 等）— `retail` アダプタ＋ `src/lib/retail.mjs` で実装済み
  - 1品目=1シート（シート名=品目名。ねぎは 白ねぎ/青ねぎ の2シート→白ねぎを採用）
  - 先頭の「小売価格（円/kg）」ブロック: 行=都市（9都市＋全国）×列=月。年度は4月始まりで
    列2が無ラベルの4月、列3以降に「５月」..「３月」。表題「（令和8年度）」を正として西暦へ
  - **月次調査**。`data/retail/<slug>.json` に品目×都市×月で mergeByDate 蓄積（年度替わりで
    ブックの列がリセットされても履歴が積み上がる）。鮮度表現は「月次調査」（毎日更新と書かない）

## モジュール

| パス | 役割 |
|---|---|
| `config/site.json` | サイト名・baseUrl・AdSense/アフィリエイト設定 |
| `config/items.json` | 品目カタログ。野菜は `source:"vegetan"` + `monthlyKey`/`dailyBook`/`dailySheet`（slug↔xlsx対応表）、コモディティは `source:"commodity"` + `column` |
| `src/lib/xlsx.mjs` | **依存ゼロ .xlsx パーサ**。ZIPは**セントラルディレクトリ**を正として解析し `node:zlib.inflateRawSync` で展開。workbook.xml/rels/sharedStrings/worksheet を最小限パースし、シート名一覧と2次元配列を返す |
| `src/lib/wareki.mjs` | 和暦（平成/令和等）→西暦変換、Excelシリアル日付変換。**純関数** |
| `src/lib/vegetan.mjs` | ベジ探ブックの正規化（日次ブロック抽出・月次年列マップ）。**純関数** |
| `src/lib/retail.mjs` | 都市別小売（kouri_cyousa）ブックの正規化（品目×都市×月）。年度パース・月列復元・都市slug付与＋ view helper（latestChange/monthsAcross）。**純関数** |
| `src/content/items.mjs` | 野菜19品目の常設解説文（旬・選び方・保存・価格の動き）。品目ページで表示。**データ非依存の静的コンテンツ** |
| `src/lib/csv.mjs` | 依存なしCSVパーサ、数値パース（`nan`→null） |
| `src/lib/normalize.mjs` | 横持ちCSV→品目別時系列。`mergeSeries`/`mergeByDate`（冪等・蓄積・全フィールド保持）。**純関数** |
| `src/lib/stats.mjs` | 統計。vegetan日次品目は**ソース提供の平年比**で買い時判定（`normalRatio < 0.9`）+ 日次ベースの直近1週間変化（rankPct）、月次品目は従来の前月比ベース。**純関数** |
| `src/lib/chart.mjs` | SVG折れ線チャート自前生成（`xFormat:'md'` で日次のM/D軸に対応） |
| `src/lib/report.mjs` | 週報・見出し・品目文の機械生成（日次/月次で文面を切替） |
| `src/lib/format.mjs` | 和書式（数値・％・年月日） |
| `src/lib/html.mjs` | HTMLエスケープ、JSON-LD出力 |
| `src/lib/sources.mjs` | ソースアダプタ（`vegetan` / `commodity` / `estat` スタブ）、リトライ付きfetch（テキスト/バイナリ） |
| `src/lib/freshness.mjs` | データ鮮度（90日閾値）→コピー/バナー切替。**純関数**。build.mjs が**ソース単位**に適用 |
| `src/templates/layout.mjs` | ページシェル。`page.freshness` でページ（＝ソース）単位のバナー/フッター切替 |
| `scripts/fetch.mjs` | 取得・正規化・書き込み（fail-safe・ソース別 meta マージ・`--fixtures`） |
| `scripts/build.mjs` | data/ → public/ 生成（野菜中心トップ・/archive/・2段チャート品目ページ） |
| `scripts/probe.mjs` | 本番ソースの実データサンプル収集（fail-safe、開発用） |
| `scripts/serve.mjs` | ローカルプレビュー用サーバ |

## 設計上のポイント

- **fail-safe fetch**: 取得・正規化に失敗した場合、既存 `data/` を一切変更せず終了コード0で抜ける
  （`--strict` で1）。vegetan は個別ブックの失敗も握りつぶして残りを処理（0品目なら書き込み拒否）。
- **冪等・蓄積**: `mergeByDate` が日付キーでマージ（全フィールド保持）。同一データの再取得は同一結果。
  日次の増分ソース（当月分しか配布されない）でも履歴が積み上がり、過去日の改定値は上書きされる。
  月次系列も既存とマージするため、一時的なブック取得失敗で蓄積が消えない。
- **フィクスチャ=本番バイト**: パーサは本番ランナーが取得した実ファイルに対して開発・テスト。
  フィクスチャ/HTTP の分岐はアダプタのバイト入手部分だけで、正規化経路は共通。
- **鮮度はソース単位**: `meta.json` の `sources.{id}.latestDate` ごとに `freshnessCopy` を評価し、
  ページ単位で正しいコピー/バナーを出す。vegetan=ライブ表示、commodity=アーカイブ表示が同一ビルドで共存。
- **買い時=ソース提供の平年比**: ベジ探が計算済みの平年比（当日価格÷過去5か年同時期平均）を
  そのまま使い、`< 0.9` で「買い時」。自前の再計算より原典に忠実。
- **純関数コア**: xlsx/wareki/vegetan/正規化/統計/鮮度判定はI/Oを持たず `node --test` で単体テスト可能。
- **依存ゼロ**: xlsx(ZIP+XML)/CSV/チャート/サーバ/プローブをすべて標準APIで自作。サプライチェーンリスク最小。
- **出典表記**: 全野菜ページ・トップ・週報・aboutに
  「出典：独立行政法人農畜産業振興機構『ベジ探』のデータを加工して作成」を表示。
- **AdSense**: `config/site.json` の `adsenseClientId` が空なら広告タグを一切出力しない。

## 収益化フック
- AdSense: `adsenseClientId` 設定時のみ head の配信スクリプトと各スロットを出力。
- アフィリエイト: `config/site.json` の `affiliate` と品目の `buyKeyword` を利用して拡張可能。
- SEO: 各ページに title/description、JSON-LD（Dataset・BreadcrumbList）、canonical、OGP、
  sitemap.xml、robots.txt を自動生成。
