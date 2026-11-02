import { describe, expect, it } from 'vitest';
import { createLiveResampler } from './audio-resampler';

function resample({ input, inputRate, chunk }: { input: Float32Array, inputRate: number, chunk: number }): Float32Array {
  const converter = createLiveResampler({ inputRate, outputRate: 16000 });
  const output: number[] = [];
  for (let offset = 0; offset < input.length; offset += chunk) {
    output.push(...converter.push({ pcm: input.slice(offset, offset + chunk) }));
  }
  output.push(...converter.finish());
  return Float32Array.from(output);
}

describe('live microphone resampling', () => {
  it.each([44100, 48000, 16000, 8000, 96000])('preserves duration and chunk invariance at %s Hz', inputRate => {
    const input = Float32Array.from({ length: inputRate }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 1000 * i / inputRate));
    const a = resample({ input, inputRate, chunk: 1024 });
    const b = resample({ input, inputRate, chunk: 137 });
    expect(a.length).toBe(16000);
    expect(a).toEqual(b);
    expect(Math.max(...a)).toBeCloseTo(0.3, 2);
  });

  it('attenuates frequencies above the output Nyquist limit instead of aliasing them', () => {
    const input = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(2 * Math.PI * 12000 * i / 48000));
    const output = resample({ input, inputRate: 48000, chunk: 2048 }).slice(100, -100);
    const rms = Math.sqrt(output.reduce((sum, sample) => sum + sample * sample, 0) / output.length);
    expect(rms).toBeLessThan(0.015);
  });

  it('flushes exactly once and rejects samples after the end', () => {
    const converter = createLiveResampler({ inputRate: 48000, outputRate: 16000 });
    converter.push({ pcm: new Float32Array(50).fill(0.1) });
    expect(converter.finish().length).toBeGreaterThan(0);
    expect(converter.finish()).toHaveLength(0);
    expect(() => converter.push({ pcm: new Float32Array(2) })).toThrow('ended');
  });

  it.each([NaN, Infinity, 0, 7000, 200000])('rejects invalid rates %s', inputRate => {
    expect(() => createLiveResampler({ inputRate, outputRate: 16000 })).toThrow();
  });

  it('rejects nonfinite samples before contaminating its filter', () => {
    const converter = createLiveResampler({ inputRate: 48000, outputRate: 16000 });
    expect(() => converter.push({ pcm: new Float32Array([NaN]) })).toThrow();
  });
});
