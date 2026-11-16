// @vitest-environment node
import { expect, it } from 'vitest';
import { applyInputLevel } from './audio-level';

it('keeps unity gain bit-exact without replacing or writing the owned PCM buffer', () => {
  const pcm = new Float32Array([-0, 1e-42, 0.5, -1, 1]), buffer = pcm.buffer;
  const bytes = new Uint8Array(buffer).slice();
  const level = applyInputLevel({ pcm, sampleRate: 24000, requested: { kind: 'gain', gain: 1 } });
  expect(pcm.buffer).toBe(buffer);
  expect(new Uint8Array(buffer)).toEqual(bytes);
  expect(level.after).toBe(level.before);
  expect(level).toMatchObject({ requested: { kind: 'gain', gain: 1 }, appliedGain: 1, clippedSamples: 0, before: { samples: 5, clippedSamples: 2 } });
});

it.each([2, 8])('applies explicit %s-times gain in place and measures actual source samples', gain => {
  const pcm = new Float32Array([0.125, -0.0625, 0.015625]), buffer = pcm.buffer;
  const level = applyInputLevel({ pcm, sampleRate: 24000, requested: { kind: 'gain', gain } });
  expect(pcm.buffer).toBe(buffer);
  expect(pcm).toEqual(new Float32Array([0.125 * gain, -0.0625 * gain, 0.015625 * gain]));
  expect(level).toMatchObject({ requested: { kind: 'gain', gain }, appliedGain: gain, clippedSamples: 0, before: { samples: 3, seconds: 3 / 24000, peak: 0.125 }, after: { samples: 3, seconds: 3 / 24000, peak: 0.125 * gain } });
  expect(level.after!.rms).toBeCloseTo(level.before!.rms * gain, 10);
});

it('clips out-of-range products without reducing gain and distinguishes exact endpoints from actual clipping', () => {
  const pcm = new Float32Array([0.25, -0.25, 0.125, -0.125, 0]);
  const level = applyInputLevel({ pcm, sampleRate: 24000, requested: { kind: 'gain', gain: 8 } });
  expect(pcm).toEqual(new Float32Array([1, -1, 1, -1, 0]));
  expect(level).toMatchObject({ requested: { kind: 'gain', gain: 8 }, appliedGain: 8, clippedSamples: 2, before: { peak: 0.25, clippedSamples: 0 }, after: { peak: 1, clippedSamples: 4 } });
});

it.each([NaN, Infinity, -Infinity, 0, -1])('rejects invalid gain %s before modifying samples', gain => {
  const pcm = new Float32Array([0.25, -0.5]);
  expect(() => applyInputLevel({ pcm, sampleRate: 24000, requested: { kind: 'gain', gain } })).toThrow('finite positive');
  expect(pcm).toEqual(new Float32Array([0.25, -0.5]));
});

it('rejects nonfinite PCM before partially changing an earlier sample', () => {
  const pcm = new Float32Array([0.25, NaN]);
  expect(() => applyInputLevel({ pcm, sampleRate: 24000, requested: { kind: 'gain', gain: 2 } })).toThrow('Invalid live audio sample');
  expect(pcm[0]).toBe(0.25);
});

it.each([0.05, 1])('brings source peak %s to the target with one constant gain, including attenuation', amplitude => {
  const pcm = new Float32Array([amplitude, -amplitude, amplitude / 2, 0]), buffer = pcm.buffer;
  const original = pcm.slice();
  const level = applyInputLevel({ pcm, sampleRate: 24000, requested: { kind: 'peak', targetPeak: 0.8 } });
  expect(pcm.buffer).toBe(buffer);
  expect(level.requested).toEqual({ kind: 'peak', targetPeak: 0.8 });
  expect(level.appliedGain).toBe(0.8 / original[0]!);
  expect(level.after!.peak).toBeCloseTo(0.8, 6);
  expect(pcm[0]).toBe(Math.fround(original[0]! * level.appliedGain!));
  expect(pcm[1]).toBe(-pcm[0]!);
  expect(pcm[2]).toBe(Math.fround(original[2]! * level.appliedGain!));
  expect(pcm[3]).toBe(0);
  expect(level.clippedSamples).toBe(0);
});

it('keeps silent source PCM bit-exact with unit gain in peak mode', () => {
  const pcm = new Float32Array([-0, 0, -0]), bytes = new Uint8Array(pcm.buffer).slice();
  const level = applyInputLevel({ pcm, sampleRate: 24000, requested: { kind: 'peak', targetPeak: 0.8 } });
  expect(new Uint8Array(pcm.buffer)).toEqual(bytes);
  expect(level).toMatchObject({ requested: { kind: 'peak', targetPeak: 0.8 }, appliedGain: 1, before: { peak: 0 }, after: { peak: 0 }, clippedSamples: 0 });
  expect(level.after).toBe(level.before);
});

it.each([NaN, Infinity, 0, -0.1, 1.01])('rejects invalid peak target %s without modifying source PCM', targetPeak => {
  const pcm = new Float32Array([0.25]);
  expect(() => applyInputLevel({ pcm, sampleRate: 24000, requested: { kind: 'peak', targetPeak } })).toThrow('target peak');
  expect(pcm[0]).toBe(0.25);
});
