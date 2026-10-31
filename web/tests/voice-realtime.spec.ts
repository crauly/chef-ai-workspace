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
        const s = {send(d) {}, close(c) {}, onmessage: null, onclose: null, onerror: null};
        box = s; return s;
      }, {onCommitted: (text, id) => committed.push([text, id]),
          onPartial: (text, id) => partials.push([text, id]),
          onState: () => {}});
      t.connect("wss://relay/demo/voice-realtime", "ticket");
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
