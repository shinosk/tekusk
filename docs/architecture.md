# アーキテクチャ

## 概要
公開オープンデータを日次で取得し、正規化してリポジトリ内 JSON（時系列DB）に蓄積、
そこから静的HTMLを生成して GitHub Pages に配信する、完全自動運用の静的サイトジェネレータ。
フレームワーク不使用・**外部npm依存ゼロ**（Node.js 標準APIのみ）。

## データフロー

```
[オープンデータCSV]
      │  scripts/fetch.mjs   (source adapter → 正規化 → マージ)
      ▼
   data/items/<slug>.json   ← gitにコミット＝時系列DB（履歴が価格の推移になる）
   data/meta.json
      │  scripts/build.mjs   (鮮度判定 → 統計計算 → テンプレート → SVGチャート)
      ▼
   public/                  ← ビルド成果物（.gitignore）
      │  GitHub Actions: actions/deploy-pages
      ▼
   GitHub Pages
```

## プローブ→本番ソース実装フロー（開発時のみ）

```
.github/workflows/probe.yml (workflow_dispatch)
      │  GitHub Actions ランナー（本サンドボックスと異なりegress制限なし）から
      │  scripts/probe.mjs を実行
      ▼
   data/raw-samples/index.json, data/raw-samples/files/
      │  実行ブランチへ自動コミット・プッシュ
      ▼
   開発者が data/raw-samples/ の実データ（HTML構造・CSV/Excel列構成）を確認
      ▼
   src/lib/sources.mjs の estatAdapter.fetchCsv を実装
   （必要なら config/items.json の列マッピングを調整）
      ▼
   node scripts/fetch.mjs --source=estat でソース切替（build.mjs 側は無改修）
```

この一連の流れは「実データを見ないまま憶測でパーサを書かない」という本プロジェクトの方針を
維持したまま、本番想定ソース（東京都中央卸売市場・ベジ探・農水省・e-Stat）への到達性と
実際のレスポンス形式を確認するためのものです。`scripts/probe.mjs` は `scripts/fetch.mjs` と同じ
fail-safe設計（1つのURLの失敗が他に波及しない・必ずexit 0）を踏襲しています。

## モジュール

| パス | 役割 |
|---|---|
| `config/site.json` | サイト名・baseUrl・AdSense/アフィリエイト設定 |
| `config/items.json` | 品目カタログ（ソース列名 → slug/和名/分類/単位/旬） |
| `src/lib/csv.mjs` | 依存なしCSVパーサ、数値パース（`nan`→null） |
| `src/lib/normalize.mjs` | 横持ちCSV→品目別時系列。マージ（冪等・蓄積）。**純関数** |
| `src/lib/stats.mjs` | 前月比/前年比/平年比/移動平均/買い時判定/ランキング。**純関数** |
| `src/lib/chart.mjs` | SVG折れ線チャート自前生成（CDN不使用） |
| `src/lib/report.mjs` | 週報・見出し・品目文の機械生成（テンプレ＋数値埋め込み） |
| `src/lib/format.mjs` | 和書式（数値・％・年月） |
| `src/lib/html.mjs` | HTMLエスケープ、JSON-LD出力 |
| `src/lib/sources.mjs` | ソースアダプタ（`commodity` / `estat`）、リトライ付きfetch |
| `src/lib/freshness.mjs` | データ鮮度（アーカイブ判定・90日閾値）→コピー/バナー切替。**純関数** |
| `src/templates/layout.mjs` | ページシェル（head/meta/OGP/JSON-LD/CSS/広告スロット/鮮度バナー） |
| `scripts/fetch.mjs` | 取得・正規化・書き込み（fail-safe） |
| `scripts/build.mjs` | data/ → public/ 生成（鮮度判定を反映） |
| `scripts/probe.mjs` | 本番想定ソース候補への到達性・実データサンプル収集（fail-safe、開発用） |
| `scripts/serve.mjs` | ローカルプレビュー用サーバ |

## 設計上のポイント

- **fail-safe fetch**: 取得・正規化に失敗した場合、既存 `data/` を一切変更せず終了コード0で抜ける
  （`--strict` で1）。ネットワーク断でサイトが壊れない。0品目に正規化されたら書き込み拒否。
- **fail-safe probe**: `scripts/probe.mjs` も同じ思想。どのURLが失敗しても他の候補URLの取得を継続し、
  結果はすべて `data/raw-samples/index.json` に記録したうえで必ず終了コード0で終わる。
  再実行時は `data/raw-samples/` を上書きするため、実行のたびにディレクトリが肥大化しない。
- **冪等・蓄積**: `mergeSeries` が日付キーでマージ。同一データの再取得は同一結果。
  日次の増分ソースでも履歴が積み上がる。
- **データ鮮度に応じた誠実な表示**: `src/lib/freshness.mjs` がビルド時に全品目の最新データ日付を判定し、
  90日より古ければ「毎日自動更新」等の現在性を示す文言を排して長期アーカイブとしての表現・バナーに切り替える。
  最新日付が90日以内に戻れば自動的に「自動更新」系のコピーへ戻る（手動でのコピー書き換えは不要）。
- **純関数コア**: 正規化・統計・鮮度判定はI/Oを持たず、`node --test` で単体テスト可能。
- **依存ゼロ**: CSV/チャート/サーバ/プローブをすべて標準APIで自作。サプライチェーンリスク最小。
- **AdSense**: `config/site.json` の `adsenseClientId` が空なら広告タグを一切出力しない。
- **軽量**: 全ページ100KB以下（実測: トップ16KB、品目ページ最大20KB、CSS4KB）。

## 収益化フック
- AdSense: `adsenseClientId` 設定時のみ head の配信スクリプトと各スロットを出力。
- アフィリエイト: `config/site.json` の `affiliate` と品目の `buyKeyword` を利用して拡張可能。
- SEO: 各ページに title/description、JSON-LD（Dataset・BreadcrumbList）、canonical、OGP、
  sitemap.xml、robots.txt を自動生成。
