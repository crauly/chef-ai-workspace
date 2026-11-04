# ADR-016: 音声解析復旧と未採用の定期価格調査

Status: implemented, production activation pending. 2026-11-04.

## A. 音声登録

単位一覧の一時障害で解析を止めない。取得は3秒までとし、失敗時は空のcatalogで
既存Structured Output解析を継続する。保存前は引き続き単位一覧の確認と正式保存RPCによる
単位・owner検証を必須にする。取得障害の復旧ボタンを設け、下書きは保存操作と区別する。
`unit_proposals` を指示文・VOICE_RECIPE_SCHEMAに明示し、既存の厳格parserを通す。
有限数値→decimal文字列、null→未確定空欄、余白除去だけを安全に正規化する。
数値の単位・仕入先化や価格の推測はしない。修復不能なJSONは最大1回再生成する。
通信再試行と再生成は合わせて最大2試行、各25秒、関数60秒枠。利用者中断は再試行しない。
`cancelled` / `timeout` / `provider_unavailable` / `invalid_response` を区別する。
解析は読み取りだけであり、再試行で正式保存を増やさない。既存epoch・revisionを維持する。

未処理発話と解析済みcursorをIndexedDBに保持する。復元後、未処理発話があれば承認を
無効化し、明示再試行へ進める。30発話を超える初回解析は古い発話を捨てず順序通りまとめる。
既存の入力サイズ上限は維持する。モード破棄中にローカル保存が完了しても解析を再開しない。

本番の `stage=request` は原因を特定できる詳細を含まない。単位503による停止はローカルで
再現・修正確認済み。実機・デプロイ後の本番例外解消は別途確認する。

## B. 調査と採用の分離

全体設定はowner内の `price_research_settings`。食材は既存 `ingredients` の属性
`price_research_enabled` とし、いずれも初期OFF。対象は `全体ON && 食材ON` のみ。
間隔は設定可能な1～8760時間、UI初期値24時間であり固定の運用間隔ではない。
レシピごとの設定は追加しない。

