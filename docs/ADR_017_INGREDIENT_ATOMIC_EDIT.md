# ADR-017: 食材編集と価格採用を一つの承認保存にする

日付：2026-11-05。状態：実装、ローカル検証。レビュー・本番適用は別途。

## 背景

食材編集の保存と価格採用が異なるHTTP要求だったため、名称だけ更新される部分保存と、価格採用の一律エラーが発生していた。PR #139の音声レシピ経路は変更しない。

## 決定

- 編集画面は保存ボタン一つとする。価格・数量・単位・仕入先が変わった場合だけ、全変更の確認画面で「承認して保存」を要求する。価格比較は保持する。
- `PUT /api/ingredients/{id}` → `PUT /demo/ingredients/{id}` → `save_owned_ingredient_edit` の一要求で保存する。ownerは認証コンテキスト由来。クライアントのowner指定は受け付けない。
- 新RPCは既存 `save_owned_research_ingredient` と `set_owned_offer_price` を同一PostgreSQLトランザクションで呼ぶ。単位・仕入先検証、明示承認、採用ポインタ、価格履歴、現在原価の既存規則を維持する。
- 単位は既存 `/api/units` から取得し、未登録の場合は既存の単位管理へ誘導する。単位推測・規格からの換算は追加しない。
- 価格なしの食材も保存できる。価格・数量・単位の一部入力は拒否する。空欄で既存価格を削除する操作は提供しない。0円は明示入力のみ受け付ける。
- 同じ採用価格・同じ購入条件なら価格履歴を追加しない。単なる名称・規格・定期調査ON/OFFの変更は価格採用を行わない。
- owner内の要求UUIDと入力・結果を `ingredient_edit_receipts` に保存する。同一内容の再送は保存結果を返し、異なる内容の同一UUIDは409。失敗時はreceiptを含めロールバックし、画面は入力とUUIDを保持する。
- `ingredients.selected_offer_id` は編集画面で選んだ購入条件を再表示するための参照。owner/食材一致をトリガで検証する。価格なしの仕入先選択も価格観測なしのOfferとして保持する。レシピの購入条件は変更しない。
- 既存レシピの原価は引き続き各材料のOffer採用ポインタを使う。同じ仕入先・数量・単位の価格更新のみ現在原価へ反映し、別の仕入条件・保存版スナップショットには干渉しない。共有価格は既存の相場参考価格経路だけが更新する。
- RPC・receiptはservice_roleのみ利用可。内部例外は公開せず、固定エラーコードから日本語・英語の案内へ変換する。

## 保存契約

```json
{
  "request_id": "UUID",
  "name": "乾燥パスタ",
  "spec": "500g袋",
  "price_research_enabled": true,
  "supplier_id": "UUID or null",
  "purchase": {"amount_jpy": "400", "quantity": "500", "unit": "g"},
  "price_confirmed": true
}
```

価格を変更しない場合は `purchase: null`、`price_confirmed: false` とする。仕入先も変更しない場合の `supplier_id: null` は既存の選択を保持する。purchaseを伴うnull仕入先は既存の相場参考仕入先に対応する。従来のrequest_idなしメタデータ更新は互換性のため維持し、価格採用には使用しない。

安全なエラー：`unit_unknown`、`supplier_unavailable`、`ingredient_conflict`、`invalid_price`、`invalid_input`、`ingredient_unavailable`、`request_conflict`、`price_confirmation_required`、`api_unavailable`、`database_error`。不明なDB例外は503のdatabase_errorとし、SQL・内部メッセージを返さない。

## 移行と検証

正規移行は `supabase/migrations/20261104161436_ingredient_atomic_edit.sql`。既存データや価格観測を変更・削除せず、選択参照とreceipt、RPCを追加する。旧行の選択参照はnull。画面ではその場合のみ既存の採用済み価格から初期表示を選ぶ。未採用の最新観測は選ばない。

レビュー・マージは本番への移行適用・デプロイを意味しない。本PRでは本番DBへ適用しない。リリース時はDB移行をアプリ更新に先行させる。

使い捨てローカルPostgreSQLにbootstrapと全移行を順に適用後：

