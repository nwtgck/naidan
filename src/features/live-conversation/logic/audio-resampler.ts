/** Streaming, windowed-sinc low-pass resampling. The phase and filter tail survive
 * chunk boundaries, so 44.1/48 kHz microphones do not accumulate timing errors. */
export function createLiveResampler({ inputRate, outputRate }: { inputRate: number, outputRate: number }) {
  if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate) || inputRate < 8000 || inputRate > 192000 || outputRate < 8000 || outputRate > 96000) {
    throw new Error('Unsupported live audio sample rate');
  }
  const radius = 24;
  const cutoff = Math.min(1, outputRate / inputRate) * 0.92;
  const step = inputRate / outputRate;
  let buffer: number[] = [];
  let base = 0;
  let received = 0;
  let emitted = 0;
  let finished = false;
  function read({ final }: { final: boolean }): Float32Array {
    const samples: number[] = [];
    const limit = final ? Math.floor(received / step) : Infinity;
    while (emitted < limit) {
      const position = emitted * step;
      if (!final && Math.floor(position) + radius >= received) {
        break;
      }
      let sum = 0;
      let weight = 0;
      const center = Math.floor(position);
      for (let i = center - radius + 1; i <= center + radius; i++) {
        const distance = i - position;
        const x = Math.PI * distance * cutoff;
        const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(x) / x;
        const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / radius);
        const coefficient = cutoff * sinc * window;
        const value = i < 0 || i >= received ? 0 : buffer[i - base];
        if (value === undefined) {
          throw new Error('Missing live resampler history');
        }
        sum += value * coefficient;
        weight += coefficient;
      }
      samples.push(Math.max(-1, Math.min(1, sum / weight)));
      emitted++;
    }
    const discard = Math.max(0, Math.min(buffer.length, Math.floor(emitted * step) - radius - base));
    if (discard) {
      buffer = buffer.slice(discard);
      base += discard;
    }
    return Float32Array.from(samples);
  }
  return {
    push({ pcm }: { pcm: Float32Array }): Float32Array {
      if (finished) {
        throw new Error('Live resampler has ended');
      }
      if (pcm.length > 65536 || !pcm.every(Number.isFinite)) {
        throw new Error('Invalid microphone samples');
      }
      for (const sample of pcm) {
        buffer.push(sample);
      }
      received += pcm.length;
      return read({ final: false });
    },
    finish(): Float32Array {
      if (finished) {
        return new Float32Array();
      }
      finished = true;
      const tail = read({ final: true });
      buffer = [];
      return tail;
    },
  };
}

export const TEST_ONLY = {
};
