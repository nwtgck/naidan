// @vitest-environment node
import { expect, it } from 'vitest';
import { createLiveSpeechInputLevel } from './speech-input-level';

it('uses exact sample windows across packets and keeps only the last completed scalar window', () => {
  const level = createLiveSpeechInputLevel({ sampleRate: 10 });
  const first = new Float32Array([0.25, -0.25]);
  expect(level.process({ pcm: first, gain: 2, observe: true })).toBeUndefined();
  expect(first).toEqual(new Float32Array([0.5, -0.5]));
  const last = new Float32Array([0.75, 0.5, 0, ...new Float32Array(5).fill(0.125), 0.25]);
  const window = level.process({ pcm: last, gain: 2, observe: true });
  expect(window).toMatchObject({ gain: 2, before: { samples: 5, seconds: 0.5, peak: 0.125, rms: 0.125 }, after: { samples: 5, seconds: 0.5, peak: 0.25, rms: 0.25 }, clippedSamples: 0 });
  const next = level.process({ pcm: new Float32Array(4).fill(0.25), gain: 2, observe: true });
  expect(next).toMatchObject({ before: { samples: 5, peak: 0.25 }, after: { peak: 0.5 } });
});

it('counts actual clipping separately from the near-full-scale meter', () => {
  const level = createLiveSpeechInputLevel({ sampleRate: 10 });
  const pcm = new Float32Array([0.25, -0.25, 0.125, -0.125, 0]);
  const window = level.process({ pcm, gain: 8, observe: true });
  expect(pcm).toEqual(new Float32Array([1, -1, 1, -1, 0]));
  expect(window).toMatchObject({ before: { peak: 0.25, clippedSamples: 0 }, after: { peak: 1, clippedSamples: 4 }, clippedSamples: 2 });
});

it('discards an unfinished window on reset and keeps mute silence silent', () => {
  const level = createLiveSpeechInputLevel({ sampleRate: 10 });
  level.process({ pcm: new Float32Array(4).fill(0.75), gain: 2, observe: true });
  level.reset();
  expect(level.process({ pcm: new Float32Array(1), gain: 8, observe: true })).toBeUndefined();
  const window = level.process({ pcm: new Float32Array(4), gain: 8, observe: true });
  expect(window).toMatchObject({ gain: 8, before: { samples: 5, peak: 0, rms: 0 }, after: { peak: 0, rms: 0 }, clippedSamples: 0 });
});

it('does not accumulate PCM while observation is off and preserves unity bits', () => {
  const level = createLiveSpeechInputLevel({ sampleRate: 10 });
  const pcm = new Float32Array([-0, 1e-42, 0.25, 0.5, -0.75]);
  const bytes = new Uint8Array(pcm.buffer).slice();
  expect(level.process({ pcm, gain: 1, observe: false })).toBeUndefined();
  expect(new Uint8Array(pcm.buffer)).toEqual(bytes);
  expect(level.process({ pcm: new Float32Array(1), gain: 1, observe: true })).toBeUndefined();
});
