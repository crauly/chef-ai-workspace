// Ordered, duration-bounded buffer for accepted voice audio awaiting
// transcription. The capture hook stays thin: this module owns FIFO order and
// capacity so both are unit-testable without a microphone or timers.
// Capacity is measured in buffered seconds at each batch's own sample rate,
// so a 48 kHz context holds the same window as a 24 kHz one. When the window
// overflows the oldest buffered utterance spills first; in-flight audio is
// never dropped here.
export type BacklogEntry<T> = {id: number; seconds: number; value: T};

export function audioSeconds(frames: Float32Array[], rate: number): number {
  if (!(rate > 0)) return 0;
  return frames.reduce((total, frame) => total + frame.length, 0) / rate;
}

export class VoiceBacklog<T> {
  private queue: BacklogEntry<T>[] = [];
  private seconds = 0;
  private nextId = 0;
  constructor(
    private readonly maxSeconds: number,
    private readonly maxInFlight: number,
    private readonly dispatch: (value: T) => void,
    private readonly onDrop: (dropped: BacklogEntry<T>) => void = () => {},
  ) {}
  get depth(): number {return this.queue.length;}
  get bufferedSeconds(): number {return this.seconds;}
  submit(value: T, seconds: number): void {
    this.queue.push({id: this.nextId++, seconds: Math.max(0, seconds), value});
    this.seconds += Math.max(0, seconds);
    while (this.seconds > this.maxSeconds && this.queue.length) {
      const dropped = this.queue.shift()!;
      this.seconds -= dropped.seconds;
      this.onDrop(dropped);
    }
  }
  // Dispatch in capture order while free slots remain. inFlight counts batches
  // already dispatched but unsettled; dispatch() must account synchronously
  // (runBatch increments its counter before returning) so order never jumps
  // ahead of buffered audio, including during the flush after a user stop.
  pump(inFlight: number): void {
    while (this.queue.length && inFlight < this.maxInFlight) {
      const next = this.queue.shift()!;
      this.seconds -= next.seconds;
      inFlight++;
      this.dispatch(next.value);
    }
  }
}
