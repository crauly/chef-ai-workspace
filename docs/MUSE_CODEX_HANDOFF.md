# ローカルMuse版Codexとの交互実装・相互確認

これは引き継ぎ手順。ローカルCodexのモデル/エンドポイント/鍵はユーザー設定をそのまま利用し、文書に秘密値を書かず、こちらから変更しない。ローカルのモデルとアプリが使うMuse Voice/Sparkの設定は別物である。

## 最初の再開手順

1. Notion正式管理ハーネス→Chef Project Hubで現在地/担当/未決を読む。
2. GitHubは`crauly/chef-ai-workspace`（非公開）。元のWSL作業場所は`/home/hiro/workspace/chef-ai-workspace`。
3. この文書準備時、その作業場所のmainはorigin/mainより118コミット古かった。実装前にgit statusで未保存変更を確認し、cleanならfetchとff-only更新。dirty/divergedなら変更を保護して他方と調整し、reset/stashを勝手に行わない。この文書を含むmainのSHAを確認する。
4. 文書が未マージの場合は`docs/master-price-harness-handoff`のPR/最終SHAを読み取りレビューする。mainに存在すると仮定しない。別worktree等でこの文書ブランチを参照し、他方の作業中ブランチを切り替えない。マージ後は更新したmainのSHAを確認する。
5. [ADR-009](ADR_009_INGREDIENT_PROCUREMENT_ASSISTANCE.md)→[詳細設計](INGREDIENT_PRICE_DESIGN.md)→[計画](IMPLEMENTATION_PLAN_MASTER_PRICE.md)→既存MVP/CORE_CONTRACTS/IMAGE_STORAGE_DECISIONを読む。
6. 最初はG0の契約レビューから。一度にM1〜M9を実装しない。担当するID・基準SHA・対象ファイルをNotionと引き継ぎに記録してからブランチを作る。

## 交互進行の約束

- 実装側をA、確認側をBとし、ブロックごとに交代できる。A/BはChatGPT側とローカルMuse版Codexのどちらでもよい。モデル名だけで担当を決めない。
- 同じブランチ/ファイルを同時編集しない。各ブロックは一人が実装、他方がまず読み取りレビュー。共通Gitメタデータを持つworktreeではmainの無断切替やclean/resetを行わない。
- レビュー指摘は根拠・影響・再現を記録。修正担当を一人に決め、最終SHAを再確認する。レビューはコードを見る前に推測で承認しない。
- ソース/テストはGitHub、進捗・優先度・担当・再開位置はNotion。チャットだけに重要決定を残さない。今回の準備は実装完了・本番DB移行適用の承認ではない。
- 通常のローカル修正/検証は担当ブロック内で進める。DB移行の本番適用、公開化、課金、秘密値変更、外部送信/購入は現在の明示承認を確認し、なければ具体的な結果を提示して判断を求める。
- ローカルファイルの未コミット変更を、もう一方が利用できる前提にしない。受け渡しはcommit/PR/SHAを単位にする。ユーザーが明示的に渡すまで新しいCodexチャットや自律エージェントは起動しない。

## 最初にローカルCodexへ渡す依頼文

> Chef AI WorkspaceのG0（実装前契約レビュー）を担当してください。まずNotionの管理ハーネスとProject Hub、次にmainのADR-009、INGREDIENT_PRICE_DESIGN、IMPLEMENTATION_PLAN_MASTER_PRICE、既存のMVP/CORE_CONTRACTS/IMAGE_STORAGE_DECISIONを読んでください。食材登録・再利用・紐付けは承認済み要件です。仕入先・価格変動・ベル通知・出典付き代替候補を製品中核として扱ってください。G0の未決事項について、現ソースとのギャップ、推奨する型/API/保存・移行境界、判断が必要な点を具体化してください。今回はコード・DB・課金・秘密値を変更せず、レビュー結果と対象SHAを返してください。既存Human Gate・所有者分離・べき等性・過去版不変を維持してください。

## 実装ブロックを渡すときの依頼書

```text
担当ID / 実装者 / 相互確認者:
基準main SHA / ブランチ / 対象ファイル:
合意済み契約 / 前提 / 依存ブロックの証拠:
今回の変更 / 今回触らない範囲:
満たす受入ID / 実行する検証:
DB適用・配備等の承認範囲:
返却物: PR、最終SHA、差分の意図、検証、残課題、次の再開位置
```

## 確認側への依頼書

```text
対象ID / PR / 最終SHA:
設計と要件の対応、未実装・暗黙のスコープ削減を確認。
所有者、価格出典、単位/規格、原子性/再送、旧データ、保存承認、過去版不変を確認。
実API/実DBの証拠とfixtureを区別し、失敗・未決を完了にしない。
まず読み取りレビュー。修正する場合は担当を確認してから。
返却: 重要度付き指摘・根拠・再現、または確認範囲付きの指摘なし。
```
