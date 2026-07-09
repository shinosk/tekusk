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
      │  scripts/build.mjs   (統計計算 → テンプレート → SVGチャート)
      ▼
   public/                  ← ビルド成果物（.gitignore）
      │  GitHub Actions: actions/deploy-pages
      ▼
   GitHub Pages
```

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
| `src/templates/layout.mjs` | ページシェル（head/meta/OGP/JSON-LD/CSS/広告スロット） |
| `scripts/fetch.mjs` | 取得・正規化・書き込み（fail-safe） |
| `scripts/build.mjs` | data/ → public/ 生成 |
| `scripts/serve.mjs` | ローカルプレビュー用サーバ |

## 設計上のポイント

- **fail-safe fetch**: 取得・正規化に失敗した場合、既存 `data/` を一切変更せず終了コード0で抜ける
  （`--strict` で1）。ネットワーク断でサイトが壊れない。0品目に正規化されたら書き込み拒否。
- **冪等・蓄積**: `mergeSeries` が日付キーでマージ。同一データの再取得は同一結果。
  日次の増分ソースでも履歴が積み上がる。
- **純関数コア**: 正規化・統計はI/Oを持たず、`node --test` で単体テスト可能。
- **依存ゼロ**: CSV/チャート/サーバをすべて標準APIで自作。サプライチェーンリスク最小。
- **AdSense**: `config/site.json` の `adsenseClientId` が空なら広告タグを一切出力しない。
- **軽量**: 全ページ100KB以下（実測: トップ16KB、品目ページ最大20KB、CSS4KB）。

## 収益化フック
- AdSense: `adsenseClientId` 設定時のみ head の配信スクリプトと各スロットを出力。
- アフィリエイト: `config/site.json` の `affiliate` と品目の `buyKeyword` を利用して拡張可能。
- SEO: 各ページに title/description、JSON-LD（Dataset・BreadcrumbList）、canonical、OGP、
  sitemap.xml、robots.txt を自動生成。
