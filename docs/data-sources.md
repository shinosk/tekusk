# データソース実在性検証レポート

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

## 2. 農畜産業振興機構「ベジ探」
- URL: https://vegetan.alic.go.jp/
- 想定形式: 検索フォーム経由の表・CSV
- **ビルド環境からの取得可否: 不可（egress 403）。**
- 備考: 動的検索UIが主体で、機械的な定期取得には各データのダウンロードエンドポイント特定が必要。本環境では検証不能。

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

## 実装対象として採用したソース（本環境で機械取得を確認できた唯一のソース）

### Frictionless Data「Commodity Prices」
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
- 対象URL: 東京都中央卸売市場（トップ／月報／日報）、ベジ探、農林水産省 食品価格動向調査、e-Stat。
  HTML応答からは `.csv/.xlsx/.xls/.zip` へのリンクや「日報・旬報・月報・統計・価格」を含む
  同一ホスト内リンクを最大10件まで1階層だけ追加取得します。
- `scripts/probe.mjs` は `scripts/fetch.mjs` と同じfail-safe設計です。1つのURLが失敗（403等）しても
  他のURLの取得を継続し、結果はすべて記録したうえで必ず終了コード0で終わります。
  再実行時は `data/raw-samples/` を上書きするため、実行のたびに肥大化することはありません。
- **開発フロー**: probe実行 → `data/raw-samples/` の実データ（HTMLのリンク構造、CSV/Excelの
  列レイアウトなど）を確認 → その実データに基づいて `src/lib/sources.mjs` の
  `estatAdapter.fetchCsv`（現状は意図的なスタブ）を実装 → `node scripts/fetch.mjs --source=estat` で
  本番ソースへ切り替え。サイト生成側（`scripts/build.mjs` 等）は無改修。

## ソースアダプタ方式

`src/lib/sources.mjs` にアダプタを定義。`commodity`（検証済み・稼働中）と `estat`（本番想定・スタブ）を用意。
本番では農水省/e-Stat 用アダプタの `fetchCsv` と、必要なら列マッピング（`config/items.json`）を実装すれば、
サイト生成側は無改修で日本の青果価格に切り替わる。egress が開いた環境で
`node scripts/fetch.mjs --source=estat` を実行して実応答に対しパーサを確定する運用を想定。
