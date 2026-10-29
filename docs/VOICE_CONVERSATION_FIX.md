# Voice conversation regression — 2026-10-29

The user's hosted acceptance exposed gaps that the earlier canned acceptance
did not cover: long pauses, a phonetic dish-name error retained in the draft,
and polite/combined save requests treated as recipe data instead of commands.

## Changes

- Silence endpointing changes from 3.5 seconds to approximately 1 second.
  Voice transcription and Spark remain sequential external requests; this is
  still batch WAV, not realtime streaming. Adjacent pending data is coalesced.
- Spark interprets culinary context and can propose an obvious phonetic dish
  title correction. The original transcript and correction reason remain
  visible. Brands, amounts and prices must not be invented. Ambiguities block
  saving until a person corrects them. Selling price remains optional.
- Spark uses `reasoning_effort: low`, not disabled reasoning, with a 25-second
  timeout and cancellation. See the official [reasoning contract](https://dev.meta.ai/docs/reasoning).
- Polite requests such as 「保存してください」 and combined requests such as
  「内容を確認。登録を確定」 are deterministic controls and do not invoke Spark.
  The first save request presents the draft for review. Only a later explicit
  approval of that same unchanged draft can save it. New data invalidates review.
- Queued requests cannot approve a future draft. AudioWorklet review epochs
  tag audio at capture, flushing pre-review partial frames with the old epoch.
  Delayed delivery or transcription cannot turn earlier speech into approval.
  The new worklet has a versioned URL; the old script remains for old clients.
- Mixed correction/negative text remains data; a standalone negative request
  clears approval without discarding the draft. Failed interpretation is retryable.

## Verification and limits

Build and typecheck passed. Normal browser tests: 22 passed, 3 opt-in live tests
skipped. Python: 119 passed, 1 skipped. Regression scenarios include delayed
audio, review/save combinations, queued input, negative requests, same-draft
approval, visible culinary suggestions and optional selling price.

A separate opt-in test used Japanese synthetic speech through actual Muse Voice
and Spark, and a fresh owner in the dedicated Chef database. It verified zero
writes before approval, one recipe/version after approval and a reload with
cost 216 yen: pasta 100g at 350 yen/500g, garlic 10g at 4600 yen/kg, oil 25g at
4000 yen/kg. Selling price was unset. A manufacturer recognition error required
an explicit text correction. An earlier ambiguous price transcription was
correctly left unresolved and blocked saving. This is not a claim of perfect
recognition or an entirely voice-only successful run. All six test-owner table
counts were zero after cleanup, and the temporary Auth owner was removed.

An isolated prompt replay took 15,965ms before and 6,310ms with the revised
prompt/low reasoning, one sample each. Successful live interpretation samples
took approximately 3.6–5.4 seconds. These measure the model stage, not complete
recording/upload/transcription latency, and do not establish a general speedup.
Hosted authenticated end-to-end testing and arbitrary speakers/kitchen noise
are not established by this local pre-release evidence.

Reproduce the opt-in scenario with the existing live backend and
`CHEF_LIVE_VOICE_CASE=complaint`, supplying synthesized fixture WAVs through
`CHEF_LIVE_VOICE_AUDIO_DIR`; see [live acceptance safeguards](VOICE_ACCEPTANCE.md).
