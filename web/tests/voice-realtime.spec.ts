import {test, expect} from "@playwright/test";
import {transpileModule} from "../node_modules/typescript/lib/typescript.js";
import {readFileSync} from "node:fs";
import {join} from "node:path";

// Fixture-only verification of the real Phase B modules (no microphone,
// no network, no draft side effects). Real Metaเนื่อง ASR and real-device
// audio remain unverified.
function bundle(): string {
  const root = join(__dirname, "..", "app");
  const compile = (file: string) =>
    transpileModule(readFileSync(join(root, file), "utf8"), {
      compilerOptions: {module: 1 /* CommonJS */, target: 99 /* ESNext */},
    }).outputText
      .replace(/"use strict";?/g, "")
      .replace(/Object\.defineProperty\(exports[^;]*;/g, "")
      .replace(/exports\.\w+\s*=\s*void 0;?/g, "");
  return compile("voice-turn-store.ts") + "\n" + compile("voice-realtime-transport.ts");
}

test("realtime turn contract: partial display-only, speechEnd never commits", async ({page}) => {
  await page.goto("/");
  const result = await page.evaluate((bundle: string) => {
    const run = new Function("exports", bundle + `
      const store = new exports.VoiceTurnStore();
      store.handle({type: "speechStart", turnId: "t1"});
      store.handle({type: "partial", text: "ズッパ"});
      const partialBefore = store.partial("t1");
      const endCommits = store.handle({type: "speechEnd", turnId: "t1"});
      const committed = store.handle({type: "speechComplete", turnId: "t1", text: "ズッパ・ディ・ペッシェ"});
      const duplicate = store.handle({type: "speechComplete", turnId: "t1", text: "dup"});
      return {partialBefore, endCommits: endCommits.length, committed, dup: duplicate.length};
    `);
    return run({}) as {partialBefore: string; endCommits: number; committed: unknown; dup: number};
  }, bundle());
  expect(result.partialBefore).toBe("ズッパ");
  expect(result.endCommits).toBe(0);
  expect(result.dup).toBe(0);
  expect(result.committed).toHaveLength(1);
});

test("realtime transport: duplicate finals ignored, backlog guarded", async ({page}) => {
  await page.goto("/");
  const result = await page.evaluate((bundle: string) => {
    const run = new Function("exports", bundle + `
      let box = null;
      const committed = [];
      const t = new exports.RealtimeTransport(url => {
        const s = {send(d) {}, close(c) {}, onmessage: null, onclose: null, onerror: null};
        box = s; return s;
      }, {onCommitted: (text, id) => committed.push([text, id]), onState: () => {}});
      t.connect("wss://relay/demo/voice-realtime", "ticket");
      box.onmessage({data: JSON.stringify({type: "ready"})});
      box.onmessage({data: JSON.stringify({type: "speechStart", turnId: "t1"})});
      box.onmessage({data: JSON.stringify({type: "transcript", transcript: "エビ", final: false})});
      const before = committed.length;
      box.onmessage({data: JSON.stringify({type: "speechEnd", turnId: "t1"})});
      const afterEnd = committed.length;
      box.onmessage({data: JSON.stringify({type: "speechComplete", turnId: "t1", transcript: "エビ2尾"})});
      box.onmessage({data: JSON.stringify({type: "speechComplete", turnId: "t1", transcript: "エビ2尾"})});
      return {before, afterEnd, committed,
        backlog: exports.backlogExceeded(5 * 24000 * 2 + 1),
        pcmKept: t.sendPcm(new ArrayBuffer(8), 10),
        pcmDropped: t.sendPcm(new ArrayBuffer(8), 5 * 24000 * 2 + 1)};
    `);
    return run({}) as Record<string, unknown>;
  }, bundle());
  expect(result["before"]).toBe(0);
  expect(result["afterEnd"]).toBe(0);
  expect(result["committed"]).toEqual([["エビ2尾", "t1"]]);
  expect(result["backlog"]).toBe(true);
  expect(result["pcmKept"]).toBe(true);
  expect(result["pcmDropped"]).toBe(false);
});
