# ADR-008: One continuous voice workspace

Status: accepted, 2026-10-29. Extends [ADR-007](ADR_007_MUSE_VOICE_INPUT_BOUNDARY.md).

## Problem and decision

Navigation, registration and recipe editing had separate microphone controls.
Navigation could label the screen “create” without feeding the spoken recipe
into registration. This violated the intended continuous kitchen conversation:
one microphone, contextual work and audible awareness of mode changes.

`VoiceWorkspace` owns the single continuous Web Audio capture and one fallback
text input. It routes ordered transcripts to the existing registration parser,
owner-scoped retrieval or selected recipe's proposal/confirm workflow. It does
not replace the backend mutation engine or calculate costs through a model.

- “レシピを登録します” / “新しいメニュー” enters registration. Direct
  recipe dictation also enters registration. Subsequent ingredients and
  corrections stay there; they do not rerun navigation inference.
- “ペペロンチーノを見せて” searches by name. A unique result opens;
  multiple results require choosing a target. Nothing is edited by retrieval.
- A change request while viewing a recipe enters editing and proposes a diff.
  An explicitly named editing target is retrieved before entering editing.
  Thanks, reference questions and negated changes do not automatically enter
  editing. Ambiguous edit phrasing is classified before switching modes.
- Common whole navigation requests use deterministic matching. Navigation
  paraphrases use the existing Muse intent endpoint, with low reasoning.
  Unclear/negative navigation retains the current work and requests clarification.
  The model cannot approve, save, delete or discard anything.
- Switching away from registration retains the draft and invalidates its review.
  Returning resumes it. Unapproved editing work blocks navigation until saved
  or explicitly discarded. New speech cannot silently discard work.

## Audible state and capture

The existing three original Web Audio motifs identify registration, reference
and editing. Play one motif only when the actual mode changes; ordinary
ingredient turns and same-mode navigation do not repeat it. Error cues remain
separate. Current mode, target and processing state are visible; cue volume and
mute remain available. Button navigation is an alternative to speaking.

The microphone stays open across navigation, saving and the next recipe. Stop,
permission failure, disconnection, navigation away and bounded-network overflow
still release capture through the existing hook. This is continuous capture
with batch WAV requests, not realtime transcription. Pause about one second
between utterances and allow the transition cue before the next request.

Do not discard microphone frames while playing a cue: a real integration trial
showed that suppressing audio at navigation time could erase the next spoken
dish name. Browser echo cancellation remains enabled; acoustic speaker/microphone
feedback is not established by synthetic input tests. No TTS layer was added.

## Human confirmation

Registration uses an explicit save request → `/recipes/full`; read-only review is optional (2026-11-05 amendment below).
Editing retains proposed diff → explicit human approval → the existing
`/recipes/{id}/confirm` contract, revision checks and stable retry request ID.
Manual editing retains its checkbox/button. A later standalone voice save can
approve the exact displayed current proposal through the same confirm operation.

Capture-thread review epochs apply to both workflows. Audio recorded before a
proposal/review or an earlier mode cannot approve new work, even when ASR arrives
late. Queued typed requests also carry their arrival epoch. New correction data
invalidates approval; successive unsaved edit instructions are passed together
to the model, preserving self-corrections. Model output never supplies consent.

## Follow-up: registration priority and recoverable capture pauses

User testing reported capture stopping without an audible explanation and
registration requests not reaching saving. The screenshot did not contain the
upper capture diagnostic, so the exact stop reason in that session is unknown.
Two reproducible paths were corrected:

- In an active create/edit task, an explicit human review/save/hold/cancel is
  routed to that task before navigation matching. In particular,
  “レシピを登録してください” previously matched create navigation and could
  never reach the review. Registration now treats any transcript containing
  “保存” as a save request (literal substring, including negations); “登録” alone
  opens review and never authorizes saving. Only a fresh request tied to the
  displayed review can approve it; a request before review cannot approve
  future content. Edit consent keeps its separate command rules.
- Previously the fourth short speech batch aborted all outstanding ASR work.
  When two requests are pending, capture now coalesces short fragments until
  capacity returns or the 29-second WAV bound is reached. A third accepted full
  batch pauses capture and drains the accepted audio instead of aborting it.
  Memory/request limits remain bounded. Resuming stays disabled until draining
  finishes; the same draft and review epoch remain available afterward.

