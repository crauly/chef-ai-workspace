import {test, expect} from "@playwright/test";
import {transpileModule} from "../node_modules/typescript/lib/typescript.js";
import {readFileSync} from "node:fs";
import {join} from "node:path";

// Fixture-only verification of the real Phase B modules (no microphone, no
// network, no draft side effects). Real Meta realtime audio, Render WS
// behavior, and on-device microphone capture remain unverified.
type RealtimeSources = {store: string; audio: string; transport: string};
function bundle(): RealtimeSources {
  const root = join(__dirname, "..", "app");
  const compile = (file: string) =>
    transpileModule(readFileSync(join(root, file), "utf8"), {
      compilerOptions: {module: 1 /* CommonJS */, target: 99 /* ESNext */},
    }).outputText.replace(/"use strict";?/g, "");
  return {
    store: compile("voice-turn-store.ts"),
    audio: compile("voice-realtime-audio.ts"),
    transport: compile("voice-realtime-transport.ts"),
  };
}
// Boot the real modules with a minimal require shim: the store and audio
// modules are dependency-free; the transport resolves them through the shim.
const BOOT = `
  (globalThis.process ??= {env: {}});
  const __deps = {};
  for (const [name, source] of Object.entries({
    "./voice-turn-store": bundle.store, "./voice-realtime-audio": bundle.audio,
  })) {
    const box = {};
    new Function("exports", "require", "module", source)(box, () => ({}), {exports: box});
    __deps[name] = box;
  }
  const requireShim = name => __deps[name] ?? (() => { throw new Error("unexpected require " + name); })();
  const transportBox = {};
  new Function("exports", "require", "module", bundle.transport)(
    transportBox, requireShim, {exports: transportBox});
  const exports = {...__deps["./voice-turn-store"], ...__deps["./voice-realtime-audio"], ...transportBox};
`;

test("realtime turn contract: partial display-only, speechEnd never commits", async ({page}) => {
  await page.goto("/");
  const result = await page.evaluate(([bundle, boot]: [RealtimeSources, string]) => {
    const run = new Function("bundle", boot + `
      const store = new exports.VoiceTurnStore();
      store.handle({type: "speechStart", turnId: "t1"});
      store.handle({type: "partial", text: "ズッパ"});
      const partialBefore = store.partial("t1");
      const endCommits = store.handle({type: "speechEnd", turnId: "t1"});
      const committed = store.handle({type: "speechComplete", turnId: "t1", text: "ズッパ・ディ・ペッシェ"});
      const duplicate = store.handle({type: "speechComplete", turnId: "t1", text: "dup"});
      return {partialBefore, endCommits: endCommits.length, committed, dup: duplicate.length};
    `);
    return run(bundle) as {partialBefore: string; endCommits: number; committed: unknown; dup: number};
  }, [bundle(), BOOT] as [RealtimeSources, string]);
  expect(result.partialBefore).toBe("ズッパ");
  expect(result.endCommits).toBe(0);
  expect(result.dup).toBe(0);
  expect(result.committed).toHaveLength(1);
});

test("transport: final:true never commits; speechComplete body is canonical", async ({page}) => {
  await page.goto("/");
  const result = await page.evaluate(([bundle, boot]: [RealtimeSources, string]) => {
    const run = new Function("bundle", boot + `
      let box = null;
      const committed = [];
      const partials = [];
      const t = new exports.RealtimeTransport(url => {
        const s = {send(d) {}, close(c) {}, onopen: null, onmessage: null, onclose: null, onerror: null};
        box = s; return s;
      }, {onCommitted: (text, id) => committed.push([text, id]),
          onPartial: (text, id) => partials.push([text, id]),
          onState: () => {}});
      t.connect("wss://relay/demo/voice-realtime", "ticket");
      box.onopen();
      box.onmessage({data: JSON.stringify({type: "ready"})});
      box.onmessage({data: JSON.stringify({type: "speechStart", turnId: "t1"})});
      box.onmessage({data: JSON.stringify({type: "transcript", transcript: "エビ1尾", final: false})});
      // A provider final:true is still provisional: no commit, Muse untouched.
      box.onmessage({data: JSON.stringify({type: "transcript", transcript: "エビ1尾", final: true})});
      const afterFinal = committed.length;
      box.onmessage({data: JSON.stringify({type: "speechEnd", turnId: "t1"})});
      const afterEnd = committed.length;
      // Overlapping second turn, out-of-order completion.
      box.onmessage({data: JSON.stringify({type: "speechStart", turnId: "t2"})});
      box.onmessage({data: JSON.stringify({type: "speechComplete", turnId: "t2", transcript: "ハマグリ1個"})});
      box.onmessage({data: JSON.stringify({type: "speechComplete", turnId: "t1", transcript: "エビ2尾"})});
      box.onmessage({data: JSON.stringify({type: "speechComplete", turnId: "t1", transcript: "エビ2尾"})});
      return {afterFinal, afterEnd, committed, partialCount: partials.length,
        backlog: exports.backlogExceeded(5 * 24000 * 2 + 1),
        pcmKept: t.sendPcm(new ArrayBuffer(8), 10),
        pcmDropped: t.sendPcm(new ArrayBuffer(8), 5 * 24000 * 2 + 1)};
    `);
    return run(bundle) as Record<string, unknown>;
  }, [bundle(), BOOT] as [RealtimeSources, string]);
  expect(result["afterFinal"]).toBe(0);
  expect(result["afterEnd"]).toBe(0);
  // Canonical speechComplete bodies, in completion order; duplicates ignored.
  expect(result["committed"]).toEqual([["ハマグリ1個", "t2"], ["エビ2尾", "t1"]]);
  expect(result["partialCount"]).toBe(2);
  expect(result["backlog"]).toBe(true);
  expect(result["pcmKept"]).toBe(true);
  expect(result["pcmDropped"]).toBe(false);
});

