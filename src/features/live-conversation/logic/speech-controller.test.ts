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
    expect(f.client.start).toHaveBeenCalledWith({ options: { ...options, inputSampleRate: 24000, seed: undefined } });
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

  it('runs the file through the loaded client without opening either audio device and frees WAV URLs on the next run', async () => {
    using urls = {
      create: vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:speech-run'),
      revoke: vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}),
      [Symbol.dispose]() {
        this.create.mockRestore();
        this.revoke.mockRestore();
      },
    };
    await using f = createLiveSpeechFixture();
    await f.controller.load({ file });
    vi.mocked(f.client.start).mockImplementation(async () => {
      f.change({ state: { phase: 'starting' } });
      f.frame({ text: 'Initial', samples: new Float32Array(3200).fill(0.001) });
      f.change({ state: { phase: 'running' } });
    });
    const run = { ...options, file: new File(['source'], 'greeting.wav'), tailSeconds: 0, seed: 0 };
    await f.controller.runFile(run);
    expect(f.controller.getState()).toMatchObject({ fileRun: { status: 'complete', text: 'Initial', frames: 1, sourceSamples: 1, submittedSamples: 3200, input: { status: 'complete' }, output: { status: 'complete' } }, sessions: [] });
    expect(f.client.push).toHaveBeenCalledWith({ sampleRate: 24000, samples: new Float32Array([0.5, ...new Float32Array(3199)]) });
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.playback).not.toHaveBeenCalled();
    expect(f.client.releaseModel).not.toHaveBeenCalled();
    await f.controller.runFile(run);
    expect(urls.revoke).toHaveBeenCalledTimes(2);
    expect(f.client.loadModel).toHaveBeenCalledOnce();
    await f.controller.reset();
    expect(f.controller.getState().fileRun?.output).toBeDefined();
    expect(urls.revoke).toHaveBeenCalledTimes(2);
    await f.controller.release();
    expect(urls.revoke).toHaveBeenCalledTimes(4);
    expect(f.controller.getState().fileRun).toBeUndefined();
  });

  it('cancels file decoding on release without starting a late session and retains no URLs after disposal', async () => {
    await using f = createLiveSpeechFixture();
    await f.controller.load({ file });
    const decode = Promise.withResolvers<Float32Array>();
    f.decodeFile.mockReturnValue(decode.promise);
    const running = f.controller.runFile({ ...options, file: new File(['source'], 'greeting.wav'), tailSeconds: 5, seed: 0 });
    await vi.waitFor(() => expect(f.decodeFile).toHaveBeenCalledOnce());
    await f.controller.start(options);
    expect(f.capture).not.toHaveBeenCalled();
    await f.controller.release();
    await running;
    decode.resolve(new Float32Array(3200));
    await Promise.resolve();
    expect(f.client.start).not.toHaveBeenCalled();
    expect(f.controller.getState().fileRun).toBeUndefined();
    expect(f.client.releaseModel).toHaveBeenCalledOnce();
  });

  it('keeps diagnostic text and result clearing independent of live conversation history', async () => {
    using urls = {
      create: vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:diagnostic'),
      revoke: vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}),
      [Symbol.dispose]() {
        this.create.mockRestore();
        this.revoke.mockRestore();
      },
    };
    await using f = createLiveSpeechFixture();
    await f.controller.load({ file });
    await f.controller.start(options);
    f.frame({ text: 'Live response', samples: new Float32Array() });
    await f.controller.stop({ mode: 'finish' });
    const history = f.controller.getState().sessions.map(session => ({ ...session }));
    vi.mocked(f.client.start).mockImplementation(async () => {
      f.change({ state: { phase: 'starting' } });
      f.frame({ text: 'Diagnostic response', samples: new Float32Array(3200) });
      f.change({ state: { phase: 'running' } });
    });
    await f.controller.runFile({ ...options, file: new File(['source'], 'greeting.wav'), tailSeconds: 0, seed: 0 });
    expect(f.controller.getState().fileRun?.text).toBe('Diagnostic response');
    expect(f.controller.getState().sessions).toEqual(history);
    const clearing = f.controller.clearFileRun();
    expect(f.controller.getState().fileRun).toBeUndefined();
    expect(urls.revoke).toHaveBeenCalledTimes(2);
    await clearing;
    expect(f.controller.getState().sessions).toEqual(history);
    expect(f.client.releaseModel).not.toHaveBeenCalled();
  });
});