An actual recording→stopped transition plays one descending stop cue (or the
error cue on failure), honoring mute/volume. Capture state, pause reason and
resume controls are explicit at the main microphone; the draft also repeats
capture status and links back to the shared controls. This is a shared capture,
not another microphone. No sound is emitted for an ordinary silence delimiter.

On one ASR failure, capture stops and flushes its current partial speech while
other queued batches finish. The failed segment is reported explicitly and may
need repeating; an ASR failure is not represented as recovered speech. Cancel,
leaving the page or deliberately replacing capture still aborts pending work.

Regression tests use real WAV encoding and controlled worklet frames with a
delayed ASR fixture to verify coalescing, all three bounded batches draining,
one stop cue, draft retention/resume, and later batches surviving an earlier
failed request. They are not new live-provider, physical-audio or database
accuracy evidence.

## Follow-up: continuous capture (2026-10-31, supersedes the pause/stop rules above)

User task (voice UX overhaul) reported three defects in the rules above:
transcription failure stopped recording, three pending transcriptions paused
capture until a manual resume, and a real device saw `POST
/api/voice/transcribe` 502 without an attributable cause. The following
replaces the "third batch pauses" and "one ASR failure stops capture" rules;
all other rules (review epochs, approval gating, Human Gate, draft retention)
are unchanged.

- A transcription failure no longer stops capture. The microphone stays open,
  the draft is kept, and the failure is announced visually plus one error cue.
  Only the failed fragment needs repeating. A flush after an explicit user
  stop keeps a distinct "stopped" message so a completed stop is never
  reported as still listening.
- The third-batch pause and manual resume are replaced by a bounded backlog
  (60 seconds of audio, oldest spilling first with a diagnostic event).
  Buffered utterances transcribe automatically as slots free; the notice shows
  the buffered count and clears on drain. No stop cue plays for buffering.
- The recording→stopped cue rule is refined: the transition plays the stop
  cue, or the error cue on failure, unless the same error was already
  announced while recording (no double cue). Mute/volume still honored.
- `/api/voice/transcribe` returns attributable codes without leaking provider
  detail: `provider_timeout` (504) for provider timeouts, `provider_unavailable`
  / `invalid_response` (502) for upstream/invalid payloads, plus the existing
  validation codes. Transcription failures are classified at the transport
  (`timeout` / `upstream` / `invalid`) instead of one generic throw.
- The 1-second silence split, 29-second bound, single microphone, and
  coalescing while two requests are pending are retained.

## Verification

See `web/tests/unified-voice.spec.ts` for one actual AudioWorklet session through
registration, review/save, retrieval and edit/save, with exactly one microphone
open and the expected three transition motifs. It also covers draft preservation,
pending-edit protection and approval queued before proposal display. Existing
registration/retrieval/manual approval/error/retry tests remain in the suite.

The opt-in complaint test now plays six Japanese synthetic WAV fixtures (`dish`,
`recipe`, `review`, `save`, `browse`, `edit`) through a single microphone session
and actual Voice/Spark APIs, with a fresh dedicated database owner and verified
cleanup. Test results and their limits are recorded in the acceptance document.

## Addendum (PR #69 review): save boundary, FIFO backlog, absolute turns

- Spoken purchase sources (`supplier`) are draft/review-only facts. Recipe
  lines have no supplier column and `CompleteRecipeMaterial` forbids extras,
  so every save mode projects materials through the save boundary (unknown
  prices nulled, supplier omitted) instead of failing 422. The review still
  shows the supplier and the save message hands it back as a memo.
- Formal supplier linkage reuses the existing ledger path, never an automatic
  write: `POST /recipes/{id}/ingredient-assist` links a material to an
  ingredient, `POST /offers/{id}/observations` records a purchase price, and
  `POST /observations/{id}/confirm` adopts it behind the Human Gate
  (owner-scoped, CAS, idempotent). Persisting supplier text onto recipe lines
  would need a new migration plus a `CompleteRecipeMaterial` field and is
  recorded as follow-up, not implemented here.
