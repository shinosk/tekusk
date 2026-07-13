# データソース実在性検証レポート

> **2026-07-10 更新: ベジ探を本番ソースとして実装済み。** 本番 GitHub Actions ランナーの
> probe（`data/raw-samples/`）で実ファイルを取得・コミットバックし、その実フィクスチャに
> 対して `vegetan` アダプタ（`src/lib/sources.mjs` + `src/lib/vegetan.mjs` +
> 依存ゼロxlsxパーサ `src/lib/xlsx.mjs`）を実装した。詳細は下記
> 「採用ソース: 農畜産業振興機構『ベジ探』（実装済み）」を参照。

検証日: 2026-07-09
検証方法: ビルド環境コンテナから `curl`（`HTTPS_PROXY` 経由）および Node.js `fetch` による実 HTTP リクエスト。

## 重要な前提: ビルド環境のegress制限

本コンテナの外向き通信は **許可リスト方式のegressプロキシ** を通ります。実測の結果、
到達できるのは GitHub 系ホスト（`raw.githubusercontent.com`, `api.github.com`,
`media.githubusercontent.com`）、`storage.googleapis.com`, `s3.amazonaws.com`、
および各種パッケージレジストリのみでした。

**日本政府系のデータ配信ホストはすべて CONNECT 段階で `403`（ポリシー拒否）** となり、
User-Agent を付与しても到達できません（サイト側の403ではなく、組織のegressポリシーによるブロック）。
これは「データソースが存在しない/廃止された」こととは異なり、
**本番実行環境（GitHub Actions のホストランナー）からは通常どおり到達可能** です。

実測ログ（`curl -sS -m30`、proxyの `/__agentproxy/status` が記録した理由）:

| ホスト | 結果 |
|---|---|
| `www.shijou.metro.tokyo.lg.jp:443` | `connect_rejected` 403（policy denial） |
| `www.maff.go.jp:443` | `connect_rejected` 403 |
| `vegetan.alic.go.jp:443` | `connect_rejected` 403 |
| `www.e-stat.go.jp:443` / `data.e-stat.go.jp` / `api.e-stat.go.jp` | `connect_rejected` 403 |
| `www.data.go.jp:443` | `connect_rejected` 403 |
| （参考）`example.com`, `www.google.com` | 同じく 403（=汎用サイトも不可） |
| `raw.githubusercontent.com` | **200（到達可）** |

## 1. 東京都中央卸売市場 市場統計情報（日報・週報）
- URL: https://www.shijou.metro.tokyo.lg.jp/
- 想定形式: CSV / Excel（日報・月報）
- 更新頻度: 日次〜月次
- **ビルド環境からの取得可否: 不可（egress 403）。** 実在性・レイアウトはサンドボックスから確認できず。
- 備考: 実在は公知だが、正確な列レイアウトを本環境で確認できないため、憶測でパーサを書くことは避けた。
  利用条件は東京都のオープンデータ方針（政府標準利用規約準拠、出典明示で二次利用可）に従う想定。

## 2. 農畜産業振興機構「ベジ探」 → **採用・実装済み（vegetan アダプタ）**
- URL: https://vegetan.alic.go.jp/
- **ビルド環境からの取得可否: 不可（egress 403）だが、本番 GitHub Actions ランナーからは 200 を確認済み。**
- probe ワークフローが取得した実ファイル（`data/raw-samples/files/`）をフィクスチャとして
  パーサを実装した。実装対象と構造:

### 日次卸売データ（実装済み・本命）
- URL: `https://vegetan.alic.go.jp/kakakugurafu/{youkeisai,kasai,konsai,imo}.xlsx`
  （葉茎菜・果菜・根菜・いも類。フィクスチャ: files/005〜008）
- 各ブックに品目別シート（例「トマト」）＋「集計表」。1シート内に約40行×4ブロック＝
  市場別（シート先頭行のタイトルで確認: **東京都中央卸売市場**・名古屋市・大阪市・福岡市）。
  先頭の東京ブロックを採用。
- ブロック構造: 日付行（1列目=月初日のExcelシリアル値、以降 "6/1","2",…,"7/2" と月をまたぐ
  日ラベル）→「入荷量」「卸売価格」「平均価格」（=平年値）「平年比」の行。列=日々。
- 当月分のみの提供（未来日セルは null / "#N/A"）。日次の長期蓄積は本リポジトリの
  `data/items/*.json` への追記マージ（`mergeByDate`）で実現し、過去日の改定値は再取得で上書き。
- 原資料: 農林水産省「青果物卸売市場調査（日別調査）結果」（シート末尾の資料行に明記）。

