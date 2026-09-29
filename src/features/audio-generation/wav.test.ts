import { describe, expect, it } from 'vitest';
import { validateAudioWav } from './wav';
import { audioResult } from './test-utils/wav';

describe('native audio output validation', () => {
  it('accepts mono PCM16 and a nonzero typed-array offset', () => {
    const expected = audioResult(); const backing = new Uint8Array(expected.wav.length + 12);
    backing.set(expected.wav, 7);
    expect(() => validateAudioWav({ ...expected, wav: backing.subarray(7, 7 + expected.wav.length) })).not.toThrow();
  });
  it('permits padded extra chunks rather than assuming a 44-byte header', () => {
    const expected = audioResult(); const wav = new Uint8Array(expected.wav.length + 10);
    wav.set(expected.wav.subarray(0, 12)); wav.set(new TextEncoder().encode('JUNK'), 12);
    const view = new DataView(wav.buffer); view.setUint32(16, 1, true); wav[20] = 7;
    wav.set(expected.wav.subarray(12), 22); view.setUint32(4, wav.length - 8, true);
    expect(() => validateAudioWav({ ...expected, wav })).not.toThrow();
  });
  it.each([0, 4, 8, 16, 20, 22, 24, 28, 32, 34, 36, 40])('rejects corrupt container or PCM metadata at %i', offset => {
    const result = audioResult(); result.wav[offset] = 255;
    expect(() => validateAudioWav(result)).toThrow();
  });
  it('rejects sample-count mismatches, a short container and trailing data', () => {
    const result = audioResult();
    expect(() => validateAudioWav({ ...result, samples: result.samples + 1 })).toThrow();
    expect(() => validateAudioWav({ ...result, wav: result.wav.subarray(0, 8) })).toThrow();
    expect(() => validateAudioWav({ ...result, wav: new Uint8Array([...result.wav, 0]) })).toThrow();
  });
});
