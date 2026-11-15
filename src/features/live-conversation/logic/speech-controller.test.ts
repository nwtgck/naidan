import { describe, expect, it, vi } from 'vitest';
import { createLiveSpeechFixture } from './speech-controller.test-support';
import * as audioRetention from './audio-retention';
import * as audioFile from './audio-file';
import * as inputLevel from './speech-input-level';
import type { LiveAudioClip } from './audio-retention';

function retainedAudioFixture({ maximumBytes }: { maximumBytes: number }) {
  const create = audioRetention.createLiveAudioRetention;
  const stores: ReturnType<typeof create>[] = [];
  const factory = vi.spyOn(audioRetention, 'createLiveAudioRetention').mockImplementation(({ maximumBytes: requested }) => {
    expect(requested).toBe(64 * 1024 * 1024);
    const retained = create({ maximumBytes });
    vi.spyOn(retained, 'append');
    vi.spyOn(retained, 'finish');
    stores.push(retained);
    return retained;
  });
  const blobs = new Map<string, Blob>();
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
    if (!(blob instanceof Blob)) {
      throw new Error('Expected a retained WAV');
    }
    const url = `blob:live-speech-${blobs.size + 1}`;
    blobs.set(url, blob);
    return url;
  });
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  return {
    stores,
    blobs,
    createUrl,
    revokeUrl,
    factory,
    [Symbol.dispose]() {
      factory.mockRestore();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
    },
  };
}

async function retainedSamples({ clip, blobs }: { clip: LiveAudioClip | undefined, blobs: Map<string, Blob> }): Promise<number[]> {
  const blob = clip === undefined ? undefined : blobs.get(clip.url);
  if (blob === undefined) {
    throw new Error('Missing retained audio');
  }
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error('Expected WAV bytes'));
    reader.readAsArrayBuffer(blob);
  });
  const view = new DataView(bytes);
  expect(view.getUint16(20, true)).toBe(3);
  expect(view.getUint32(24, true)).toBe(24000);
  return Array.from({ length: (bytes.byteLength - 44) / 4 }, (_, index) => view.getFloat32(44 + index * 4, true));
}

const file = new File(['model'], 'model.gguf');
const options = { maxSeconds: 60, language: 'en', persona: undefined, name: undefined };