test("audio helpers: 24kHz resampling, silence, and endpoint guard", async ({page}) => {
  await page.goto("/");
  const result = await page.evaluate(([bundle, boot]: [RealtimeSources, string]) => {
    const run = new Function("bundle", boot + `
      const silence = new Float32Array(480);
      const silent = exports.resampleTo24kMono(silence, 48000);
      const tone = new Float32Array(480).fill(0.5);
      const half = exports.resampleTo24kMono(tone, 48000);
      const same = exports.resampleTo24kMono(new Float32Array(240).fill(-2), 24000);
      const bad = exports.resampleTo24kMono(new Float32Array(10), 0);
      return {
        silentLen: silent.length, silentZero: Array.from(silent).every(v => v === 0),
        halfLen: half.length, halfLevel: half[0],
        sameLen: same.length, clipped: same[0],
        badLen: bad.length,
        endpointUnset: exports.realtimeWsEndpoint(),
        backlog: exports.REALTIME_BACKLOG_BYTES,
      };
    `);
    return run(bundle) as Record<string, unknown>;
  }, [bundle(), BOOT] as [RealtimeSources, string]);
  expect(result["silentLen"]).toBe(240);
  expect(result["silentZero"]).toBe(true);
  expect(result["halfLen"]).toBe(240);
  expect(result["halfLevel"]).toBe(16384);
  expect(result["sameLen"]).toBe(240);
  expect(result["clipped"]).toBe(-32768);
  expect(result["badLen"]).toBe(0);
  // No public relay origin in test env: realtime must report unconfigured.
  expect(result["endpointUnset"]).toBeNull();
  expect(result["backlog"]).toBe(5 * 24000 * 2);
});

test("connection: ticket waits for open; pre-open close sends nothing", async ({page}) => {
  await page.goto("/");
  const result = await page.evaluate(([bundle, boot]: [RealtimeSources, string]) => {
    const run = new Function("bundle", boot + `
      const states = [];
      const frames = [];
      let box = null;
      const t = new exports.RealtimeTransport(url => {
        const s = {send(d) { frames.push(d); }, close(c) {}, onopen: null,
          onmessage: null, onclose: null, onerror: null};
        box = s; return s;
      }, {onState: s => states.push(s)});
      t.connect("wss://relay/demo/voice-realtime", "tick-123");
      const beforeOpen = frames.length;
      box.onclose({code: 1006}); // connection failed before open
      // The socket is detached by construction: late frames are no-ops.
      box.onopen?.(); // must not send the ticket
      box.onmessage?.({data: JSON.stringify({type: "ready"})}); // ignored
      // A fresh connect sends the ticket only after open.
      const frames2 = [];
      let box2 = null;
      const t2 = new exports.RealtimeTransport(url => {
        const s = {send(d) { frames2.push(d); }, close(c) {}, onopen: null,
          onmessage: null, onclose: null, onerror: null};
        box2 = s; return s;
      }, {});
      t2.connect("wss://relay/demo/voice-realtime", "tick-456");
      const queued = frames2.length;
      box2.onopen();
      return {beforeOpen, after: frames.length, states,
        queued, ticket: frames2.length ? JSON.parse(frames2[0]).ticket : null};
    `);
    return run(bundle) as Record<string, unknown>;
  }, [bundle(), BOOT] as [RealtimeSources, string]);
  expect(result["beforeOpen"]).toBe(0);
  expect(result["after"]).toBe(0);
  expect(result["states"]).toEqual(["connecting", "closed"]);
  expect(result["queued"]).toBe(0);
  expect(result["ticket"]).toBe("tick-456");
});

