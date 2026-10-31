import {test, expect} from "@playwright/test";
import {VoiceBacklog, audioSeconds} from "../app/voice-backlog";

function frames(seconds: number, rate: number): Float32Array[] {
  return [new Float32Array(Math.round(seconds * rate))];
}

test("audioSeconds measures buffered duration at the captured sample rate", () => {
  expect(audioSeconds(frames(2, 48_000), 48_000)).toBeCloseTo(2, 6);
  expect(audioSeconds(frames(2, 24_000), 24_000)).toBeCloseTo(2, 6);
  expect(audioSeconds(frames(1, 48_000), 48_000)).toBeCloseTo(1, 6);
});

test("batches dispatch in capture order even when slots are saturated", () => {
  const done: string[] = [];
  // In-flight slots fill in capture order; the rest must wait behind buffered
  // audio and never jump ahead, so a correction keeps its context.
  const inFlight = {count: 0};
  const ordered = new VoiceBacklog<string>(60, 2, value => {done.push(value); inFlight.count++;});
  ordered.submit("one", 1); ordered.submit("two", 1);
  ordered.pump(inFlight.count); // dispatches one, two
  expect(done).toEqual(["one", "two"]);
  expect(inFlight.count).toBe(2);
  ordered.submit("three", 1); ordered.submit("four", 1);
  ordered.pump(inFlight.count); // saturated: nothing new dispatches
  expect(done).toEqual(["one", "two"]);
  inFlight.count = 1; // batch one settles
  ordered.pump(inFlight.count); // three drains next, never four first
  expect(done).toEqual(["one", "two", "three"]);
  inFlight.count = 0;
  ordered.submit("five", 1); // queues behind four, must not overtake it
  ordered.pump(inFlight.count);
  expect(done).toEqual(["one", "two", "three", "four", "five"]);
});

test("capacity is sixty buffered seconds at any capture rate", () => {
  const dropped: string[] = [];
  const queue = new VoiceBacklog<string>(60, 3, () => {}, entry => {dropped.push(entry.value);});
  // Two 29-second batches at 48 kHz raw samples must both fit the 60s window.
  queue.submit("older", audioSeconds(frames(29, 48_000), 48_000));
  queue.submit("newer", audioSeconds(frames(29, 48_000), 48_000));
  expect(queue.depth).toBe(2);
  expect(dropped).toEqual([]);
  // Overflow spills the oldest buffered utterance first.
  queue.submit("overflow", audioSeconds(frames(29, 48_000), 48_000));
  expect(dropped).toEqual(["older"]);
  expect(queue.depth).toBe(2);
  expect(queue.bufferedSeconds).toBeLessThanOrEqual(60);
});

test("a user stop keeps draining accepted audio in order", () => {
  const done: string[] = [];
  const queue = new VoiceBacklog<string>(60, 1, value => done.push(value));
  queue.submit("one", 1); queue.submit("two", 1); queue.submit("three", 1);
  queue.pump(0); // one slot: only the head dispatches
  expect(done).toEqual(["one"]);
  queue.pump(0); // next slot frees: strict order continues
  expect(done).toEqual(["one", "two"]);
  queue.pump(0);
  expect(done).toEqual(["one", "two", "three"]);
  expect(queue.depth).toBe(0);
});
