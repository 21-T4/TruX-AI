/* Microphone capture for TruX Live (AudioWorklet).
   Resamples the device rate to 16 kHz mono and posts ~40 ms Int16 chunks,
   so audio leaves the main thread already in the format Gemini Live wants. */
class TruxMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.last = 0;
    this.out = new Int16Array(640);
    this.fill = 0;
    this.muted = false;
    this.port.onmessage = e => { if (e.data && typeof e.data.muted === 'boolean') this.muted = e.data.muted; };
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    let level = 0;
    // Linear-interpolated resampling across block boundaries.
    while (this.pos < input.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i === 0 ? this.last : input[i - 1];
      const b = input[i];
      let s = this.muted ? 0 : a + (b - a) * frac;
      s = Math.max(-1, Math.min(1, s));
      level = Math.max(level, Math.abs(s));
      this.out[this.fill++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.fill === this.out.length) {
        this.port.postMessage({ pcm: this.out.buffer, level }, [this.out.buffer]);
        this.out = new Int16Array(640);
        this.fill = 0;
        level = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= input.length;
    this.last = input[input.length - 1];
    return true;
  }
}
registerProcessor('trux-mic', TruxMicProcessor);