test("drain: endStream first, late speechComplete commits once, close finalizes", async ({page}) => {
  await page.goto("/");
  const result = await page.evaluate(([bundle, boot]: [RealtimeSources, string]) => {
    const run = new Function("bundle", boot + `
      const states = [];
      const frames = [];
      const committed = [];
      let box = null;
      const t = new exports.RealtimeTransport(url => {
        const s = {send(d) { frames.push(d); }, close(c) {}, onopen: null,
          onmessage: null, onclose: null, onerror: null};
        box = s; return s;
      }, {onCommitted: (text, id) => committed.push([text, id]),
          onState: s => states.push(s)});
      t.connect("wss://relay/demo/voice-realtime", "ticket");
      box.onopen();
      box.onmessage({data: JSON.stringify({type: "ready"})});
      box.onmessage({data: JSON.stringify({type: "speechStart", turnId: "t9"})});
      t.finishAndDrain(5000);
      const endStream = frames.length ? JSON.parse(frames[frames.length - 1]).type : null;
      // The final transcript arrives after the user stopped: still commits.
      box.onmessage({data: JSON.stringify({type: "speechComplete", turnId: "t9", transcript: "エビ2尾"})});
      // A duplicate during the drain never re-applies.
      box.onmessage({data: JSON.stringify({type: "speechComplete", turnId: "t9", transcript: "エビ2尾"})});
      box.onmessage({data: JSON.stringify({type: "ready"})}); // stray ready during drain
      box.onclose({code: 1000}); // relay answers and closes
      // A closed socket delivers nothing more by construction.
      const postCloseDead = box.onmessage === null;
      return {endStream, committed, states, postCloseDead};
    `);
    return run(bundle) as Record<string, unknown>;
  }, [bundle(), BOOT] as [RealtimeSources, string]);
  expect(result["endStream"]).toBe("endStream");
  expect(result["committed"]).toEqual([["エビ2尾", "t9"]]);
  expect(result["states"]).toEqual(["connecting", "ready", "draining", "closed"]);
  expect(result["postCloseDead"]).toBe(true);
});

test("drain timeout closes locally when the relay stays silent", async ({page}) => {
  await page.goto("/");
  const result = await page.evaluate(async ([bundle, boot]: [RealtimeSources, string]) => {
    const run = new Function("bundle", boot + `
      return (async () => {
        const states = [];
        let closed = 0;
        let box = null;
        const t = new exports.RealtimeTransport(url => {
          const s = {send(d) {}, close(c) { closed++; }, onopen: null,
            onmessage: null, onclose: null, onerror: null};
          box = s; return s;
        }, {onState: s => states.push(s)});
        t.connect("wss://relay/demo/voice-realtime", "ticket");
        box.onopen();
        box.onmessage({data: JSON.stringify({type: "ready"})});
        t.finishAndDrain(30);
        await new Promise(resolve => setTimeout(resolve, 120));
        return {closed: closed > 0, states};
      })();
    `);
    return await run(bundle) as Record<string, unknown>;
  }, [bundle(), BOOT] as [RealtimeSources, string]);
  expect(result["closed"]).toBe(true);
  expect(result["states"]).toEqual(["connecting", "ready", "draining", "closed"]);
});

