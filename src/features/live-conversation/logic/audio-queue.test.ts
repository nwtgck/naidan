import { describe, expect, it, vi } from 'vitest';
import { createLiveAudioQueue } from './audio-queue';

describe('bounded microphone transport', () => {
  it('sends copied samples in sequence and waits for the final acknowledgement', async () => {
    const gate = Promise.withResolvers<void>();
    const send = vi.fn(async () => {
      await gate.promise;
    });
    const queue = createLiveAudioQueue({ maximumSamples: 8, send, onError: vi.fn() });
    const pcm = new Float32Array([0.5, 0.25]);
    queue.push({ pcm });
    pcm[0] = 0;
    queue.push({ pcm: new Float32Array([0.7]) });
    let ended = false;
    const done = queue.finish().then(() => {
      ended = true;
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenNthCalledWith(1, { pcm: new Float32Array([0.5, 0.25]), sequence: 0 });
    expect(ended).toBe(false);
    gate.resolve();
    await done;
    expect(send).toHaveBeenNthCalledWith(2, { pcm: new Float32Array([0.7]), sequence: 1 });
    queue.push({ pcm });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('makes overflow explicit and never silently drops a middle chunk', async () => {
    const send = vi.fn(async () => {});
    const onError = vi.fn();
    const queue = createLiveAudioQueue({ maximumSamples: 2, send, onError });
    queue.push({ pcm: new Float32Array(2) });
    queue.push({ pcm: new Float32Array(1) });
    await expect(queue.finish()).rejects.toThrow('cannot keep up');
    expect(send).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('stops subsequent uploads after a native rejection', async () => {
    const send = vi.fn(async () => {
      throw new Error('encoder');
    });
    const onError = vi.fn();
    const queue = createLiveAudioQueue({ maximumSamples: 10, send, onError });
    queue.push({ pcm: new Float32Array(2) });
    queue.push({ pcm: new Float32Array(2) });
    await expect(queue.finish()).rejects.toThrow('encoder');
    expect(send).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('discard waits for in-flight input before allowing rollback', async () => {
    const gate = Promise.withResolvers<void>();
    const send = vi.fn(async () => gate.promise);
    const queue = createLiveAudioQueue({ maximumSamples: 10, send, onError: vi.fn() });
    queue.push({ pcm: new Float32Array(1) });
    queue.push({ pcm: new Float32Array(1) });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    let done = false;
    const discarded = queue.discard().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    gate.resolve();
    await discarded;
    expect(send).toHaveBeenCalledOnce();
  });
});
