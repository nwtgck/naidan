/* global AudioWorkletProcessor, registerProcessor */
// Standalone-safe AudioWorklet module: no imports, Worker graph or runtime dependencies.
class LiveCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.used = 0;
    this.ended = false;
    this.port.onmessage = event => {
      if (event.data === 'finish') {
        this.flush();
        this.ended = true;
        this.port.postMessage({ type: 'finished' });
      }
    };
  }

  flush() {
    if (!this.used) {
      return;
    }
    const pcm = this.buffer.slice(0, this.used);
    this.used = 0;
    this.port.postMessage({ type: 'pcm', pcm }, [pcm.buffer]);
  }

  process(inputs) {
    if (this.ended) {
      return false;
    }
    const channels = inputs[0];
    const frames = channels?.[0]?.length ?? 0;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (const channel of channels) {
        sum += channel[i];
      }
      this.buffer[this.used++] = sum / channels.length;
      if (this.used === this.buffer.length) {
        this.flush();
      }
    }
    return true;
  }
}
registerProcessor('naidan-live-capture', LiveCapture);
