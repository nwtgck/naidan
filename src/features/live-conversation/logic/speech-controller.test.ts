import { describe, expect, it, vi } from 'vitest';
import { createLiveSpeechFixture } from './speech-controller.test-support';

const file = new File(['model'], 'model.gguf');
const options = { maxSeconds: 60, language: 'en', persona: undefined, name: undefined };

describe('continuous live speech session', () => {
  it('accepts output emitted while the native session is still starting', async () => {
    await using f = createLiveSpeechFixture();
    await f.controller.load({ file });
    vi.mocked(f.client.start).mockImplementation(async () => {
      f.change({ state: { phase: 'starting' } });
      f.frame({ text: 'Early response', samples: new Float32Array([0.2]) });
      f.change({ state: { phase: 'running' } });
    });
    await f.controller.start(options);
    await Promise.resolve();
    expect(f.controller.getState().sessions[0]?.text).toBe('Early response');
    expect(f.player.append).toHaveBeenCalledOnce();
  });

  it('records and plays together and keeps frame text including spaces', async () => {
    await using f = createLiveSpeechFixture();
    await f.controller.load({ file });
    await f.controller.start(options);
    f.pcm({ samples: new Float32Array([0.25]) });
    f.frame({ text: 'Hello', samples: new Float32Array([0.5]) });
    f.frame({ text: ' ', samples: new Float32Array() });
    f.frame({ text: 'there', samples: new Float32Array() });
    await Promise.resolve();
    expect(f.client.push).toHaveBeenCalledWith({ samples: new Float32Array([0.25]), sampleRate: 24000 });
    expect(f.player.append).toHaveBeenCalledWith({ pcm: new Float32Array([0.5]), sampleRate: 24000 });
    expect(f.controller.getState().capture).toBe('open');
    expect(f.capture.mock.calls[0]?.[0].signal.aborted).toBe(false);
    expect(f.controller.getState().sessions[0]?.text).toBe('Hello there');
  });

  it('mutes microphone samples independently of playback and the running session', async () => {
    await using f = createLiveSpeechFixture();
    await f.controller.load({ file });
    f.controller.mutePlayback({ value: 'off' });
    await f.controller.start(options);
    expect(f.player.mute).toHaveBeenCalledWith({ value: 'off' });
    f.controller.muteMicrophone({ value: 'off' });
    f.pcm({ samples: new Float32Array([0.7, -0.5]) });
    expect(f.client.push).toHaveBeenLastCalledWith({ samples: new Float32Array(2), sampleRate: 24000 });
    expect(f.client.stop).not.toHaveBeenCalled();
    expect(f.capture.mock.calls[0]?.[0].signal.aborted).toBe(false);
  });

  it('cancels visibly on input backpressure instead of dropping microphone audio', async () => {
    await using f = createLiveSpeechFixture();
    await f.controller.load({ file });
    await f.controller.start(options);
    vi.mocked(f.client.push).mockReturnValue({ kind: 'backpressure' });
    f.pcm({ samples: new Float32Array([0.7]) });
    await Promise.resolve();
    expect(f.controller.getState().warning).toBe('input-backpressure');
    expect(f.client.stop).toHaveBeenCalledWith({ mode: 'cancel' });
    expect(f.capture.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it('bounds output audio while playback is delayed', async () => {
    await using f = createLiveSpeechFixture();
    await f.controller.load({ file });
    await f.controller.start(options);
    const wait = Promise.withResolvers<void>();
    f.player.append.mockImplementation(() => wait.promise);
    f.frame({ text: '', samples: new Float32Array(24000 * 3) });
    f.frame({ text: '', samples: new Float32Array(24000 * 2) });
    expect(f.controller.getState().warning).toBe('output-backpressure');
    expect(f.client.stop).toHaveBeenCalledWith({ mode: 'cancel' });
    wait.resolve();
  });

  it('releases microphone on max_seconds completion and keeps the loaded model', async () => {
    await using f = createLiveSpeechFixture();
    await f.controller.load({ file });
    await f.controller.start(options);
    f.change({ state: { phase: 'completed', completion: 'max_seconds' } });
    expect(f.capture.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(f.controller.getState().sessions[0]?.completion).toBe('max_seconds');
    expect(f.client.releaseModel).not.toHaveBeenCalled();
    await f.controller.start(options);
    expect(f.client.start).toHaveBeenCalledTimes(2);
  });

  it('cancels pending microphone permission before it can start a session', async () => {
    await using f = createLiveSpeechFixture();
    await f.controller.load({ file });
    const permission = Promise.withResolvers<{ finish: typeof f.finish }>();
    f.capture.mockImplementation(() => permission.promise);
    const starting = f.controller.start(options);
    expect(f.controller.getState().capture).toBe('opening');
    await f.controller.stop({ mode: 'cancel' });
    permission.resolve({ finish: f.finish });
    await starting;
    expect(f.client.start).not.toHaveBeenCalled();
    expect(f.controller.getState().failure).toBeUndefined();
  });

  it('keeps detailed native failures and releases both devices on model release', async () => {
    await using f = createLiveSpeechFixture();
    await f.controller.load({ file });
    await f.controller.start(options);
    const failure = { code: 'runtime_failed' as const, message: 'Native failed', nativeStatus: -42, nativeInput: 'decode' };
    f.change({ state: { phase: 'failed', failure } });
    expect(f.controller.getState().failure).toEqual(failure);
    expect(f.player.stop).toHaveBeenCalled();
    await f.controller.release();
    expect(f.client.releaseModel).toHaveBeenCalledOnce();
    expect(f.player.close).toHaveBeenCalledOnce();
  });
});