```bash
CHEF_TEST_PGPORT=55447 .venv/bin/python -m unittest discover -s tests -p 'test_ingredient_edit_postgres.py' -v
cd web
CHEF_TEST_PGPORT=55447 npx playwright test --config playwright.ingredient-pg.config.ts
npx playwright test tests/ingredient-unified-save.spec.ts tests/settings-responsive.spec.ts tests/scheduled-research.spec.ts tests/unit-master.spec.ts
npm run typecheck
npm run build
```

DBテストはローカル接続と固定の `chef_procurement_test` に限定する。ブラウザ実DBテストはNext・FastAPIを起動して承認前無書込み、同時保存、再表示、原価、途中失敗のロールバック、入力保持、再試行と再送を確認する。PC/390pxのモーダル・具体的エラーは画面テストで確認する。実サービス・本番DBでの操作検証は含めない。

## 2026-11-05 検証結果

- Python全体：521件実行、44件スキップ、失敗なし。ローカル実DBは別実行で33件＋11 subtests成功（食材編集11件、既存の仕入・定期調査を含む）。
- ブラウザ実DB：1操作シナリオ成功。名称/規格/価格/定期調査の同時保存、承認前無書込み、再表示、原価80円/別仕入先120円、メタデータのみの保存、DB障害のロールバック、保持入力から再試行、同一UUID再送を確認。
- 関連Playwright：22件成功。1280px/390px、価格なし、単位・数量エラー、API/DB/仕入先/競合エラーの入力保持、単位管理・定期調査を含む。
- Node：46件成功、1件スキップ。型チェック、本番ビルド、差分チェック成功。
- 新規の使い捨てPostgreSQLにも全移行を適用し、既存の価格数量識別・旧データ移行SQL検証を通過。

| 必須操作 | 証拠 |
| --- | --- |
| 1 名前・規格のみ | 実DB API＋ブラウザ実DBで履歴不変 |
| 2 仕入条件・価格変更 | 実DB APIで別仕入先・2ケース、画面PC/スマホ |
| 3 名前と価格を同時変更 | ブラウザ実DBで確認→承認→再読込 |
| 4 価格なし | 実DB APIと画面で価格観測なし |
| 5 不明単位 | 実DB API422/unit_unknown、画面で登録案内 |
| 6 無効仕入先 | 実DB APIで未存在・別ownerを拒否 |
| 7 部分更新防止 | 価格観測INSERTの故障注入、実DB API＋ブラウザ実DB |
| 8 再送 | 実DB API＋ブラウザ実DBで同一要求・観測数不変 |
| 9 一覧・再表示 | ブラウザ実DBとPC/スマホ画面で再読込 |
| 10 原価・別仕入先非干渉 | 実DBで同条件のみ更新、別仕入先・保存版不変 |
| 11 定期調査ON/OFF | 実DB API＋ブラウザ実DBで再表示 |
| 12 PC/スマホ | 1280px/390pxで確認画面・保存・再表示・横幅検証 |

既存PostgreSQLテスト1件の期待ステータスは、PR #139で既に導入された矛盾価格の保存前検証（422）に合わせて更新した。音声処理の実装は変更していない。

## PR #140 レビュー対応：応答消失後の再編集

価格保存がコミット済みでも応答だけ失われると、画面の旧基準値へ戻す編集を「価格変更なし」と判定してしまう。通信・5xxエラー後に入力を変える場合は、直前に承認済みの保存を同じUUIDで再照合し、その結果を確定させてから一覧APIでDBの採用済み条件を読み直す。GETだけでは処理中の旧要求と競合するため、既存のトランザクション/receipt経由の再送を先に行う。

更新した基準と編集中の入力を比較し、価格・仕入先を元へ戻す操作も必要に応じて新しい確認・承認保存にする。入力を上書きしない。前の要求の結果や再読込を確認できない場合は新要求を送らず、同じIDでの再照合を継続する。入力が同じ場合の再試行は従来どおり同じ保存IDを使用する。

回帰検証は応答消失後の価格差し戻し、仕入先差し戻し、照合中の障害による新要求阻止を含む。実DBブラウザでは、価格保存成功後に応答のみ遮断し、同一UUIDの照合では観測を増やさず、元価格への明示承認で新しい観測が一件だけ作られ、再表示されることを確認する。

レビュー修正後の再検証：関連画面19件、ブラウザ→実PostgreSQL 2件、型チェック・本番ビルド・差分チェック成功。DBの保存契約とマイグレーションは変更していない。
