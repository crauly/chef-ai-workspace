# 音声下書きの早期表示と共通処理状態

## 契約と表示順

ADR-007/008/010/011、PR #130の承認・Supplier/Offer・原価の保存経路は維持する。
RESTは確定した文字起こし、Realtimeは `speechComplete` だけを既存キューへ渡す。
Realtimeの `transcript` は `final:true` でも表示専用であり、材料・保存指示へ変換しない。
認識した発話はキューへ入る時点で表示する。以前はルーティング待ちが終わってから表示していた。

Museの構造化処理は引き続き `defer_prices:true`。完全な応答を既存の
`parseRecipeDraft` で検証し、最新結果を下書きへ反映してから価格検索を別の非同期処理で進める。
未承認の価格候補は既存の明示採用操作を経なければ保存材料へ入らない。

解析中に次の発話が届いた場合、先に完成した検証済みの発話範囲だけを
「続きの発話は未反映です。」とともに先行表示できる。これは部分JSONの解析ではない。
先行表示はlive draft・承認対象・価格候補の紐付けを更新しない。検証済みの範囲までは
解析カーソルと差分解析baseを進め、次の要求にはその後に届いた未解析発話だけを送る。
原文履歴は保持し、先行表示を正式な保存対象にはしない。最新結果で下書きを更新する。完成した下書きの提示時にも録音承認epochを更新し、
提示前に始まった保存発話を、ASRやキューから遅れて届いた場合でも承認に使わない。すでにbaseがある通常の差分解析も維持する。
保存ボタンは処理中無効、正式保存は最新live draftに対する既存Human Gateに限る。
破棄・別セッションの応答はepochで拒否し、先行表示にも使わない。

## APIのストリーミング

確認したMeta公式資料：

