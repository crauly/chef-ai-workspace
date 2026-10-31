import {test, expect} from "@playwright/test";
import {resolveTransport, isTerminalRealtimeFailure} from "../app/voice-transport";

test("configured realtime stays until a terminal failure", () => {
  expect(resolveTransport(true, false)).toBe("realtime");
  expect(resolveTransport(false, false)).toBe("rest");
});

test("a terminal realtime failure sticks to REST for the session", () => {
  // No flapping: once failed, the same inputs keep resolving to REST.
  expect(resolveTransport(true, true)).toBe("rest");
  expect(resolveTransport(true, true)).toBe("rest");
  expect(resolveTransport(false, true)).toBe("rest");
});

test("only a terminal failure falls back; user stop keeps realtime", () => {
  expect(isTerminalRealtimeFailure("failed")).toBe(true);
  for (const state of ["idle", "connecting", "ready", "closed"]) {
    expect(isTerminalRealtimeFailure(state)).toBe(false);
    // A user stop ("closed") must not downgrade the next microphone press.
    expect(resolveTransport(true, false)).toBe("realtime");
  }
});

test("unconfigured realtime never selects the realtime transport", () => {
  for (const failed of [false, true]) {
    expect(resolveTransport(false, failed)).toBe("rest");
  }
});
