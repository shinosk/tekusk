# SETUP: オーナーが行う一度きりの作業

このドキュメントは、`野菜価格ナビ`（tekusk）を実際に公開・運用するために **人間（リポジトリオーナー）が
GitHub / Google 等の管理画面上で一度だけ行う必要がある作業** をまとめたものです。コード側の自動化
（データ取得・ビルド・デプロイ）は `.github/workflows/update.yml` が日次で行いますが、以下の項目は
コードでは代替できないため、手順に沿って作業してください。

各項目に所要時間の目安を記載していますが、審査待ち等の待機時間は含みません（申請作業自体の時間）。

## 1. リポジトリを Public に変更（所要: 2分）

**現状の事実**: このリポジトリ（`shinosk/tekusk`）は現在 **private** です。GitHub Pages は
無料プランでは public リポジトリでのみ利用可能なため、`.github/workflows/update.yml` の
Pages デプロイステップ（`actions/configure-pages@v5` / `actions/deploy-pages@v4`）は
**現状のままでは失敗します**（ワークフロー内のコメントにも明記済み）。

手順:
1. GitHub のリポジトリページ → `Settings` → `General` タブ
2. 最下部の `Danger Zone` → `Change repository visibility` → `Change to public`
3. 確認ダイアログでリポジトリ名を入力して確定

注意: `data/` ディレクトリに秘密情報が含まれていないか事前に確認してください（本リポジトリの
`data/` は価格データと機構サイトの利用規約ページのHTMLサンプルのみで、秘密情報は含まれていません）。

## 2. GitHub Pages の Source を「GitHub Actions」に設定（所要: 1分）

手順:
1. `Settings` → `Pages`
2. `Build and deployment` の `Source` を `Deploy from a branch` から **`GitHub Actions`** に変更

これにより `.github/workflows/update.yml` 内の `deploy-pages` ジョブがサイトを公開できるようになります。

## 3. 現在の作業ブランチを main にマージ（所要: 5分）

**現状の事実**: 日次の自動更新 cron（`schedule: cron: '0 22 * * *'` = JST 朝7時）は
**GitHub のデフォルトブランチ上でのみ発火する仕様**です。現在の作業は
`claude/revenue-automation-system-xh0uit` ブランチ上にあり、このままでは cron が動きません。

手順:
1. このブランチの内容をレビューする
2. Pull Request を作成し、`main`（デフォルトブランチ）にマージする
3. マージ後、`Actions` タブで `Daily update & deploy` ワークフローが `main` に対して
   スケジュール登録されていることを確認する（次回実行は最大24時間以内の JST 7:00）

## 4. サイトURLの確認（所要: 1分）

- 公開URL: **https://shinosk.github.io/tekusk/**（`config/site.json` の `baseUrl` と一致させてあります）
- 手順1〜3完了後、初回のワークフロー実行（`workflow_dispatch` で手動実行も可）が成功すれば、
  上記URLでサイトが閲覧できるようになります。`Settings` → `Pages` の上部にも公開URLが表示されます。

## 5. Google AdSense の設定（所要: 申請作業自体は15分、承認までの待機は別途1〜4週間程度）

手順:
1. https://www.google.com/adsense/ でアカウント作成
2. サイト（`https://shinosk.github.io/tekusk/`）を登録し、審査を申請
   （審査には一定量のコンテンツ・トラフィックが必要な場合があるため、サイト公開後しばらく運用してから
   申請するのが望ましい）
3. **承認後**、発行された Publisher ID（`ca-pub-XXXXXXXXXXXXXXXX` 形式）と広告ユニットのスロットIDを
   `config/site.json` の以下のフィールドに設定:
   - `adsenseClientId`: Publisher ID
   - `adsenseSlotTop`: トップページ用スロットID
   - `adsenseSlotItem`: 品目ページ用スロットID
4. 設定をコミット・プッシュすると、**次回の自動ビルドから広告が自動的に表示されます**
   （`src/templates/layout.mjs` が `adsenseClientId` の有無で出力を切り替える設計のため、
   コード変更は不要です）。

## 6. （任意）アフィリエイトの設定（所要: 登録作業30分〜1時間、審査待ちは別途数日〜数週間）

手順:
1. A8.net / Amazonアソシエイト / 楽天アフィリエイト等に登録し、審査を通過する
2. 「買い時野菜×レシピ」「保存容器」等、関連商品のリンクを取得する
3. `config/site.json` の `affiliate.enabled` を `true` にし、`affiliate.links` にリンク情報を設定する

**重要な注意（現状の実装ギャップ）**: AdSenseと異なり、`affiliate` フィールドは現時点では
**設定を保持するだけの箱**であり、実際にリンクを画面に表示するロジックはまだ実装されていません
（詳細: `docs/roadmap.md` フェーズB-2）。設定するだけでは何も表示されないため、表示ロジックの実装は
別途開発作業として依頼してください。

## 7. （推奨）ALIC（独立行政法人農畜産業振興機構）への利用連絡（所要: 15分程度）

**背景**: 本サイトが利用する「ベジ探」の著作権ページには、政府標準利用規約のような出典明示のみでの
自由な二次利用を認める記載はなく、無断転載・複製を禁じる一般的な著作権表示があります
（詳細・法的整理: `docs/legal-notes.md`）。本サイトはページの複製ではなく数値データの独自集計・
可視化にとどめていますが、無人運営サイトとしてリスクを下げるため、機構へ利用状況を連絡し、
問題がないか確認することを推奨します。

手順:
1. `docs/legal-notes.md`「4-(a)」に記載の連絡文テンプレートを参考に、機構の問い合わせ窓口へ連絡する
2. 回答内容によっては、リンク表記の修正や、データソースの一次統計（e-Stat等）への移行判断に反映する
   （`docs/roadmap.md` フェーズA参照）

## 8. （任意）独自ドメインの設定（所要: ドメイン取得10分＋DNS反映は数時間〜1日）

手順:
1. 任意のレジストラでドメインを取得（例: `.com` / `.jp` など）
2. `Settings` → `Pages` → `Custom domain` にドメインを入力し、指示に従って DNS に
   CNAME（サブドメインの場合）または A レコード（apex ドメインの場合）を設定
3. HTTPS の強制（`Enforce HTTPS`）を有効化（証明書発行後、数分〜数時間かかる場合あり）
4. `config/site.json` の `baseUrl` を新しいドメインに更新し、コミット・プッシュ
   （sitemap.xml / OGP / canonical URL がこの値を参照しているため）

---

## チェックリスト（要約）

| # | 項目 | 所要時間目安 | 必須/任意 |
|---|---|---|---|
| 1 | リポジトリを public に変更 | 2分 | 必須 |
| 2 | Pages Source を GitHub Actions に設定 | 1分 | 必須 |
| 3 | 作業ブランチを main にマージ | 5分 | 必須（cron発火に必要） |
| 4 | サイトURLの確認 | 1分 | 必須 |
| 5 | Google AdSense 設定 | 申請15分＋承認待ち1〜4週間 | 収益化に必須 |
| 6 | アフィリエイト設定 | 登録30分〜1時間＋審査待ち数日〜数週間 | 任意 |
| 7 | ALICへの利用連絡 | 15分 | 推奨 |
| 8 | 独自ドメイン設定 | 取得10分＋DNS反映数時間〜1日 | 任意 |