- [Chat Completions](https://dev.meta.ai/docs/protocols/chat-completions)
- [Streaming responses](https://dev.meta.ai/docs/cookbook/streaming-responses)
- [Structured output](https://dev.meta.ai/docs/structured-output)
- [Speech to text](https://dev.meta.ai/docs/speech-to-text)

Muse Spark 1.3のChat Completionsには `stream:true` のSSE契約が存在する。
一方、途中のJSON断片を正式なレシピとして確定できるという契約ではない。
今回の変更は既存の完全JSON検証を維持し、SSE化・未完了JSONの逐次材料化は追加しない。
実Metaのstreaming＋本番スキーマの組合せの実呼び出しは実施していない。
Realtimeの途中認識は、従来のCUMULATIVEテキストを置換表示する。

## 1画面1パネル

`layout.tsx` の `VoiceProcessingProvider` だけが表示用 `VoiceProcessingPanel` を描画する。
Workspace、登録、AI編集、単独音声入力、設定フォームは `useVoiceProcessingStatus` に実状態を渡す。
同種の状態は統合し、録音・解析・価格検索などは1パネル内で並行表示する。
処理終了時に該当行だけを除去し、失敗時は進行表示を停止する。再試行中は古い失敗表示より進行状態を優先する。
発行元のunmount時にも登録を解除する。非表示でも継続中の実処理は表示に残る。

- 音声受付中：実際にマイクを録音中。
- 文字起こし中：RESTの処理／待ち行列、またはRealtime途中認識／最終結果drain待ち。
- 指示を確認中：実際のintent API呼び出し中。
- レシピ解析中：Muse構造化API呼び出し中。
- 価格検索中：登録の価格enrichmentまたは編集の実価格調査API呼び出し中。
- 変更案を作成中：編集のpropose API呼び出し中。
- レシピ保存中：正式保存／confirm API呼び出し中。

写真解析・料理画像生成も既存の実フラグを同じパネルで扱う。
下書きへのReact state反映は同期処理なので、架空の待機時間を設けて「下書き更新中」は表示しない。
状態を模したタイマーや進捗率は追加しない。Realtime停止後のdrainingも実状態を返し、
最終発話を待っている間のマイク再開や画面遷移による中断を防ぐ。

スタイルはTailwindユーティリティのみ。旧 `.voice-status-list` の固定位置CSSを削除し、
スマホのsafe area・ボトムナビ上の余白、PCの右下配置、小さい画面での最大高とスクロールを定義する。

## 検証と限界

- `cd web && node --test tests/voice-status.node.cjs tests/voice-procurement.node.cjs tests/recipe-price-research.node.cjs`
- `cd web && npx tsc --noEmit && npm run build`
- `cd web && env -u MODEL_API_KEY -u CHEF_LIVE_META_BROWSER -u NEXT_PUBLIC_DEMO_WS_URL npx playwright test tests/voice-status-ux.spec.ts tests/voice-rapid-turns.spec.ts tests/voice-conversation.spec.ts tests/voice-realtime.spec.ts tests/voice-price-lifecycle.spec.ts tests/supplier-procurement.spec.ts tests/voice-unconfirmed.spec.ts tests/recipe-detail.spec.ts tests/settings-responsive.spec.ts tests/image-photo.spec.ts tests/dish-image-ui.spec.ts`
- Realtime UIのfixtureのみ：`cd web && env -u MODEL_API_KEY -u CHEF_LIVE_META_BROWSER NEXT_PUBLIC_DEMO_WS_URL=ws://localhost:3100 npx playwright test tests/voice-status-realtime.spec.ts`

最初のfixtureは1回目の解析を完了させ、2回目を明示的にブロックしたまま先行表示と保存不可を確認する。
旧コードでは2回目完了まで表示されなかった区間であり、モデル応答時間そのものを短縮したという測定ではない。
Playwright添付 `fixture-prefix-timing` に1回目応答から先行表示までの時間と、最新解析が未完了であることを残す。
診断ログの `transcript.received`、`muse.start`、`muse.ok`（往復ms）、`draft.preview`、
`draft.created/updated` で各区間を追跡できる。既存のREST `transcribe`／構造化 `muse` の
`Server-Timing` はそのまま利用できる。実音声・実機・本番Metaの所要時間比較は未実施。
fixture成功を実サービスの音声認識品質・本番レイテンシの検証とは扱わない。

定期価格調査のスケジューラと全体／食材別ON/OFF設定は後続課題であり、本変更に含めない。

## 音声登録の保存ゲート（2026-11-05: 一度の保存指示）

登録では認識結果に「保存」を含む発話を明示承認として扱い、その一回で既存の正式保存APIへ進む。
「登録」だけでは正式保存しない。事前レビューと二度目の発話を要求せず、「内容を確認」で任意の
読取専用レビューを開ける。未確定の数量・価格はNULLの組で保存し、単位分類を推測しない。
分類不明の単位に依存する組も未確定とする。料理名が空なら表示用の「無題のレシピ」で保存する。

価格検索の終了を待たず、その時点の下書きを保存する。保存開始時に検索を中断し、後着の候補を
勝手に採用しない。解析中に受け付けた保存指示は同じrevisionの解析後に処理する。
収録epochの下限は別の下書き・モードへの変更や破棄・保存完了で更新し、単なる下書き表示前の
収録を拒否する旧条件は廃止する。同一収録はutteranceId、正式保存再送は既存request_idで制御する。

owner照合、単位検証、食材同一性の競合、正式な価格採用・トランザクションはサーバーの既存契約を維持する。
食材マスターを確定できない競合を、推測による統合で解決しない。保存失敗時は原因と下書きを保持する。
IndexedDBで保存IDを保持できなければ正式POSTを行わず、busyを解除して同一IDで再試行できる。

保存後の不足表示は材料の実際のeffective_price/price_overrideを参照する。inheritでも価格がなければ
仕入単価の不足を表示する。既存の設定・音声編集で後から補う。

回帰確認は `voice-save-gate.spec.ts` の一回の音声／ボタン保存、未確定情報の再表示、
端末保存失敗と通信結果不明後の同一payload再送、解析中の保存、旧下書き音声拒否、価格調査非待機を対象とする。
外部AI・本番DBは使用しない。
