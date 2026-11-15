import { describe, expect, it, vi } from 'vitest';
import { openLiveCapture } from './audio-capture';
import { liveAudioBrowserFixture } from './audio-browser.test-support';

describe('live microphone lifecycle', () => {
  it.each(['suspended', 'interrupted', 'closed'] as const)('reports a ready capture context becoming %s and stops forwarding PCM', async state => {
    using f = liveAudioBrowserFixture();
    f.permission.resolve(f.stream);
    const onError = vi.fn(), onPcm = vi.fn();
    const capture = await openLiveCapture({ sampleRate: 24000, signal: new AbortController().signal, onPcm, onError });
    f.contexts[0]!.changeState({ state });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith({ error: expect.objectContaining({ message: `Live microphone audio context is ${state}` }) });
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.contexts[0]?.close).toHaveBeenCalledOnce();
    expect(f.nodes[0]?.port.close).toHaveBeenCalledOnce();
    f.nodes[0]!.deliver({ data: { type: 'pcm', pcm: new Float32Array(2048) } });
    f.contexts[0]!.changeState({ state: 'running' });
    await capture.finish({ action: 'discard' });
    expect(onPcm).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(f.contexts[0]?.onstatechange).toBeNull();
  });

  it('waits for initial resume without treating its suspended state as a capture interruption', async () => {
    using f = liveAudioBrowserFixture();
    const resumed = Promise.withResolvers<void>();
    f.resume.mockReturnValue(resumed.promise);
    const onError = vi.fn();
    const opening = openLiveCapture({ sampleRate: 24000, signal: new AbortController().signal, onPcm: vi.fn(), onError });
    f.contexts[0]!.changeState({ state: 'suspended' });
    f.permission.resolve(f.stream);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.contexts[0]?.audioWorklet.addModule).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(f.track.stop).not.toHaveBeenCalled();
    resumed.resolve();
    const capture = await opening;
    await capture.finish({ action: 'discard' });
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(['abort', 'discard', 'send'] as const)('does not report its intentional close during %s as an interruption', async action => {
    using f = liveAudioBrowserFixture();
    f.permission.resolve(f.stream);
    const controller = new AbortController(), onError = vi.fn();
    const capture = await openLiveCapture({ sampleRate: 24000, signal: controller.signal, onPcm: vi.fn(), onError });
    switch (action) {
    case 'abort': controller.abort();
      break;
    case 'discard': case 'send': await capture.finish({ action });
      break;
    default: {
      const exhaustive: never = action;
      throw new Error(String(exhaustive));
    }
    }
    expect(f.contexts[0]?.close).toHaveBeenCalledOnce();
    expect(f.contexts[0]?.onstatechange).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('closes the AudioContext when resampler configuration fails', async () => {
    using f = liveAudioBrowserFixture();
    await expect(openLiveCapture({ sampleRate: 0, signal: new AbortController().signal, onPcm: vi.fn(), onError: vi.fn() })).rejects.toThrow();
    expect(f.contexts[0]?.close).toHaveBeenCalledOnce();
    expect(f.nodes).toHaveLength(0);
  });

  it('starts resume before permission and stops a late permission after abort', async () => {
    using f = liveAudioBrowserFixture();
    const controller = new AbortController();
    const opening = openLiveCapture({ sampleRate: 16000, signal: controller.signal, onPcm: vi.fn(), onError: vi.fn() });
    expect(f.contexts[0]?.resume).toHaveBeenCalledOnce();
    controller.abort();
    await expect(opening).rejects.toThrow();
    f.permission.resolve(f.stream);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.contexts[0]?.close).toHaveBeenCalledOnce();
    expect(f.nodes).toHaveLength(0);
  });

  it('resamples validated packets and flushes the tail before closing', async () => {
    using f = liveAudioBrowserFixture();
    const controller = new AbortController();
    const chunks: Float32Array[] = [];
    f.permission.resolve(f.stream);
    const capture = await openLiveCapture({ sampleRate: 16000, signal: controller.signal, onPcm: ({ pcm }) => chunks.push(pcm), onError: vi.fn() });
    await using resource = {
      async [Symbol.asyncDispose]() {
        await capture.finish({ action: 'discard' });
      },
    };
    f.nodes[0]!.deliver({ data: { type: 'pcm', pcm: new Float32Array(960).fill(0.25) } });
    await capture.finish({ action: 'send' });
    expect(chunks.reduce((sum, pcm) => sum + pcm.length, 0)).toBe(320);
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.nodes[0]?.port.close).toHaveBeenCalledOnce();
    expect(f.revokeUrl).toHaveBeenCalledWith('blob:live-audio-test');
    void resource;
  });

  it('fails closed on malformed worklet packets', async () => {
    using f = liveAudioBrowserFixture();
    f.permission.resolve(f.stream);
    const onError = vi.fn();
    const onPcm = vi.fn();
    const capture = await openLiveCapture({ sampleRate: 16000, signal: new AbortController().signal, onPcm, onError });
    await using resource = {
      async [Symbol.asyncDispose]() {
        await capture.finish({ action: 'discard' });
      },
    };
    f.nodes[0]!.deliver({ data: { type: 'pcm', pcm: new Float32Array([NaN]) } });
    expect(onError).toHaveBeenCalledOnce();
    expect(onPcm).not.toHaveBeenCalled();
    expect(f.track.stop).toHaveBeenCalledOnce();
    void resource;
  });

  it('closes tracks and the context on module load failure', async () => {
    using f = liveAudioBrowserFixture();
    const controller = new AbortController();
    const opening = openLiveCapture({ sampleRate: 16000, signal: controller.signal, onPcm: vi.fn(), onError: vi.fn() });
    f.contexts[0]!.audioWorklet.addModule.mockRejectedValue(new Error('worklet failed'));
    f.permission.resolve(f.stream);
    await expect(opening).rejects.toThrow('worklet failed');
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.contexts[0]?.close).toHaveBeenCalledOnce();
    expect(f.revokeUrl).toHaveBeenCalledOnce();
  });

  it('reports disconnected microphones and never flushes a discarded recording', async () => {
    using f = liveAudioBrowserFixture();
    f.permission.resolve(f.stream);
    const onError = vi.fn();
    const capture = await openLiveCapture({ sampleRate: 16000, signal: new AbortController().signal, onPcm: vi.fn(), onError });
    f.track.onended?.();
    await capture.finish({ action: 'discard' });
    await capture.finish({ action: 'discard' });
    expect(onError).toHaveBeenCalledOnce();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.nodes[0]?.port.postMessage).not.toHaveBeenCalled();
  });
});
