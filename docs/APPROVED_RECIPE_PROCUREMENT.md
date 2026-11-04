# 承認済みレシピの仕入先・価格保存

## 保存契約

`POST /api/recipes/full` → `POST /demo/recipes/full` の材料に任意の
`supplier: string | null`（最大200文字）を追加する。owner IDはクライアントから受け付けない。
価格は `price_jpy / price_quantity / price_unit` がそろった場合のみ送信し、
不完全な下書き価格は従来通り3項目ともnullとする。価格0は明示入力時のみ有効である。

下書きへの入力・検索・確認表示は保存ではない。ユーザーの明示保存操作で初めて
`create_owned_procured_recipe` を呼び、以下を同一トランザクションで処理する。

1. ownerと作成ID／内容ハッシュを照合する。
2. 既存の単位・食材登録RPCで参照を確定する。
3. 仕入先名をowner内で一意照合し、承認された未登録先だけ登録する。
4. 有効な入力価格を既存Offer採用RPCに渡し、採用済み購入条件のIDを材料へ保存する。
5. 採用価格・単位マスターに基づく原価と初版スナップショットを確定する。

同じID・同じ内容の再送は価格観測を増やさない。異なる内容、曖昧な仕入先／購入条件、
同一購入条件の矛盾した価格は409となり、途中作成したマスターも含め全体をロールバックする。
採用価格がない場合の保存は可能で、原価はpartialとなる。

`GET /demo/recipes/{id}` はowner内の保存済み名 `supplier_name` と採用価格
`effective_price` を返す。`GET /demo/recipes/{id}/cost` と詳細行は同じOffer採用価格を使う。
仕入先指定がある材料は、別仕入先・共有価格・未採用の最新観測に代用しない。
Amazon 500g 350円、レシピ使用量100gなら材料原価70円となる。

## 相場参考価格と移行

追加SQLは `supabase/migrations/20261104090755_approved_recipe_procurement.sql`。
先行マイグレーションを順に適用済みであることが前提。既存ファイルは書き換えない。
`suppliers.is_market_reference` と `recipes.creation_payload_hash` を追加する。
新テーブルは追加しない。新RPCはservice_roleのみ実行可能で、既存owner境界を維持する。

「相場参考価格」は曖昧なWeb検索・平均価格の紐付け先であり、owner内で一意の実Supplierである。
仕入先省略時もそのIDを使う。既存の同名行が一意なら再利用する。
owner作成後の初回仕入先一覧取得または承認保存でも冪等に用意する。
既定行の改名・削除は禁止する（owner自体の削除は既存cascadeに従う）。
これは検索結果の取得・出典保存や自動採用を追加する変更ではない。
Web取得した未承認価格は従来の調査／提案経路に残す。

適用前にChef専用DBで以下の読取クエリを実行する。重複を勝手に統合・削除しない。
同名の相場参考価格が複数なら移行はトランザクション全体を拒否する。
他の重複先も該当名による新規レシピ保存は409となるため、実データに基づく確認が必要である。

```sql
select owner_id, lower(btrim(name)) as supplier_name, count(*), array_agg(id)
from public.suppliers
 group by owner_id, lower(btrim(name)) having count(*) > 1;

select owner_id, ingredient_id, count(*)
from public.offers where supplier_id is null group by owner_id, ingredient_id;
```

旧NULLのOfferは既存ID・観測を維持して抽象仕入先へ移す。購入条件の統合や価格採用は行わない。
既存のNULL材料state・保存版は変更しない。旧NULL材料の価格は引き続き共有価格を使い、
相場参考価格の明示採用時には共有価格も更新する。実仕入先採用では共有価格を更新しない。
既存の重複Offerは曖昧なまま残し、自動的に1件を選ばない。

リリースはSQL→バックエンド→Webの順で行う。新コードはSQL未適用DBでは動作しない。
コードだけ戻す場合も追加列／RPCを残し、データを破壊する逆SQLは実行しない。
この作業では本番SQL適用・デプロイは実施していない。

## 回帰確認

- `python -m unittest discover -s tests -q`
- 全マイグレーションを適用した使い捨てPostgreSQLで
  `CHEF_TEST_PGPORT=<local_port> python -m unittest discover -s tests -p test_procurement_postgres.py -v`
  （接続先はローカルの `chef_procurement_test` のみ）。手動CIのpostgres-smokeでも実行する。
- 移行前後の `tests/sql/procurement_legacy_before.sql` / `procurement_legacy_after.sql` と既存の
  `offer_quantity_identity.sql` でNULL互換・ID維持・権限・数量識別を確認する。実DBにはテストfixtureを入れない。
- `cd web && node --test tests/voice-procurement.node.cjs && npx tsc --noEmit && npm run build`
- `cd web && env -u MODEL_API_KEY -u CHEF_LIVE_META_BROWSER -u NEXT_PUBLIC_DEMO_WS_URL npx playwright test tests/supplier-procurement.spec.ts tests/voice-unconfirmed.spec.ts tests/voice-full.spec.ts tests/recipe-detail.spec.ts tests/settings-responsive.spec.ts`

ブラウザテストは音声認識・HTTPをfixture化する。PostgreSQLテストはAPIと実SQLを結ぶ
ローカルテスト用transportを使い、実Supabase REST、実機マイク、実モデル／Web検索を呼ばない。
実Supabaseでの移行・承認保存・再読込・仕入先管理・原価の通し確認は未実施である。