test("approval epoch is captured at speechStart, not at completion", async ({page}) => {
  await page.goto("/");
  const result = await page.evaluate(([bundle, boot]: [RealtimeSources, string]) => {
    const run = new Function("bundle", boot + `
      // Downstream gate (VoiceRecipeRegistration): approval only when the
      // turn's epoch strictly equals the live approval epoch.
      const store = new exports.VoiceTurnStore();
      let approvalEpoch = 5;
      // Case 1: utterance starts before review, completes after it.
      store.handle({type: "speechStart", turnId: "pre"}, 5);
      approvalEpoch = 6; // user reviews meanwhile; markReview() -> 6
      const late = store.handle({type: "speechComplete", turnId: "pre", text: "保存してください"});
      const preApproved = late.length === 1 && late[0].startEpoch === approvalEpoch;
      // Case 2: utterance starts after review: approved normally.
      store.handle({type: "speechStart", turnId: "post"}, 6);
      const fresh = store.handle({type: "speechComplete", turnId: "post", text: "保存してください"});
      const postApproved = fresh.length === 1 && fresh[0].startEpoch === approvalEpoch;
      return {preEpoch: late[0]?.startEpoch ?? null, preApproved,
        postEpoch: fresh[0]?.startEpoch ?? null, postApproved};
    `);
    return run(bundle) as Record<string, unknown>;
  }, [bundle(), BOOT] as [RealtimeSources, string]);
  // A pre-review "save please" completing after review must NOT approve.
  expect(result["preEpoch"]).toBe(5);
  expect(result["preApproved"]).toBe(false);
  // A genuinely post-review approval still works.
  expect(result["postEpoch"]).toBe(6);
  expect(result["postApproved"]).toBe(true);
});

test("missing/late/duplicate starts never escalate approval", async ({page}) => {
  await page.goto("/");
  const result = await page.evaluate(([bundle, boot]: [RealtimeSources, string]) => {
    const run = new Function("bundle", boot + `
      const store = new exports.VoiceTurnStore();
      // Missing start: no guessed epoch.
      const missing = store.handle({type: "speechComplete", turnId: "lost", text: "保存してください"});
      // Late start after completion must not upgrade the epoch.
      store.handle({type: "speechStart", turnId: "lost"}, 9);
      const afterLateStart = store.drain();
      // Duplicate starts: the first epoch wins, never overwritten.
      store.handle({type: "speechStart", turnId: "dup"}, 3);
      store.handle({type: "speechStart", turnId: "dup"}, 7);
      const duped = store.handle({type: "speechComplete", turnId: "dup", text: "保存してください"});
      // Duplicate completion: absorbed, single commit.
      const again = store.handle({type: "speechComplete", turnId: "dup", text: "保存してください"});
      // Out-of-order: complete arrives before start.
      const store2 = new exports.VoiceTurnStore();
      const early = store2.handle({type: "speechComplete", turnId: "ooo", text: "保存してください"});
      store2.handle({type: "speechStart", turnId: "ooo"}, 4);
      return {missingEpoch: missing[0]?.startEpoch ?? "none",
        afterLateStartEpoch: afterLateStart[0]?.startEpoch ?? "none",
        dupEpoch: duped[0]?.startEpoch ?? "none", dupCount: again.length,
        earlyEpoch: early[0]?.startEpoch ?? "none"};
    `);
    return run(bundle) as Record<string, unknown>;
  }, [bundle(), BOOT] as [RealtimeSources, string]);
  // Harness maps a null (unknown) epoch to "none": never a guessed approval.
  expect(result["missingEpoch"]).toBe("none");
  expect(result["afterLateStartEpoch"]).toBe("none");
  expect(result["dupEpoch"]).toBe(3);
  expect(result["dupCount"]).toBe(0);
  expect(result["earlyEpoch"]).toBe("none");
});

test("transport samples the review epoch at speechStart", async ({page}) => {
  await page.goto("/");
  const result = await page.evaluate(([bundle, boot]: [RealtimeSources, string]) => {
    const run = new Function("bundle", boot + `
      const committed = [];
      let epoch = 5;
      let box = null;
      const t = new exports.RealtimeTransport(url => {
        const s = {send(d) {}, close(c) {}, onopen: null, onmessage: null, onclose: null, onerror: null};
        box = s; return s;
      }, {onCommitted: (text, id, startEpoch) => committed.push([text, id, startEpoch ?? null]),
          getReviewEpoch: () => epoch,
          onState: () => {}});
      t.connect("wss://relay/demo/voice-realtime", "ticket");
      box.onopen();
      box.onmessage({data: JSON.stringify({type: "ready"})});
      box.onmessage({data: JSON.stringify({type: "speechStart", turnId: "t1"})});
      epoch = 6; // review happens while the turn is still open
      box.onmessage({data: JSON.stringify({type: "speechComplete", turnId: "t1", transcript: "保存してください"})});
      // Turn with no start: null epoch, never a guessed approval.
      box.onmessage({data: JSON.stringify({type: "speechComplete", turnId: "t2", transcript: "保存してください"})});
      return {committed};
    `);
    return run(bundle) as Record<string, unknown>;
  }, [bundle(), BOOT] as [RealtimeSources, string]);
  expect(result["committed"]).toEqual([
    ["保存してください", "t1", 5],
    ["保存してください", "t2", null],
  ]);
});