- Accepted-audio ordering is strict FIFO (`web/app/voice-backlog.ts`, the
  single queue implementation): new batches queue behind buffered audio, slots
  refill in capture order, and a user stop flushes accepted audio in order
  without an unbounded synchronous burst. Capacity is 60 buffered seconds
  measured at each batch's own sample rate. Unit tests live in
  `web/tests/voice-backlog.spec.ts`.
- Parse history is absolute: the turn cursor indexes the uncapped history so
  incremental parsing (`{turns: fresh, previous: draft}`) stays active past
  30 turns; only the on-screen transcript is capped. Covered by the
  thirty-turn test in `web/tests/voice-unconfirmed.spec.ts`.
- Body-read stalls keep the `timeout` classification and mid-body network
  breaks stay `upstream` (`readBody` budget in `voice-transcription.ts`).
- Audible failure cues are keyed by failure event (per-hook tick), so repeated
  identical messages each announce once, with no double cue on stop.

## 2026-11-04 音声UX補足

認識結果をキュー投入時から表示し、検証済みの先行発話分を保存不可のプレビューとして表示する。
latest draft／解析カーソル／価格bindingは最新解析完了時にのみ更新する。
状態表示はルートの単一パネルに統合する。承認・キュー・モード境界は変更しない。
[実装・検証契約](VOICE_UX_PIPELINE.md)を参照。

## 2026-11-04 編集対象の選択導線

ホームで編集モードを選び、対象未選択なら参照状態で検索・選択を待つ。
ライブラリから選んだレシピは `/recipes/{id}` に移動し、`voiceEdit=1` の
一回限りの遷移ヒントで詳細画面の音声編集モードを開始する。音声で名前を
指定した場合も同じ導線を使い、複数候補は選択後に編集を開始する。
詳細画面に表示済みのレシピなら編集ボタンで直接開始できる。対象とモードを
確認してから変更を話し、AI提案・明示承認・既存confirm経路を維持する。

## 音声編集の確認モーダル

編集指示から検証済み変更案を生成すると確認モーダルを自動表示する。
数量・価格・名称は前後の差分、追加は強調した項目と更新後構成、削除は対象名を示す。
これは表示専用の投影であり、原価計算・正式保存は既存のAPIを使う。
モーダル内のマイク操作もWorkspaceの同じcaptureを使い、二重に録音しない。
編集モードだけ「承認」「更新して」を既存の保存要求として扱う。否定・混在する
変更指示は承認に使わず、登録モードの語彙は変更しない。モーダル提示時に録音epochを
更新し、提示前の承認音声を拒否する。閉じる操作は保存も破棄もせず承認を解除する。
版競合・所有者認可・同一request IDによる保存再送の既存契約を維持する。

## 2026-11-05 登録の確認ゲート

登録モードの最初の保存指示は、読取専用の食材・単位・仕入先照合と登録内容の提示に使う。その後の明示保存指示または承認ボタンで、既存の原子的保存へ進む。確認画面を経ず一指示で保存する旧経路は置き換える。録音epochによる古い音声の拒否、編集モードの独立した変更確認、マイク・キューの所有は維持する。下書き・全件価格調査の契約と実APIの検証範囲はADR-011末尾とVOICE_RECIPE_ACCEPTANCE.mdを参照。

## 2026-11-05: 保存一回で未確定レシピを登録する（登録の二段階承認を置換）

料理人の「保存」を正式なHuman Gateの承認とする。事前レビュー表示・二度目の保存発話は必須にしない。
数量・価格などの不足は既存NULL契約で保存し、分類不明の単位は推測登録せず依存する組を未確定とする。
料理名が空なら「無題のレシピ」を使う。保存後の詳細画面の不足表示から、後で設定・音声編集で補完する。
解析中の同じ下書きへの保存指示はFIFOで解析後に処理する。初回idle→createで、続けて収録された保存指示を
古いモードの承認と誤判定しない。別下書き・モードへの指示拒否、同一request_id、owner・価格採用の原子性は維持する。
価格検索は保存の前提にせず、保存開始時に中断する。DBが識別競合や障害で拒否した場合は下書きと理由を保持する。
この変更は登録を対象とし、編集側の提案・確定契約とページ遷移の寿命は変更しない。
