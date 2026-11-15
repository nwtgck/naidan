import { expect, it } from 'vitest';
import { copySpeechFrame } from './audio-frame';

it('rejects invalid native output without forwarding it to playback', () => {
  expect(() => copySpeechFrame({ samples: new Float32Array(3), text: '', sequence: 0 })).toThrow();
  for (const invalid of [NaN, Infinity, -2]) {
    const samples = new Float32Array(3200);
    samples[0] = invalid;
    expect(() => copySpeechFrame({ samples, text: '', sequence: 0 })).toThrow();
  }
});
