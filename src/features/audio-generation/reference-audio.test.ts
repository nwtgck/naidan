import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_REFERENCE_SAMPLES, normalizeReferenceAudio, prepareReferenceAudio } from './reference-audio';
import { MAX_REFERENCE_BYTES } from './types';
import { validateAudioWav } from './wav';
import { readBlobBytes, referenceFile } from './test-utils/blob';
const decode = vi.fn<OfflineAudioContext['decodeAudioData']>();
const constructed = vi.fn();
function decodedAudio({ channels, length }: { channels: number[][], length: number }): AudioBuffer {
  return { length, sampleRate: 24000, numberOfChannels: channels.length, getChannelData: (index: number) => Float32Array.from(channels[index]!) } as AudioBuffer;
}
beforeEach(() => {
  decode.mockReset(); constructed.mockReset();
  vi.stubGlobal('OfflineAudioContext', class {
    constructor(...args: unknown[]) {
      constructed(...args);
    }
    decodeAudioData = decode;
  });
});
afterEach(() => vi.unstubAllGlobals());
describe('frontend reference preparation', () => {
  it('uses no decoder for no selection or a single existing native-format file', async () => {
    vi.stubGlobal('OfflineAudioContext', undefined);
    expect(await prepareReferenceAudio({ sources: [], signal: undefined })).toBeUndefined();
    for (const name of ['voice.wav', 'voice.MP3', 'voice.flac']) {
      const file = referenceFile({ name });
      expect(await prepareReferenceAudio({ sources: [file], signal: undefined })).toBe(file);
    }
    expect(decode).not.toHaveBeenCalled();
  });
  it('converts browser-only containers to mono PCM16 WAV without playing the audio', async () => {
    decode.mockResolvedValueOnce(decodedAudio({ channels: [[1, 0.5, -1], [0, -0.5, -1]], length: 3 }));
    const result = await normalizeReferenceAudio({ source: referenceFile({ name: 'recording.webm' }), signal: undefined, durationPolicy: 'reject' });
    const wav = await readBlobBytes({ blob: result.wav }); validateAudioWav({ wav, samples: 3, sampleRate: 24000 });
    const data = new DataView(wav.buffer);
    expect([data.getInt16(44, true), data.getInt16(46, true), data.getInt16(48, true)]).toEqual([16384, 0, -32767]);
    expect(result.trimmed).toBe(false); expect(constructed).toHaveBeenCalledWith(1, 1, 24000);
  });
  it('concatenates selections in order rather than overlaying their samples', async () => {
    decode.mockResolvedValueOnce(decodedAudio({ channels: [[0.25, 0.5]], length: 2 }));
    decode.mockResolvedValueOnce(decodedAudio({ channels: [[-0.5]], length: 1 }));
    const joined = await prepareReferenceAudio({ sources: [referenceFile({ name: 'one.wav' }), referenceFile({ name: 'two.wav' })], signal: undefined });
    const wav = await readBlobBytes({ blob: joined! }); validateAudioWav({ wav, samples: 3, sampleRate: 24000 });
    const data = new DataView(wav.buffer);
    expect([data.getInt16(44, true), data.getInt16(46, true), data.getInt16(48, true)]).toEqual([8192, 16384, -16383]);
  });
  it('normalizes even a single browser-only file, and errors do not silently omit it', async () => {
    decode.mockResolvedValueOnce(decodedAudio({ channels: [[0.25]], length: 1 }));
    expect((await prepareReferenceAudio({ sources: [referenceFile({ name: 'one.webm' })], signal: undefined }))?.type).toBe('audio/wav');
    decode.mockRejectedValueOnce(new Error('decoder failure'));
    await expect(prepareReferenceAudio({ sources: [referenceFile({ name: 'bad.webm' })], signal: undefined })).rejects.toMatchObject({ code: 'decode' });
  });
  it('rejects empty/oversize input before decoding', async () => {
    const empty = new Blob([]); const large = new Blob(['x']); Object.defineProperty(large, 'size', { value: MAX_REFERENCE_BYTES + 1 });
    await expect(normalizeReferenceAudio({ source: empty, signal: undefined, durationPolicy: 'reject' })).rejects.toMatchObject({ code: 'empty' });
    await expect(normalizeReferenceAudio({ source: large, signal: undefined, durationPolicy: 'reject' })).rejects.toMatchObject({ code: 'too-large' });
    expect(decode).not.toHaveBeenCalled();
  });
  it('rejects unsupported browser decoding but preserves native single-file use', async () => {
    vi.stubGlobal('OfflineAudioContext', undefined);
    await expect(prepareReferenceAudio({ sources: [referenceFile({ name: 'one.webm' })], signal: undefined })).rejects.toMatchObject({ code: 'unavailable' });
    const file = referenceFile({ name: 'one.wav' }); expect(await prepareReferenceAudio({ sources: [file], signal: undefined })).toBe(file);
  });
  it('enforces the total duration of multiple clips without trimming', async () => {
    const length = MAX_REFERENCE_SAMPLES / 2 + 1;
    const buffer = { length, sampleRate: 24000, numberOfChannels: 1, getChannelData: () => new Float32Array(length) } as unknown as AudioBuffer;
    decode.mockResolvedValue(buffer);
    await expect(prepareReferenceAudio({ sources: [referenceFile({ name: 'one.wav' }), referenceFile({ name: 'two.wav' })], signal: undefined })).rejects.toMatchObject({ code: 'too-long' });
  });
  it('rejects excessive file duration, but explicitly caps recordings after a delayed stop', async () => {
    const length = MAX_REFERENCE_SAMPLES + 7;
    const buffer = { length, sampleRate: 24000, numberOfChannels: 1, getChannelData: () => new Float32Array(length) } as unknown as AudioBuffer;
    decode.mockResolvedValue(buffer);
    const source = referenceFile({ name: 'long.webm' });
    await expect(normalizeReferenceAudio({ source, signal: undefined, durationPolicy: 'reject' })).rejects.toMatchObject({ code: 'too-long' });
    const result = await normalizeReferenceAudio({ source, signal: undefined, durationPolicy: 'limit-recording' });
    expect(result.samples).toBe(MAX_REFERENCE_SAMPLES); expect(result.trimmed).toBe(true);
    validateAudioWav({ wav: await readBlobBytes({ blob: result.wav }), sampleRate: 24000, samples: MAX_REFERENCE_SAMPLES });
  });
  it('does not publish decoding that completes after cancellation', async () => {
    const controller = new AbortController(); const pending = Promise.withResolvers<AudioBuffer>(); decode.mockReturnValueOnce(pending.promise);
    const result = prepareReferenceAudio({ sources: [referenceFile({ name: 'one.webm' })], signal: controller.signal });
    await Promise.resolve(); controller.abort(); pending.resolve(decodedAudio({ channels: [[0]], length: 1 }));
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('does not begin reads after cancellation, including the native fast path', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(prepareReferenceAudio({ sources: [referenceFile({ name: 'one.wav' })], signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(decode).not.toHaveBeenCalled();
  });
  it('rejects nonfinite decoded audio', async () => {
    decode.mockResolvedValueOnce(decodedAudio({ channels: [[NaN]], length: 1 }));
    await expect(normalizeReferenceAudio({ source: referenceFile({ name: 'one.webm' }), signal: undefined, durationPolicy: 'reject' })).rejects.toMatchObject({ code: 'decode' });
  });
});
