// Tag audio at the processing thread, before main-thread delivery or transcription.
class VoiceCapture extends AudioWorkletProcessor {
  constructor(options) {
    super(); this.frames = new Float32Array(2048); this.used = 0;
    this.reviewEpoch = options.processorOptions?.reviewEpoch ?? 0;
    this.port.onmessage = event => {
      if (event.data?.type === "review") {
        this.flush(); // Pre-review samples keep their original approval epoch.
        this.reviewEpoch = event.data.epoch;
      }
    };
  }
  flush() {
    if (!this.used) return;
    const samples = this.used === this.frames.length ? this.frames : this.frames.slice(0, this.used);
    this.port.postMessage({samples, reviewEpoch: this.reviewEpoch}, [samples.buffer]);
    this.frames = new Float32Array(2048); this.used = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      this.frames[this.used++] = sample;
      if (this.used === this.frames.length) this.flush();
    }
    return true;
  }
}
registerProcessor("voice-capture", VoiceCapture);