### 月次長期卸売（小売）価格（実装済み）
- URL: `https://vegetan.alic.go.jp/wp-content/uploads/{item}.xlsx` の19品目
  （`cabbage, spinach, chinese-cabbage, welsh-onion, rettuce, wthite-potato, taros, radish,
  carrot, onion, cucumber, eggplant, tomato, green-pepper, broccoli, asparagus, sweet-potato,
  burdosk, lotus-root` — **先方のtypoごと正確に**。フィクスチャ: files/011〜029）
- シート「Sheet１」: 行=月（1月〜12月）＋年平均値行、列=年。年見出しは和暦・西暦混在
  （「平成18年ヘイセイネン」「2008年ネン」等、ふりがな混入あり）。さらに
  **先頭に見出しの無い2005年列**、末尾に「平年値」列（=直近5か年平均。トマト1月で
  avg(2021〜2025)=772.4 と一致することを検算し、列対応を確定）。
- 値の単位: 円/kg。当年の未来月にも値が入っているため fetch 時に当月までにキャップする。
- 和暦→西暦変換は `src/lib/wareki.mjs`（平成/令和/昭和・元年・ふりがな耐性）。

### 都市別小売価格（スコープ外・将来用）
- URL: `https://vegetan.alic.go.jp/kouri_cyousa/*.xlsx`（フィクスチャ: files/032〜048）
- 品目別・都市別の小売価格。今回は実装対象外だが、フィクスチャは取得済みで
  xlsxパーサのラウンドトリップテスト対象には含めている。

### 利用条件・出典表記
- 全野菜ページに「**出典：独立行政法人農畜産業振興機構『ベジ探』のデータを加工して作成**」を表示。
- **2026-07-10 追記: 利用規約原文を本番プローブ（round 3）で取得・確認済み**
  （`data/raw-samples/files/001-vegetan.alic.go.jp_riyou.html.html` /
  `002-vegetan.alic.go.jp_chosaku.html.html`）。著作権条件を記載しているのは `chosaku.html`
  （「著作権について」）で、`riyou.html`（「当ホームページのご利用に当たって」）は推奨ブラウザ・
  SSL・PDF閲覧に関する別ページであり著作権とは無関係だった。
  `chosaku.html` の要旨:「掲載されている情報の著作権は、特記されていない限り、機構に帰属します。
  内容の全部又は一部については、私的使用又は引用等著作権法上認められた行為を除き、当機構に無断で
  引用、転載、複製を行うことはできません」— **政府標準利用規約のようなオープンライセンス（出典表示のみ
  で二次利用可）ではない**。本サイトはページ・文章・レイアウトを複製せず、価格等の数値（事実データ）を
  独自に集計・可視化し、全ページに出典（「出典：独立行政法人農畜産業振興機構『ベジ探』のデータを加工して
  作成」）を明記している。
  `src/lib/sources.mjs` の `vegetanAdapter.license` / `licenseUrl` はこの事実を反映済み
  （`licenseUrl` は `chosaku.html` を指す）。

## 3. 農林水産省 食品価格動向調査（野菜等の小売価格・週次）
- URL: https://www.maff.go.jp/j/zyukyu/anpo/kouri/
- 想定形式: Excel / CSV（週次）
- 更新頻度: 週次
- **ビルド環境からの取得可否: 不可（egress 403）。**
- ライセンス: 農水省サイトは政府標準利用規約（出典明示で二次利用可、CC BY互換）。
- 備考: 本番の第一候補。GitHub Actions からは到達可能な見込み。正確なファイルURL・列構成はライブ応答に対して確定する必要がある。

## 4. e-Stat（CSV直リンク／API）
- URL: https://www.e-stat.go.jp/ , https://data.e-stat.go.jp/ , https://api.e-stat.go.jp/
- 想定形式: CSV ダウンロード、統計API（appId必要）
- **ビルド環境からの取得可否: 不可（egress 403、robots.txt も取得不可）。**
- ライセンス: 政府標準利用規約（第2.0版）。出典表示のうえ二次利用可。
- 備考: 小売物価統計調査の野菜小売価格などが該当。本番の有力候補。

## アーカイブとして維持するソース（初期構築時に採用）

### Frictionless Data「Commodity Prices」→ 現在は「国際市況アーカイブ」（/archive/）
- 取得URL: https://raw.githubusercontent.com/datasets/commodity-prices/main/data/commodity-prices.csv
- ホームページ: https://github.com/datasets/commodity-prices
- 形式: CSV（横持ち。1列=1品目、1行=1か月）
- 期間: 1980-02 〜 2017-06（月次・449行）※アーカイブ済みで更新停止
- 原データ: IMF Primary Commodity Prices
- **ライセンス: ODC-PDDL-1.0（パブリックドメイン相当）** — 出典表示の義務すら無く、再配布・改変・商用可
  - licenseはリポジトリ同梱の `datapackage.json` の `licenses` フィールドで確認（`ODC-PDDL-1.0`）
