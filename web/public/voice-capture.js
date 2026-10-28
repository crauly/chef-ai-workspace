// Audio frames only: recognition and business decisions belong on the server.
class VoiceCapture extends AudioWorkletProcessor {
  constructor() { super(); this.frames = new Float32Array(2048); this.used = 0; }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      this.frames[this.used++] = sample;
      if (this.used === this.frames.length) {
        this.port.postMessage(this.frames, [this.frames.buffer]);
        this.frames = new Float32Array(2048); this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor("voice-capture", VoiceCapture);
