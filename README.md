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
| 都市別小売 | `kouri_cyousa/{name}.xlsx`（品目別。`kyabetu`・`negi`・`tomato` 等**先方の表記のまま**） | 品目ごとに1シート（シート名=品目名）。先頭の「小売価格（円/kg）」ブロックが 行=都市（札幌市・仙台市・東京23区…9都市＋全国）×列=月（年度=4月始まりの12列）。年度は表題「（令和8年度）」を正として日付化。**月次調査**なので鮮度表現は「月次調査」（毎日更新ではない）。`retail` データセットとして `data/retail/<slug>.json` に品目×都市×月で蓄積 |

品目slug ↔ xlsxファイル名・シート名の対応は `config/items.json` の各品目の
`monthlyKey` / `dailyBook` / `dailySheet`（卸売）・`retailKey` / `retailSheet`（都市別小売）
フィールドが正です。都市名→slug の対応表は同ファイルの `retail.cities`。

都市別小売の取得・生成:

```bash
node scripts/fetch.mjs --source=retail --fixtures   # 開発: 実フィクスチャから data/retail/ を生成
node scripts/fetch.mjs --source=retail              # 本番: HTTP から（要ネットワーク到達）
```

生成ページ: `/retail/`（全都市一覧＋概況）、`/retail/{city-slug}/`（都市別の品目×月テーブル・
前月比・全国平均比で割安な品目）。各品目ページ `/items/{slug}/` にも「都市別の小売価格」テーブルと
選び方・保存・価格の見方の解説を追加。

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

### 補助ソース: e-Stat「青果物卸売市場調査」（estat アダプタ）
農林水産省「青果物卸売市場調査」（e-Stat API v3・`statsCode=00500226`）の
**年次確報**を、産地別・消費地域別の卸売データ（＝公的裏付けの詳細データ）として取得します。
日次の鮮度はベジ探で維持し、こちらは**年に一度公表**される確報値です（2024年調査分が2026-03-31公開）。

- 発見: `getStatsList`（`searchWord=主要消費地域別`）を今年→過去へ試し、`NUMBER>0` の
  最初の年を「最新公表年」とする。タイトル末尾の品目名を `config/items.json` の
  `estatTitle`（多品種は `estatVariety:"計"`）と突合。
- 取得: 品目ごとに `getStatsData` を叩き、`src/lib/estat.mjs` で正規化して
  `data/estat/<slug>.json` へ（産地上位5シェア・消費地域別の月別卸売価格・全国加重平均）。
  野菜表（産地48×数量価格×消費地域12×対象月）と果実表（対象月×数量価格×「消費地域_産地計」複合軸）の
  **両構造**に対応。
- **冪等・スキップ**: 年次データなので、既取得年が「最新公表年」以上なら **API 呼び出しゼロで即終了**
  （`--force` で強制再取得）。fail-safe（失敗時も既存 data/ 無傷で exit 0）。
- **appId の秘匿**: `ESTAT_APP_ID`（GitHub Secret）は env 経由でのみ受け取り、URL 組み立て直前に
  だけ差し込む。ログ・エラーメッセージからは scrub。
- **鮮度の正直表示**: e-Stat 由来のセクション／果実ページには
  「農林水産省「青果物卸売市場調査」<最新公表年>年調査（年次公表）」と明記し、日次更新と区別
  （年次データなのでアーカイブバナーは出さず、セクション内の注記で表現）。

```bash
node scripts/fetch.mjs --source=estat --fixtures   # 開発: test/fixtures/estat/ から data/estat/ を生成
node scripts/fetch.mjs --source=estat              # 本番: e-Stat API から（ESTAT_APP_ID 必須・既取得年ならゼロ呼び出し）
node scripts/fetch.mjs --source=estat --force      # 最新公表年でも強制再取得
```

生成ページ: 果実12品目 `/items/{slug}/`（月別卸売チャート・産地構成バー・消費地域別テーブル・解説）、
トップの「果実」セクション、estat データのある野菜ページ（だいこん・キャベツ等）への
「産地と地域別の卸売価格（政府統計）」セクション。
**出典表記**: 「出典：農林水産省「青果物卸売市場調査」（e-Stat）を加工して作成」（政府標準利用規約準拠）。

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