- robots: `raw.githubusercontent.com` はGitHubのraw配信で、当該公開リポジトリのファイル取得は許容範囲
- **取得可否: 可（HTTP 200、398KB、実データ確認済み）**
- 採用理由: 本環境の許可リストから機械的に定期取得できる、食品・青果を含む実在の価格データはこれが唯一だった。
  野菜・果物そのもの（バナナ・オレンジ）に加え、米・小麦・大豆・食用油・畜産・水産・嗜好品など食品コモディティを含む。

#### この採用がビジネス要件との間に持つ差異（正直な開示）
- 本来ターゲットは「日本の卸売市場の日次野菜価格」。本ソースは「国際商品市況の月次価格（USD建て）」であり、
  地域・通貨・粒度・鮮度が異なる。
- データが2017年で凍結しているため「毎日更新で最新値が動く」ことはこのソースでは実演できない
  （システムの日次自動更新の仕組み自体は実装・検証済み。ソースを本番用に差し替えれば最新値が日々進む）。
- そのため本サイトは「食品コモディティ価格（青果を含む）」として正確に表示・出典明示し、
  誇張のない範囲でトップの企画（値上がり/値下がり、平年比、買い時）を提供している。

## 本番ランナーからの到達性検証（probe workflow）

上記の egress 403 は**このビルドサンドボックス固有の制約**であり、日本政府系ホストが
実在しない/廃止されたことを意味しません。本番の GitHub Actions ホストランナーからは
通常どおり到達できる可能性が高いため、その検証自体を自動化しています。

- `.github/workflows/probe.yml`（`workflow_dispatch` 専用）を手動実行すると、
  ランナー上で `node scripts/probe.mjs` が下記の候補URLへ実際にHTTPリクエストを行い、
  HTTPステータス・content-type・本文サンプル（テキストは先頭200KB、バイナリは先頭1MB）を
  `data/raw-samples/index.json` と `data/raw-samples/files/` に保存し、実行ブランチへコミット・プッシュします。
- round 3（完了）: ベジ探の利用規約・著作権ページ
  （`https://vegetan.alic.go.jp/riyou.html`, `https://vegetan.alic.go.jp/chosaku.html`）を取得。
  結果は上記「利用条件・出典表記」の追記を参照。
- round 4（e-Stat 対応・実装済み）: e-Stat「青果物卸売市場調査」（`statsCode=00500226`）のAPIエンドポイント
  を特定し、`estat` アダプタ（`src/lib/estat.mjs`）として実装した。東京都中央卸売市場「市場統計情報」は
  サイトがJS動的CMSのため、HTML直取得ではなくAPI/documentsエンドポイントの調査が別途必要で、
  現時点では未対応。
- `scripts/probe.mjs` は `scripts/fetch.mjs` と同じfail-safe設計です。1つのURLが失敗（403等）しても
  他のURLの取得を継続し、結果はすべて記録したうえで必ず終了コード0で終わります。
  再実行時は `data/raw-samples/` を**上書き**するため、実行のたびに肥大化することはありません
  （＝現在のxlsxフィクスチャも消えます。フィクスチャ依存のテストは不在時スキップになりますが、
  パーサ検証用の実ファイルを更新する場合は差分に注意）。
- **開発フロー（実績）**: probe実行 → `data/raw-samples/files/` の実xlsxを確認 →
  その実データに基づいて `src/lib/xlsx.mjs`（依存ゼロxlsxパーサ）と `src/lib/vegetan.mjs`
  （正規化）・`vegetanAdapter`（`src/lib/sources.mjs`）を実装 →
  `node scripts/fetch.mjs --source=vegetan --fixtures` でフィクスチャから検証 →
  本番は `--fixtures` を外すだけ（fetch→normalize経路は共通）。サイト生成側は無改修。

## ソースアダプタ方式

`src/lib/sources.mjs` にアダプタを定義。`vegetan`（**本番稼働・日次**）、`commodity`
（凍結アーカイブ・/archive/ 配下で維持）、`estat`（将来の追加候補・スタブ）を用意。
`config/items.json` の各品目は `source` フィールドでアダプタに紐づき、野菜品目は
`monthlyKey`（月次xlsxファイル名）・`dailyBook`・`dailySheet`（日次ブック・シート名）の
対応表を持つ。`data/meta.json` はソース別の `sources.{id}` を持ち、ビルドはソース単位で
データ鮮度（ライブ/アーカイブ表示）を判定する。
