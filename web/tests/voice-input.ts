import {expect, type Page} from "@playwright/test";

const sessions = new WeakMap<Page, {pending: string[]; count: number}>();

// Feed the real recording/transcription path so commands continue when recipe
// detail intentionally hides the manual fallback form. No real mic or AI call.
export async function voiceInput(page: Page, text: string) {
  let session = sessions.get(page);
  if(session&&!await page.evaluate(()=>typeof (window as any).feedTestVoice==="function")){sessions.delete(page);session=undefined;}
  if (!session) {
    session = {pending: [], count: 0};
    sessions.set(page, session);
    const state = session;
    await page.route("**/api/voice/transcribe", async route => {
      state.count++;
      await route.fulfill({json: {transcript: state.pending.shift()}});
    });
    await page.evaluate(() => {
      const Native = window.AudioWorkletNode;
      window.AudioWorkletNode = class extends Native {
        constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
          super(context, name, options);
          let epoch = options?.processorOptions?.reviewEpoch ?? 0;
          const post = this.port.postMessage.bind(this.port);
          this.port.postMessage = (message: any) => {
            if (message.type === "review") epoch = message.epoch;
            post(message);
          };
          (window as any).feedTestVoice = () => {
            for (const [seconds, value] of [[.5, .1], [1.1, 0]]) {
              this.port.onmessage?.call(this.port, new MessageEvent("message", {data: {
                samples: new Float32Array(Math.ceil(context.sampleRate * seconds)).fill(value),
                reviewEpoch: epoch,
              }}));
            }
          };
        }
      };
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {configurable: true, value: async () => {
        const context = new AudioContext();
        const out = context.createMediaStreamDestination();
        await context.resume();
        return out.stream;
      }});
    });
    await page.getByRole("button", {name: "🎙 音声操作を開始", exact: true}).click();
    await page.waitForFunction(() => typeof (window as any).feedTestVoice === "function");
  }
  const expected = session.count + 1;
  session.pending.push(text);
  await page.evaluate(() => (window as any).feedTestVoice());
  await expect.poll(() => session!.count).toBe(expected);
}
