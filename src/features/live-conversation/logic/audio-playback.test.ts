import { describe, expect, it, vi } from 'vitest';
import { createLivePlayback } from './audio-playback';
import { liveAudioBrowserFixture } from './audio-browser.test-support';

describe('live playback bounded independent lifecycle', () => {
  it('copies samples, schedules them in order, and releases sources on end', async () => {
    using f = liveAudioBrowserFixture();
    const onPlaying = vi.fn();
    const player = createLivePlayback({ onPlaying });
    await using resource = {
      async [Symbol.asyncDispose]() {
        await player.close();
      },
    };
    await player.activate();
    player.begin();
    const pcm = new Float32Array([0.25, 0.5]);
    await player.append({ pcm, sampleRate: 24000 });
    pcm.fill(0);
    await player.append({ pcm: new Float32Array([0.1]), sampleRate: 24000 });
    expect(Array.from(f.buffers[0]!)).toEqual([0.25, 0.5]);
    expect(f.sourceNodes[1]?.start.mock.calls[0]?.[0]).toBeGreaterThan(f.sourceNodes[0]?.start.mock.calls[0]?.[0]);
    f.sourceNodes[0]?.onended?.();
    f.sourceNodes[1]?.onended?.();
    expect(onPlaying).toHaveBeenLastCalledWith({ playing: false });
    void resource;
  });

  it('stops a backpressured append without scheduling late audio', async () => {
    using f = liveAudioBrowserFixture();
    const player = createLivePlayback({ onPlaying: vi.fn() });
    await using resource = {
      async [Symbol.asyncDispose]() {
        await player.close();
      },
    };
    await player.activate();
    player.begin();
    await player.append({ pcm: new Float32Array(48000), sampleRate: 24000 });
    const waiting = player.append({ pcm: new Float32Array(100), sampleRate: 24000 });
    player.stop();
    await waiting;
    expect(f.sourceNodes).toHaveLength(1);
    expect(f.sourceNodes[0]?.stop).toHaveBeenCalledOnce();
    player.begin();
    await player.append({ pcm: new Float32Array(100), sampleRate: 24000 });
    expect(f.sourceNodes).toHaveLength(2);
    void resource;
  });

  it('mute changes the gain without reopening the model or audio device', async () => {
    using f = liveAudioBrowserFixture();
    const player = createLivePlayback({ onPlaying: vi.fn() });
    await using resource = {
      async [Symbol.asyncDispose]() {
        await player.close();
      },
    };
    await player.activate();
    player.mute({ value: 'off' });
    expect(f.contexts[0]?.createGain.mock.results[0]?.value.gain.value).toBe(0);
    player.mute({ value: 'on' });
    expect(f.contexts[0]?.createGain.mock.results[0]?.value.gain.value).toBe(1);
    expect(f.contexts).toHaveLength(1);
    void resource;
  });

  it('rejects suspended devices and refuses reuse after close', async () => {
    using f = liveAudioBrowserFixture();
    const player = createLivePlayback({ onPlaying: vi.fn() });
    await player.activate();
    player.begin();
f.contexts[0]!.state = 'suspended';
await expect(player.append({ pcm: new Float32Array(10), sampleRate: 24000 })).rejects.toThrow('active audio');
await player.close();
await player.close();
await expect(player.activate()).rejects.toThrow('closed');
expect(f.contexts[0]?.close).toHaveBeenCalledOnce();
  });
});