[Supabase Cron](https://supabase.com/docs/guides/cron) と
[pg_net](https://supabase.com/docs/guides/database/extensions/pg_net) を使い、5分ごとに
保護された `/api/cron/price-research` を起動する。Vercelの
[Hobby Cronの1日1回制限](https://vercel.com/docs/cron-jobs/usage-and-pricing)へ依存しない。
専用DBでpg_cron/pg_netが利用可能、Vaultはインストール済みであることを読取確認した。
現在のVercelプランはツール結果に含まれないため推測しない。

1起動で期限到来した最大3食材をDBからclaimし、5分leaseと世代番号で並行起動・
古い結果を制御する。dueの古い順で後続tickが残りを処理するため、件数が多い場合は
指定間隔より遅れることがある。各食材の失敗は独立して記録し、次回間隔で再試行する。
途中のプロセス終了はlease期限後に再取得する。OFF後の遅延結果は記録しない。

台帳の採用価格は比較基準に使い、新しい市場調査結果として再ラベルしない。
外部調査は既存Meta Search Groundingを再利用し、品名・メーカー・規格を入力する。
実web_searchと候補自身のHTTPS URL、JPY金額・数量・既知単位がある生の販売条件だけを記録。
平均値を特定店舗の販売価格にしたり、未取得をゼロにしたりしない。
取得失敗、単位未登録、根拠不足は候補なしとする。

新しい価格マスターは作らず、既存の相場参考価格Supplier / Offer / PriceObservationを使う。
調査観測は `web_reference / confirmed=false`、run ID一意、出典・日時・条件・採用基準を保持。
記録処理は採用pointerやcurrent_priceを変更しない。通知ベルから未採用候補画面へ案内する。
履歴は残し、候補画面は食材ごとの最新世代だけを表示する。

明示確認後、同じowner・OfferとIngredientの採用基準・調査世代をCASで検証する。
既存 `set_owned_offer_price` を呼んで正式価格を採用し、承認観測の
`approved_from_observation_id` で元の調査観測へ結ぶ。採用観測はmanual_entryであり、
実際の仕入れを意味するpurchaseとは区別する。再送は同じ承認観測を返し再採用しない。
税・送料は元の観測と承認観測の両方へ保持する。

原価は既存の採用ルールに従う。同じOfferを参照するレシピ、および共通価格の継承行へ
反映する。別のSupplierや別購入条件のOfferを暗黙に切り替えない。
比較画面はパッケージ数量・単位・税・送料をそのまま示し、無条件の高安比較はしない。

## 移行・有効化・運用

1. 専用Chef DBへ `20261104125225_scheduled_price_research.sql` を適用する。
   既存採用価格・NULL運用・レシピstateは書き換えない。
2. フロントエンドのproduction環境に32文字以上の `CRON_SECRET` を設定し、コードをデプロイ。
3. Supabase Vaultに `chef_research_endpoint`（productionのHTTPS URL＋上記APIパス）と
   `chef_research_bearer`（CRON_SECRETと同じ値）を登録する。値はリポジトリへ記載しない。
4. Vercel Deployment Protectionがある場合、Vaultへ `chef_research_vercel_bypass` も登録。
   [公式Automation Bypass](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)
   の `x-vercel-protection-bypass` headerを付ける。アプリのbearer検証は引き続き必須。
5. DB管理者として `scripts/install_price_research_schedule.sql` を実行。
   同名jobは置換するため二重登録しない。必要なpg_cron/pg_netを有効化する。
6. `cron.job`、`cron.job_run_details`、`net._http_response` で起動とHTTP成功を確認。
   全体と対象食材を明示ONにして候補の到着・未採用原価・明示採用後の原価を確認する。

全体OFFで価格検索を停止できる。ジョブ自体の停止は
`select cron.unschedule(jobid) from cron.job where jobname='chef-price-research';`。
コードを戻す際も列と履歴は削除しない。自動の逆マイグレーションは用意しない。

本作業ではproductionのSQL適用・secret設定・Cron登録・デプロイを実施していない。
これらを完了し実行ログを確認するまで本番稼働とは扱わない。

## 検証

- `cd web && node --test tests/voice-recovery.node.cjs tests/scheduled-research.node.cjs`
- `cd web && npm run typecheck && npm run build`
- `cd web && env -u MODEL_API_KEY -u CHEF_LIVE_META_BROWSER -u NEXT_PUBLIC_DEMO_WS_URL npx playwright test tests/voice-recovery.spec.ts tests/scheduled-research.spec.ts tests/voice-rapid-turns.spec.ts tests/unit-master.spec.ts tests/settings-responsive.spec.ts tests/supplier-procurement.spec.ts`
- `.venv/bin/python -m unittest discover -s tests -q`
- 全マイグレーション適用済みの使い捨てローカルDBで
  `CHEF_TEST_PGPORT=55441 .venv/bin/python -m unittest discover -s tests -p test_scheduled_research_postgres.py -v`

ローカルSQL/API統合でON/OFF全組合せ、並列claim、lease失効、部分失敗、owner境界、
未承認の原価不変、採用再送、古い世代の拒否、2レシピ70→80円と別仕入先の原価不変を検証。
fixtureを本番検索・実マイク・本番Cronの成功とは扱わない。

最終検証: Node11件、Python506件（33件skip）、ローカルDB統合9件、
全23 migrationの新規DB適用、関連Playwright17件＋19件＋3件（重複あり、390/1280px含む）、型チェック・build成功。
単位503を模擬し実Museへ1回送った隔離確認ではHTTP200、5367msで
パスタ100g・Amazon・500g350円の下書きを取得した。DB更新なし。
これは実マイク・production経路の検証ではない。本番ログ取得はAPI403、
CLIもscope権限エラーとなり、今回のproduction例外そのものは追跡できていない。

実GroundingもDBを使わない隔離workerで1食材確認し、15277msで
出典URLと1kg/126円の販売条件を持つ未採用候補を取得した。
finishはテスト内のメモリ受け口であり、実DB保存・Cron起動の成功とは扱わない。
