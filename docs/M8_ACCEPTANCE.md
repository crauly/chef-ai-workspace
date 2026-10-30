# M8 実DB総合受入テスト（A1〜A8）記録

- 基準: PR #59 マージ後の main `8698067`
- 実施日: 2026-10-30。記録のみの受入であり、コード・スキーマ変更はない。
- 原則: fixture成功を実DB成功として扱わない。実DB実行／未実施を区分する。

## 実DB検証の前提（【2】の結果）

- `SUPABASE_URL` は本番ref `dfvryaybdelgjxihdmth` を指す。到達性は読取専用で確認
  （行読込なしの到達確認＋ `ingredients` 件数照会のみ。書込・DDLなし）。
- 本番 `ingredients` 件数は **0**。既存データを破壊する恐れのある検証は実施しない。
- 使い捨て検証DBの条件（`SUPABASE_TEST_URL`＋`SUPABASE_TEST_SERVICE_KEY`＋
  `SUPABASE_TEST_ALLOW_WRITE=1`、本番ref拒否）は未設定。
  → `DisposableDbVerificationTests` 5件は SKIP のまま。実DB検証は未実施。
- 適用済みmigrationの版は PostgREST 経由で照会不可
  （`supabase_migrations` スキーマ非公開）。適用状況は未確認。
  リポジトリ内の migration 0001〜0004 の存在・順序・SQL形状は
  `test_migration_chain_guardrails`（接続不要の静的検証）で合格。

## A1〜A8 合否

| 項目 | 判定 | 根拠（実装／fixture検証） | 実DB |
|---|---|---|---|
| A1 一体保存・再読込 | 合格（fixture） | `save_recipe_with_ledger`。`test_recipe_ledger_save`（同時保存・再読込・再送再生・版競合）＋ ephemeral 層の原子性 | 未実施 |
| A2 既存食材ID再利用 | 合格（fixture） | `test_recipe_ledger_save.test_reuse_existing_id_writes_no_duplicate`、`test_m4_voice_ledger.test_reuse_past_recipe_ingredient`、assist の単一完全一致再利用 | 未実施 |
| A3 別仕入先・非統合 | 合格（fixture） | `test_ingredient_assist.test_same_name_products_stay_separate`、M7 三分類・`test_comparable_fall_across_suppliers` | 未実施 |
| A4 訂正・断片・未確定保存 | 合格（fixture） | `test_correction_memory`（確定文脈のみ・無効却下）、`test_voice_full_recipe`（部分原価・ゼロ埋め拒否・不明項目却下）、M4 未確定保存経路 | 未実施 |
| A5 価格比較・通知・原価影響 | 合格（fixture） | `test_price_history` 12件、`test_price_notifications`（履歴不変・再送スナップショット・CAS） | 未実施 |
| A6 Web候補（約3件・出典付） | 条件付（fixture合格／実取得未実施） | `test_substitute_sourcing` 17件（分類・不足明示・provider未利用明示・読取専用）。正式定義の「Web調査」実取得は手段未確定のため未実施 | 未実施 |
| A7 失敗・再送・競合・所有者分離 | 合格（fixture）／実DB分は未実施 | `test_supabase_conflicts`、再送・同時実行・A-B分離の fixture 群、`test_human_gate_guardrails`、ephemeral 層。実DB 5件は SKIP | 未実施 |
| A8 実音声→実Muse→専用DB | 未実施 | 実音声入力・実モデル・専用DB・報告済み実会話が必要で当環境では実行不可。`test_meta_live` 1件も SKIP（オプトイン実推論なし） | 未実施 |

## 設計・品質検査（【4】）

- Human Gate: `test_human_gate_guardrails`、`test_confirmation_semantics`（旧経路の台帳書込なし・確定フラグのサーバ literal）合格。
- SSOT・責務分離: 取得は `SupabasePersistence` 集約、比較は M5 再利用、分類は純粋関数。重複実装なし。
- N+1: M7 一括取得（カウンタで回帰検証）、M5 全件走査（上限撤廃済み）。
- 入力検証: 未知項目・単位・不正数値の DB 書込前却下（voice_full_recipe 群）。
- デプロイガード: `test_deploy_project_guard` 合格（誤ホストでは失敗閉鎖）。
- 不足回帰テストの追加は不要と判断（既存 suite が A1〜A7 の fixture 層を網羅）。

## 完了条件の照合（【5】）

- Python 全 suite: **289件 OK、6 skipped**（内訳: 実DB 5＋実推論 1）。
- TypeScript 型検査: 通過。Web ビルド: 成功（17ページ）。
- 実DB実行済み: なし（読取専用の到達・件数確認のみ）。未実施: A6実取得・A7実DB5件・A8・migration適用確認。
- 残課題・M9 引継ぎ: (1) 使い捨て検証DBの用意（TEST_URL/KEY/ALLOW_WRITE）と適用確認、(2) Web取得手段の G0 決定、(3) A8 実会話の準備、(4) 本記録と Notion の照合（MCP 復旧後）。