describe('continuous live speech session', () => {
  it('forwards a diagnostic file attempt and exposes its existing WAV Blobs without retaining late events', async () => {
    using urls = retainedAudioFixture({ maximumBytes: 64 * 1024 * 1024 });
    await using f = createLiveSpeechFixture();
    const observer = vi.fn(), context = { operationId: 'attempt', source: 'investigation' as const };
    const investigation = { context, observer }, event = { kind: 'wasm_heap' as const, capacityBytes: 65536 };
    await f.controller.load({ file, investigation });
    expect(f.client.loadModel).toHaveBeenCalledWith({ file, investigation: context });
    vi.mocked(f.client.start).mockImplementation(async () => {
      f.observe({ context, event });
      f.change({ state: { phase: 'starting' } });
      f.frame({ text: 'response', samples: new Float32Array(3200) });
      f.change({ state: { phase: 'running' } });
    });
    const args = { ...options, inputLevel: { kind: 'gain' as const, gain: 1 }, maximumRetainedAudioBytes: 64 * 1024 * 1024, file: new File(['source'], 'greeting.wav'), tailSeconds: 0, seed: 0, inputPacing: 'fast' as const };
    await f.controller.runFile({ ...args, investigation });
    expect(f.client.start).toHaveBeenCalledWith(expect.objectContaining({ investigation: context }));
    expect(observer).toHaveBeenCalledWith({ event });
    const run = f.controller.getState().fileRun!;
    const output = f.controller.getFileRunAudio({ id: run.id, role: 'output' });
    expect(output).toBe(urls.blobs.get(run.output!.url));
    expect(f.controller.getFileRunAudio({ id: 'another-run', role: 'output' })).toBeUndefined();
    f.observe({ context, event });
    expect(observer).toHaveBeenCalledOnce();
    await f.controller.clearFileRun();
    expect(f.controller.getFileRunAudio({ id: run.id, role: 'output' })).toBeUndefined();
    expect(output!.size).toBe(44 + 3200 * 4);
    await f.controller.runFile(args);
    expect(vi.mocked(f.client.start).mock.calls.at(-1)![0]).not.toHaveProperty('investigation');
    expect(observer).toHaveBeenCalledOnce();
  });

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
    f.controller.setInputGain({ gain: 8 });
    const run = { ...options, inputLevel: { kind: 'gain' as const, gain: 1 }, maximumRetainedAudioBytes: 64 * 1024 * 1024, file: new File(['source'], 'greeting.wav'), tailSeconds: 0, seed: 0, inputPacing: 'fast' as const };
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

  it('forwards an exhausted file audio budget without decoding or treating the limit as a runtime failure', async () => {
    await using f = createLiveSpeechFixture();
    await f.controller.load({ file });
    await f.controller.runFile({ ...options, inputLevel: { kind: 'gain', gain: 1 }, maximumRetainedAudioBytes: 0, file: new File(['source'], 'greeting.wav'), tailSeconds: 0, seed: 0, inputPacing: 'fast' });
    expect(f.controller.getState()).toMatchObject({ failure: undefined, fileRun: { status: 'partial', stage: 'finished', failure: undefined, audioRetention: { maximumBytes: 0, retainedBytes: 0, status: 'limit' }, input: undefined, output: undefined } });
    expect(f.decodeFile).not.toHaveBeenCalled();
    expect(f.client.start).not.toHaveBeenCalled();
    expect(f.client.getState().phase).toBe('ready');
    expect(f.client.releaseModel).not.toHaveBeenCalled();
  });

  it('cancels file decoding on release without starting a late session and retains no URLs after disposal', async () => {
    await using f = createLiveSpeechFixture();
    await f.controller.load({ file });
    const decode = Promise.withResolvers<Float32Array<ArrayBuffer>>();
    f.decodeFile.mockReturnValue(decode.promise);
    const running = f.controller.runFile({ ...options, inputLevel: { kind: 'gain' as const, gain: 1 }, maximumRetainedAudioBytes: 64 * 1024 * 1024, file: new File(['source'], 'greeting.wav'), tailSeconds: 5, seed: 0, inputPacing: 'fast' });
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
    await f.controller.runFile({ ...options, inputLevel: { kind: 'gain' as const, gain: 1 }, maximumRetainedAudioBytes: 64 * 1024 * 1024, file: new File(['source'], 'greeting.wav'), tailSeconds: 0, seed: 0, inputPacing: 'fast' });
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

describe('live microphone fixed input gain and opt-in level observation', () => {
  it('forwards unity PCM by identity without processing, meters, clocks, settings reads or state updates', async () => {
    const create = inputLevel.createLiveSpeechInputLevel;
    const process = vi.fn<ReturnType<typeof create>['process']>();
    using observation = {
      factory: vi.spyOn(inputLevel, 'createLiveSpeechInputLevel').mockImplementation(args => {
        const level = create(args);
        process.mockImplementation(level.process);
        return { reset: level.reset, process };
      }),
      [Symbol.dispose]() {
        this.factory.mockRestore();
      },
    };
    await using f = createLiveSpeechFixture();
    await f.controller.load({ file });
    await f.controller.start(options);
    using measurement = {
      meter: vi.spyOn(audioFile, 'createLiveAudioMeter'),
      clock: vi.spyOn(performance, 'now'),
      [Symbol.dispose]() {
        this.meter.mockRestore();
        this.clock.mockRestore();
      },
    };
    f.onChange.mockClear();
    const samples = new Float32Array([-0, 1e-42, 0.25]);
    f.pcm({ samples });
    expect(vi.mocked(f.client.push).mock.calls[0]![0].samples).toBe(samples);
    expect(Object.is(samples[0], -0)).toBe(true);
    expect(process).not.toHaveBeenCalled();
    expect(measurement.meter).not.toHaveBeenCalled();
    expect(measurement.clock).not.toHaveBeenCalled();
    expect(f.captureSettings).not.toHaveBeenCalled();
    expect(f.onChange).not.toHaveBeenCalled();
    void observation;
  });

  it('applies gain once in place while observation is off and applies mute before gain', async () => {
    await using f = createLiveSpeechFixture();
    f.controller.setInputGain({ gain: 8 });
    await f.controller.load({ file });
    await f.controller.start(options);
    using measurement = {
      meter: vi.spyOn(audioFile, 'createLiveAudioMeter'),
      [Symbol.dispose]() {
        this.meter.mockRestore();
      },
    };
    f.onChange.mockClear();
    const samples = new Float32Array([0.25, -0.25, 0.125, -0.125]);
    f.pcm({ samples });
    expect(vi.mocked(f.client.push).mock.calls[0]![0].samples).toBe(samples);
    expect(samples).toEqual(new Float32Array([1, -1, 1, -1]));
    expect(measurement.meter).not.toHaveBeenCalled();
    expect(f.captureSettings).not.toHaveBeenCalled();
    expect(f.onChange).not.toHaveBeenCalled();
    f.controller.muteMicrophone({ value: 'off' });
    const muted = new Float32Array([0.75, -0.75]);
    f.pcm({ samples: muted });
    expect(muted).toEqual(new Float32Array([0.75, -0.75]));
    expect(vi.mocked(f.client.push).mock.calls[1]![0].samples).toEqual(new Float32Array(2));
  });

  it('publishes sample-based half-second windows only while observed and clears them on gain change and completion', async () => {
    await using f = createLiveSpeechFixture();
    const settings = { autoGainControl: undefined, echoCancellation: true, noiseSuppression: false, sampleRate: 48000, channelCount: 1, latency: undefined };
    f.captureSettings.mockReturnValue(settings);
    f.controller.setInputGain({ gain: 2 });
    f.controller.observeInputLevel({ value: 'on' });
    await f.controller.load({ file });
    await f.controller.start(options);
    expect(f.captureSettings).toHaveBeenCalledOnce();
    expect(f.controller.getState().inputLevel.captureSettings).toBe(settings);
    f.onChange.mockClear();
    f.pcm({ samples: new Float32Array(11999).fill(0.25) });
    expect(f.onChange).not.toHaveBeenCalled();
    expect(f.controller.getState().inputLevel.window).toBeUndefined();
    f.pcm({ samples: new Float32Array([0.75]) });
    expect(f.onChange).toHaveBeenCalledOnce();
    expect(f.controller.getState().inputLevel.window).toMatchObject({ gain: 2, before: { samples: 12000, seconds: 0.5, peak: 0.75 }, after: { samples: 12000, seconds: 0.5, peak: 1, clippedSamples: 1 }, clippedSamples: 1 });
    f.controller.setInputGain({ gain: 0.5 });
    expect(f.controller.getState().inputLevel.window).toBeUndefined();
    f.pcm({ samples: new Float32Array(12000).fill(0.5) });
    expect(f.controller.getState().inputLevel.window).toMatchObject({ gain: 0.5, before: { rms: 0.5 }, after: { rms: 0.25 }, clippedSamples: 0 });
    f.controller.observeInputLevel({ value: 'off' });
    expect(f.controller.getState().inputLevel).toEqual({ gain: 0.5, observation: 'off', window: undefined, captureSettings: undefined });
    f.onChange.mockClear();
    f.pcm({ samples: new Float32Array(12000).fill(0.5) });
    expect(f.onChange).not.toHaveBeenCalled();
    f.controller.observeInputLevel({ value: 'on' });
    f.pcm({ samples: new Float32Array(12000).fill(0.5) });
    f.change({ state: { phase: 'completed', completion: 'max_seconds' } });
    expect(f.controller.getState().inputLevel).toEqual({ gain: 0.5, observation: 'on', window: undefined, captureSettings: undefined });
    expect(f.client.releaseModel).not.toHaveBeenCalled();
    const pushed = vi.mocked(f.client.push).mock.calls.length;
    f.pcm({ samples: new Float32Array(12000) });
    expect(vi.mocked(f.client.push).mock.calls).toHaveLength(pushed);
  });

  it('clears the previous level and unfinished samples when mute changes, then observes a pure silent window', async () => {
    await using f = createLiveSpeechFixture();
    f.controller.setInputGain({ gain: 2 });
    f.controller.observeInputLevel({ value: 'on' });
    await f.controller.load({ file });
    await f.controller.start(options);
    f.pcm({ samples: new Float32Array(12000).fill(0.25) });
    expect(f.controller.getState().inputLevel.window!.after.peak).toBe(0.5);
    f.pcm({ samples: new Float32Array(11999).fill(0.25) });
    f.controller.muteMicrophone({ value: 'off' });
    expect(f.controller.getState().inputLevel.window).toBeUndefined();
    f.pcm({ samples: new Float32Array([0.75]) });
    expect(f.controller.getState().inputLevel.window).toBeUndefined();
    f.pcm({ samples: new Float32Array(11999).fill(0.75) });
    expect(f.controller.getState().inputLevel.window).toMatchObject({ gain: 2, before: { samples: 12000, rms: 0, peak: 0 }, after: { samples: 12000, rms: 0, peak: 0 }, clippedSamples: 0 });
    f.controller.muteMicrophone({ value: 'on' });
    expect(f.controller.getState().inputLevel.window).toBeUndefined();
  });

  it.each([NaN, Infinity, -1, 0])('rejects invalid live gain %s without changing the previous setting', async gain => {
    await using f = createLiveSpeechFixture();
    expect(() => f.controller.setInputGain({ gain })).toThrow('finite positive');
    expect(f.controller.getState().inputLevel.gain).toBe(1);
  });
});

describe('opt-in live speech audio retention', () => {
  it('does not copy or encode retained audio while disabled', async () => {
    using audio = retainedAudioFixture({ maximumBytes: 64 * 1024 * 1024 });
    await using f = createLiveSpeechFixture();
    await f.controller.load({ file });
    await f.controller.start(options);
    f.pcm({ samples: new Float32Array([0.2]) });
    f.frame({ text: 'Answer', samples: new Float32Array([0.3]) });
    await f.controller.stop({ mode: 'finish' });
    expect(audio.factory).toHaveBeenCalledOnce();
    expect(audio.stores[0]?.append).not.toHaveBeenCalled();
    expect(audio.stores[0]?.finish).not.toHaveBeenCalled();
    expect(audio.createUrl).not.toHaveBeenCalled();
    expect(f.controller.getState().sessions[0]).toMatchObject({ inputAudio: undefined, outputAudio: undefined });
  });

  it('retains accepted post-mute input and generated output before playback, including the initial frame', async () => {
    using audio = retainedAudioFixture({ maximumBytes: 64 * 1024 * 1024 });
    await using f = createLiveSpeechFixture();
    f.controller.retainAudio({ value: 'on' });
    f.controller.mutePlayback({ value: 'off' });
    await f.controller.load({ file });
    vi.mocked(f.client.start).mockImplementation(async () => {
      f.change({ state: { phase: 'starting' } });
      f.frame({ text: 'Initial', samples: new Float32Array([0.1]) });
      f.change({ state: { phase: 'running' } });
    });
    await f.controller.start(options);
    const input = new Float32Array([0.25, -0.5]);
    f.pcm({ samples: input });
    input.fill(0);
    f.controller.muteMicrophone({ value: 'off' });
    f.pcm({ samples: new Float32Array([0.9]) });
    vi.mocked(f.client.push).mockReturnValueOnce({ kind: 'not_running' });
    f.pcm({ samples: new Float32Array([0.7]) });
    const output = new Float32Array([0.5]);
    f.frame({ text: 'Answer', samples: output });
    output.fill(0);
    await f.controller.stop({ mode: 'finish' });
    const session = f.controller.getState().sessions[0];
    expect(session?.id).toMatch(/^[\w-]{21}$/);
    expect(session?.inputAudio?.status).toBe('complete');
    expect(session?.outputAudio?.status).toBe('complete');
    expect(await retainedSamples({ clip: session?.inputAudio, blobs: audio.blobs })).toEqual([0.25, -0.5, 0]);
    expect(await retainedSamples({ clip: session?.outputAudio, blobs: audio.blobs })).toEqual(Array.from(new Float32Array([0.1, 0.5])));
    expect(f.player.mute).toHaveBeenCalledWith({ value: 'off' });
  });

  it.each(['cancel', 'max_seconds', 'failure'] as const)('marks accepted recordings partial after %s', async reason => {
    using audio = retainedAudioFixture({ maximumBytes: 64 * 1024 * 1024 });
    await using f = createLiveSpeechFixture();
    f.controller.retainAudio({ value: 'on' });
    await f.controller.load({ file });
    await f.controller.start(options);
    f.pcm({ samples: new Float32Array([0.2]) });
    f.frame({ text: 'Answer', samples: new Float32Array([0.3]) });
    switch (reason) {
    case 'cancel': await f.controller.stop({ mode: 'cancel' });
      break;
    case 'max_seconds': f.change({ state: { phase: 'completed', completion: 'max_seconds' } });
      break;
    case 'failure': f.change({ state: { phase: 'failed', failure: { code: 'runtime_failed', message: 'Native failed', nativeStatus: -1, nativeInput: 'push' } } });
      break;
    default: {
      const exhaustive: never = reason;
      throw new Error(String(exhaustive));
    }
    }
    expect(f.controller.getState().sessions[0]).toMatchObject({ inputAudio: { status: 'partial' }, outputAudio: { status: 'partial' } });
    expect(audio.createUrl).toHaveBeenCalledTimes(2);
  });

  it('seals initial output as partial when starting the native session fails', async () => {
    using audio = retainedAudioFixture({ maximumBytes: 64 * 1024 * 1024 });
    await using f = createLiveSpeechFixture();
    f.controller.retainAudio({ value: 'on' });
    await f.controller.load({ file });
    vi.mocked(f.client.start).mockImplementation(async () => {
      f.change({ state: { phase: 'starting' } });
      f.frame({ text: 'Initial', samples: new Float32Array([0.1]) });
      throw new Error('Start failed');
    });
    await f.controller.start(options);
    await vi.waitFor(() => expect(f.controller.getState().sessions[0]?.outputAudio?.status).toBe('partial'));
    expect(f.controller.getState().failure?.message).toBe('Start failed');
    expect(f.controller.getState().sessions[0]?.inputAudio).toBeUndefined();
    expect(audio.createUrl).toHaveBeenCalledOnce();
  });

  it('does not label accepted audio complete without a terminal runtime notification', async () => {
    using audio = retainedAudioFixture({ maximumBytes: 64 * 1024 * 1024 });
    await using f = createLiveSpeechFixture();
    f.controller.retainAudio({ value: 'on' });
    await f.controller.load({ file });
    await f.controller.start(options);
    f.pcm({ samples: new Float32Array([0.2]) });
    vi.mocked(f.client.stop).mockImplementation(async () => {});
    await f.controller.stop({ mode: 'finish' });
    expect(f.controller.getState().sessions[0]?.inputAudio?.status).toBe('partial');
    expect(audio.createUrl).toHaveBeenCalledOnce();
  });

  it('retains generated frames that exceed the automatic playback queue as partial audio', async () => {
    using audio = retainedAudioFixture({ maximumBytes: 64 * 1024 * 1024 });
    await using f = createLiveSpeechFixture();
    f.controller.retainAudio({ value: 'on' });
    await f.controller.load({ file });
    await f.controller.start(options);
    const waiting = Promise.withResolvers<void>();
    f.player.append.mockImplementation(() => waiting.promise);
    f.frame({ text: 'First', samples: new Float32Array(24000 * 3) });
    f.frame({ text: 'Second', samples: new Float32Array(24000 * 2) });
    expect(f.controller.getState().warning).toBe('output-backpressure');
    expect(f.controller.getState().sessions[0]?.outputAudio).toMatchObject({ status: 'partial', seconds: 5 });
    expect(audio.createUrl).toHaveBeenCalledOnce();
    waiting.resolve();
  });

  it('clears unfinished audio on disable and does not resume retention until the next session', async () => {
    using audio = retainedAudioFixture({ maximumBytes: 64 * 1024 * 1024 });
    await using f = createLiveSpeechFixture();
    f.controller.retainAudio({ value: 'on' });
    await f.controller.load({ file });
    await f.controller.start(options);
    f.pcm({ samples: new Float32Array([0.2]) });
    f.controller.retainAudio({ value: 'off' });
    f.controller.retainAudio({ value: 'on' });
    f.pcm({ samples: new Float32Array([0.4]) });
    f.frame({ text: 'Answer', samples: new Float32Array([0.3]) });
    await f.controller.stop({ mode: 'finish' });
    expect(audio.createUrl).not.toHaveBeenCalled();
    expect(f.controller.getState().sessions[0]).toMatchObject({ inputAudio: undefined, outputAudio: undefined });
    await f.controller.start(options);
    f.pcm({ samples: new Float32Array([0.5]) });
    await f.controller.stop({ mode: 'finish' });
    expect(f.controller.getState().sessions[1]?.inputAudio?.status).toBe('complete');
    expect(audio.createUrl).toHaveBeenCalledOnce();
  });

  it.each(['off', 'reset', 'release', 'dispose'] as const)('releases completed URLs immediately on %s and prevents late retention', async action => {
    using audio = retainedAudioFixture({ maximumBytes: 64 * 1024 * 1024 });
    await using f = createLiveSpeechFixture();
    f.controller.retainAudio({ value: 'on' });
    await f.controller.load({ file });
    await f.controller.start(options);
    f.pcm({ samples: new Float32Array([0.2]) });
    f.frame({ text: 'Answer', samples: new Float32Array([0.3]) });
    await f.controller.stop({ mode: 'finish' });
    await f.controller.start(options);
    f.pcm({ samples: new Float32Array([0.4]) });
    const gate = Promise.withResolvers<void>();
    vi.mocked(f.client.stop).mockImplementation(() => gate.promise);
    vi.mocked(f.client.releaseModel).mockImplementation(() => gate.promise);
    vi.mocked(f.client.dispose).mockImplementation(() => gate.promise);
    const cleanup = (() => {
      switch (action) {
      case 'off': f.controller.retainAudio({ value: 'off' });
        return Promise.resolve();
      case 'reset': return f.controller.reset();
      case 'release': return f.controller.release();
      case 'dispose': return f.controller.dispose();
      default: {
        const exhaustive: never = action;
        throw new Error(String(exhaustive));
      }
      }
    })();
    expect(audio.revokeUrl).toHaveBeenCalledTimes(2);
    expect(f.controller.getState().sessions.every(session => session.inputAudio === undefined && session.outputAudio === undefined)).toBe(true);
    f.pcm({ samples: new Float32Array([0.6]) });
    f.frame({ text: 'Late', samples: new Float32Array([0.7]) });
    gate.resolve();
    await cleanup;
    expect(audio.createUrl).toHaveBeenCalledTimes(2);
    expect(audio.revokeUrl).toHaveBeenCalledTimes(2);
  });

  it('shares one bounded store across sessions and preserves backpressure warnings independently', async () => {
    using audio = retainedAudioFixture({ maximumBytes: 100 });
    await using f = createLiveSpeechFixture();
    f.controller.retainAudio({ value: 'on' });
    await f.controller.load({ file });
    await f.controller.start(options);
    f.pcm({ samples: new Float32Array([0.2]) });
    f.frame({ text: 'First', samples: new Float32Array([0.3]) });
    await f.controller.stop({ mode: 'finish' });
    await f.controller.start(options);
    f.pcm({ samples: new Float32Array([0.4]) });
    f.frame({ text: 'Second', samples: new Float32Array([0.5]) });
    expect(f.controller.getState()).toMatchObject({ warning: undefined, audioWarning: 'retention-limit', failure: undefined });
    expect(f.client.stop).toHaveBeenCalledOnce();
    vi.mocked(f.client.push).mockReturnValueOnce({ kind: 'backpressure' });
    f.pcm({ samples: new Float32Array([0.6]) });
    await vi.waitFor(() => expect(f.controller.getState().warning).toBe('input-backpressure'));
    expect(f.controller.getState().audioWarning).toBe('retention-limit');
    expect(f.controller.getState().sessions[0]).toMatchObject({ inputAudio: { status: 'complete' }, outputAudio: { status: 'complete' } });
    expect(f.controller.getState().sessions[1]).toMatchObject({ inputAudio: undefined, outputAudio: undefined });
    expect(audio.factory).toHaveBeenCalledOnce();
    expect(audio.createUrl).toHaveBeenCalledTimes(2);
  });

  it('keeps inference success when WAV creation fails', async () => {
    using audio = retainedAudioFixture({ maximumBytes: 64 * 1024 * 1024 });
    await using f = createLiveSpeechFixture();
    f.controller.retainAudio({ value: 'on' });
    await f.controller.load({ file });
    await f.controller.start(options);
    f.pcm({ samples: new Float32Array([0.2]) });
    f.frame({ text: 'Answer', samples: new Float32Array([0.3]) });
    audio.createUrl.mockImplementationOnce(() => {
      throw new Error('Blob unavailable');
    });
    await f.controller.stop({ mode: 'finish' });
    expect(f.controller.getState()).toMatchObject({ runtime: { phase: 'completed' }, failure: undefined, audioWarning: 'retention-failed' });
    expect(f.controller.getState().sessions[0]).toMatchObject({ text: 'Answer', inputAudio: undefined, outputAudio: undefined });
  });

  it('does not clear a diagnostic file result when live retention is disabled', async () => {
    using audio = retainedAudioFixture({ maximumBytes: 64 * 1024 * 1024 });
    await using f = createLiveSpeechFixture();
    await f.controller.load({ file });
    await f.controller.runFile({ ...options, inputLevel: { kind: 'gain' as const, gain: 1 }, maximumRetainedAudioBytes: 64 * 1024 * 1024, file: new File(['audio'], 'input.wav'), tailSeconds: 0, seed: 0, inputPacing: 'fast' });
    const result = f.controller.getState().fileRun;
    expect(result?.input).toBeDefined();
    f.controller.retainAudio({ value: 'off' });
    expect(f.controller.getState().fileRun).toBe(result);
    expect(audio.revokeUrl).not.toHaveBeenCalled();
  });
});
