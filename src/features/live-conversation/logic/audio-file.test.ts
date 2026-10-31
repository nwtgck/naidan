import { describe, expect, it, vi } from 'vitest';
import { createLiveAudioMeter, decodeLiveAudioFile, liveAudioFileLimit } from './audio-file';

function decoderFixture() {
  const left = new Float32Array([0.25, -0.5, 0.9]);
  const right = new Float32Array([0.75, 0.5, 0.9]);
  const decoded = { sampleRate: 16000, length: 3, numberOfChannels: 2, getChannelData: vi.fn((index: number) => [left, right][index]!) };
  const decode = vi.fn(async (_bytes: ArrayBuffer) => decoded);
  const constructed = vi.fn();
  class Context {
    decodeAudioData = decode;

    constructor(channels: number, length: number, rate: number) {
      constructed(channels, length, rate);
    }
  }
  vi.stubGlobal('OfflineAudioContext', Context);
  const file = new Blob(['encoded audio']);
  // jsdom has no Blob.arrayBuffer; keep the browser Blob type and supply this
  // test-local read, without changing production data boundaries.
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(13) });
  const abort = new AbortController();
  return {
    left,
    right,
    decoded,
    decode,
    constructed,
    file,
    abort,
    [Symbol.dispose]() {
      vi.unstubAllGlobals();
    },
  };
}

describe('live file input shares the model PCM format', () => {
  it('uses the model sample rate and averages channels without loudness normalization', async () => {
    using f = decoderFixture();
    const pcm = await decodeLiveAudioFile({ file: f.file, sampleRate: 16000, signal: f.abort.signal });
    expect(f.constructed).toHaveBeenCalledWith(1, 1, 16000);
    expect(pcm).toEqual(new Float32Array([0.5, 0, 0.9]));
    expect(f.left[0]).toBe(0.25);
  });

  it('rejects an empty or oversized source before decoding', async () => {
    using f = decoderFixture();
    for (const file of [new Blob(), new Blob([new Uint8Array(liveAudioFileLimit + 1)])]) {
      await expect(decodeLiveAudioFile({ file, sampleRate: 16000, signal: f.abort.signal })).rejects.toThrow('16 MiB');
    }
    expect(f.decode).not.toHaveBeenCalled();
  });

  it('rejects cancellation before and after a pending decode', async () => {
    using f = decoderFixture();
    const gate = Promise.withResolvers<typeof f.decoded>();
    f.decode.mockReturnValue(gate.promise);
    const task = decodeLiveAudioFile({ file: f.file, sampleRate: 16000, signal: f.abort.signal });
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledOnce());
    f.abort.abort();
    gate.resolve(f.decoded);
    await expect(task).rejects.toThrow();
    await expect(decodeLiveAudioFile({ file: f.file, sampleRate: 16000, signal: f.abort.signal })).rejects.toThrow();
    expect(f.decode).toHaveBeenCalledOnce();
  });

  it.each([
    { sampleRate: 48000 }, { numberOfChannels: 0 }, { numberOfChannels: 33 },
    { length: 0 }, { length: 16000 * 180 + 1 }, { length: NaN },
  ])('rejects invalid decoded metadata %j', async metadata => {
    using f = decoderFixture();
    Object.assign(f.decoded, metadata);
    await expect(decodeLiveAudioFile({ file: f.file, sampleRate: 16000, signal: f.abort.signal })).rejects.toThrow();
  });

  it('bounds out-of-range samples and rejects non-finite samples', async () => {
    using f = decoderFixture();
    f.left[0] = 8;
    f.right[0] = 8;
    expect((await decodeLiveAudioFile({ file: f.file, sampleRate: 16000, signal: f.abort.signal }))[0]).toBe(1);
    f.left[1] = NaN;
    await expect(decodeLiveAudioFile({ file: f.file, sampleRate: 16000, signal: f.abort.signal })).rejects.toThrow('samples');
  });

  it('reports duration, peak, RMS and clipping for the actual submitted samples', () => {
    const meter = createLiveAudioMeter({ sampleRate: 16000 });
    expect(meter.read()).toMatchObject({ samples: 0, rms: 0 });
    meter.append({ pcm: new Float32Array([0, 0.5]) });
    meter.append({ pcm: new Float32Array([-1, 0.5]) });
    expect(meter.read()).toEqual({ sampleRate: 16000, samples: 4, seconds: 4 / 16000, peak: 1, rms: Math.sqrt(1.5 / 4), clippedSamples: 1 });
    expect(() => meter.append({ pcm: new Float32Array([Infinity]) })).toThrow();
  });
});
