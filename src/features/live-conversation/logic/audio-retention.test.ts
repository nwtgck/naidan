import { describe, expect, it, vi } from 'vitest';
import { createLiveAudioRetention } from './audio-retention';

function retainedFixture({ maximumBytes }: { maximumBytes: number }) {
  const blobs: Blob[] = [];
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
    blobs.push(blob as Blob);
    return `blob:retained-${blobs.length}`;
  });
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const retained = createLiveAudioRetention({ maximumBytes });
  return {
    retained,
    blobs,
    create,
    revoke,
    [Symbol.dispose]() {
      retained.clear();
      create.mockRestore();
      revoke.mockRestore();
    },
  };
}

async function bytes({ blob }: { blob: Blob }): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error('Not bytes'));
    reader.readAsArrayBuffer(blob);
  });
}

describe('opt-in ephemeral audio replays', () => {
  it('retains nothing by default', () => {
    using f = retainedFixture({ maximumBytes: 1024 });
    expect(f.retained.isEnabled()).toBe(false);
    expect(f.retained.append({ key: 'input', sampleRate: 16000, pcm: new Float32Array([0.5]) })).toBe('skipped');
    expect(f.retained.finish({ key: 'input', status: 'complete' })).toBeUndefined();
    expect(f.create).not.toHaveBeenCalled();
  });

  it('copies PCM and produces a little-endian float WAV without changing amplitude', async () => {
    using f = retainedFixture({ maximumBytes: 1024 });
    f.retained.setEnabled({ value: 'on' });
    const pcm = new Float32Array([0.5, -0.25]);
    f.retained.append({ key: 'input', sampleRate: 16000, pcm });
    pcm.fill(0);
    const clip = f.retained.finish({ key: 'input', status: 'complete' });
    expect(clip).toEqual({ url: 'blob:retained-1', sampleRate: 16000, seconds: 2 / 16000, status: 'complete' });
    const data = new DataView(await bytes({ blob: f.blobs[0]! }));
    expect(data.byteLength).toBe(52);
    expect(data.getUint16(20, true)).toBe(3);
    expect(data.getUint32(24, true)).toBe(16000);
    expect(data.getFloat32(44, true)).toBe(0.5);
    expect(data.getFloat32(48, true)).toBe(-0.25);
    expect(f.retained.finish({ key: 'input', status: 'partial' })).toMatchObject({ status: 'partial', url: clip?.url });
    expect(f.create).toHaveBeenCalledOnce();
  });

  it('drops the entire overflowing clip rather than labeling truncated audio complete', () => {
    using f = retainedFixture({ maximumBytes: 52 });
    f.retained.setEnabled({ value: 'on' });
    expect(f.retained.append({ key: 'input', sampleRate: 16000, pcm: new Float32Array(2) })).toBe('kept');
    expect(f.retained.append({ key: 'input', sampleRate: 16000, pcm: new Float32Array(1) })).toBe('limit');
    expect(f.retained.finish({ key: 'input', status: 'complete' })).toBeUndefined();
    expect(f.retained.append({ key: 'input', sampleRate: 16000, pcm: new Float32Array(1) })).toBe('limit');
    expect(f.retained.append({ key: 'next', sampleRate: 24000, pcm: new Float32Array(2) })).toBe('kept');
  });

  it('revokes completed URLs and pending PCM on disable and does not resurrect them', () => {
    using f = retainedFixture({ maximumBytes: 1024 });
    f.retained.setEnabled({ value: 'on' });
    for (const key of ['input', 'output']) {
      f.retained.append({ key, sampleRate: 16000, pcm: new Float32Array(2) });
    }
    f.retained.finish({ key: 'input', status: 'complete' });
    f.retained.setEnabled({ value: 'off' });
    expect(f.revoke).toHaveBeenCalledWith('blob:retained-1');
    f.retained.setEnabled({ value: 'on' });
    expect(f.retained.finish({ key: 'input', status: 'complete' })).toBeUndefined();
    expect(f.retained.finish({ key: 'output', status: 'complete' })).toBeUndefined();
    f.retained.clear();
    expect(f.revoke).toHaveBeenCalledOnce();
  });

  it('rejects changes of sample rate and writes after finalization', () => {
    using f = retainedFixture({ maximumBytes: 1024 });
    f.retained.setEnabled({ value: 'on' });
    f.retained.append({ key: 'a', sampleRate: 16000, pcm: new Float32Array(2) });
    expect(() => f.retained.append({ key: 'a', sampleRate: 24000, pcm: new Float32Array(1) })).toThrow();
    f.retained.finish({ key: 'a', status: 'complete' });
    expect(() => f.retained.append({ key: 'a', sampleRate: 16000, pcm: new Float32Array(1) })).toThrow();
  });
});
