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

Registration retains review → subsequent explicit approval → `/recipes/full`.
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
  never reach the reviewed draft's save. “登録” and “登録してください” remain
  valid save requests. Confirmation of the unchanged current draft is required;
  a request before review opens review, never silently approves future content.
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
