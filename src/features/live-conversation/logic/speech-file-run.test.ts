import { describe, expect, it, vi } from 'vitest';
import { SpeechRuntimeError } from '@/features/speech-cpp-browser/types';
import { readSpeechWave, speechFileRunFixture } from './speech-file-run.test-support';
import type { SpeechInputLevelSettings } from './audio-level';

describe('bounded Haru file input and exact pre-playback WAV output', () => {
  it.each([0, 1, 47])('does not decode or open a dialogue when %s bytes cannot hold one WAV sample', async maximumRetainedAudioBytes => {
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes, inputLevel: { kind: 'gain', gain: 1 }, pcm: new Float32Array([0.5]), tailSeconds: 0, maxSeconds: 10, inputPacing: 'fast' });
    await f.runner.run();
    expect(f.runner.getState()).toMatchObject({ status: 'partial', stage: 'finished', failure: undefined, audioRetention: { maximumBytes: maximumRetainedAudioBytes, retainedBytes: 0, status: 'limit' }, input: undefined, output: undefined });
    expect(f.decodeFile).not.toHaveBeenCalled();
    expect(f.model.start).not.toHaveBeenCalled();
    expect(f.model.cancel).not.toHaveBeenCalled();
    expect(f.createUrl).not.toHaveBeenCalled();
    expect(f.client.getState().phase).toBe('ready');
  });

  it.each([-1, 0.5, NaN, Infinity, 64 * 1024 * 1024 + 1])('rejects invalid retained audio budget %s before decode', async maximumRetainedAudioBytes => {
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes, inputLevel: { kind: 'gain', gain: 1 }, pcm: new Float32Array([0.5]), tailSeconds: 0, maxSeconds: 10, inputPacing: 'fast' });
    await f.runner.run();
    expect(f.runner.getState()).toMatchObject({ status: 'failed', failure: { message: 'Speech retained audio budget must be a safe integer between 0 and 64 MiB' } });
    expect(f.decodeFile).not.toHaveBeenCalled();
    expect(f.model.start).not.toHaveBeenCalled();
  });

  it('keeps a small initial output prefix and text as a retention-limited partial result', async () => {
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes: 55, inputLevel: { kind: 'gain', gain: 1 }, pcm: new Float32Array([0.5]), tailSeconds: 0, maxSeconds: 10, inputPacing: 'fast' });
    await f.runner.run();
    expect(f.runner.getState()).toMatchObject({ status: 'partial', text: 'Initial', frames: 1, submittedSamples: 0, failure: undefined, audioRetention: { maximumBytes: 55, retainedBytes: 52, status: 'limit' }, input: undefined, output: { status: 'partial', seconds: 2 / 24000 }, outputStatistics: { samples: 3200 } });
    expect(f.push).not.toHaveBeenCalled();
    expect(f.model.cancel).toHaveBeenCalled();
    expect(f.model.release).not.toHaveBeenCalled();
    expect(f.blobs).toHaveLength(1);
    expect(f.blobs[0]!.size).toBe(52);
    const wave = await readSpeechWave({ blob: f.blobs[0]! });
    expect(wave.getFloat32(44, true)).toBe(Math.fround(0.01));
    expect(wave.getFloat32(48, true)).toBe(Math.fround(0.01));
  });

  it('shares the remaining budget across both WAV headers while accepted input counters remain honest', async () => {
    const maximumRetainedAudioBytes = 44 + 3200 * 4 + 44 + 10 * 4;
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes, inputLevel: { kind: 'gain', gain: 1 }, pcm: new Float32Array(3200).fill(0.25), tailSeconds: 1, maxSeconds: 10, inputPacing: 'fast' });
    const gate = Promise.withResolvers<{ kind: 'continue' }>();
    f.push.mockReturnValueOnce(gate.promise);
    const running = f.runner.run();
    await vi.waitFor(() => expect(f.runner.getState().submittedSamples).toBe(3200));
    gate.resolve({ kind: 'continue' });
    await running;
    const state = f.runner.getState();
    expect(state).toMatchObject({ status: 'partial', failure: undefined, audioRetention: { maximumBytes: maximumRetainedAudioBytes, retainedBytes: maximumRetainedAudioBytes, status: 'limit' }, input: { status: 'partial', seconds: 10 / 24000 }, output: { status: 'partial', seconds: 3200 / 24000 }, inputStatistics: { samples: 3200 }, submittedSamples: 3200 });
    expect(f.push).toHaveBeenCalledOnce();
    expect(f.blobs.reduce((bytes, blob) => bytes + blob.size, 0)).toBe(maximumRetainedAudioBytes);
    expect(f.runner.getAudio({ role: 'input' })!.size).toBe(44 + 10 * 4);
    expect(f.runner.getAudio({ role: 'output' })!.size).toBe(44 + 3200 * 4);
  });

  it('completes when both exact WAV sizes fit without claiming retention truncation', async () => {
    const maximumRetainedAudioBytes = 2 * 44 + 3 * 3200 * 4;
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes, inputLevel: { kind: 'gain', gain: 1 }, pcm: new Float32Array([0.25]), tailSeconds: 0, maxSeconds: 10, inputPacing: 'fast' });
    await f.runner.run();
    expect(f.runner.getState()).toMatchObject({ status: 'complete', failure: undefined, audioRetention: { maximumBytes: maximumRetainedAudioBytes, retainedBytes: maximumRetainedAudioBytes, status: 'available' }, input: { status: 'complete' }, output: { status: 'complete' } });
    expect(f.blobs.reduce((bytes, blob) => bytes + blob.size, 0)).toBe(maximumRetainedAudioBytes);
  });

  it('preserves native failure details when cancellation follows a retention limit', async () => {
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes: 48, inputLevel: { kind: 'gain', gain: 1 }, pcm: new Float32Array([0.25]), tailSeconds: 0, maxSeconds: 10, inputPacing: 'fast' });
    const failure = { code: 'runtime_failed' as const, message: 'Native failure after the initial output', nativeStatus: -42, nativeInput: 'audio' };
    const start = vi.mocked(f.model.start).getMockImplementation()!;
    vi.mocked(f.model.start).mockImplementation(async args => {
      await start(args);
      throw new SpeechRuntimeError({ details: failure });
    });
    await f.runner.run();
    expect(f.runner.getState()).toMatchObject({ status: 'failed', failure, audioRetention: { retainedBytes: 48, status: 'limit' }, output: { status: 'partial', seconds: 1 / 24000 } });
  });

  it('snapshots requested peak settings and measures source before adding padding or tail', async () => {
    const inputLevel: SpeechInputLevelSettings = { kind: 'peak', targetPeak: 0.8 };
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes: 64 * 1024 * 1024, inputLevel, pcm: new Float32Array([0.05, -0.025]), tailSeconds: 0.2, maxSeconds: 10, inputPacing: 'fast' });
    const decoded = Promise.withResolvers<Float32Array<ArrayBuffer>>();
    f.decodeFile.mockReturnValue(decoded.promise);
    const task = f.runner.run();
    await vi.waitFor(() => expect(f.decodeFile).toHaveBeenCalledOnce());
    inputLevel.targetPeak = 0.4;
    decoded.resolve(new Float32Array([0.05, -0.025]));
    await task;
    const state = f.runner.getState();
    expect(state.inputLevel).toMatchObject({ requested: { kind: 'peak', targetPeak: 0.8 }, before: { samples: 2 }, after: { samples: 2 }, clippedSamples: 0 });
    expect(state.inputLevel.after!.peak).toBeCloseTo(0.8, 6);
    expect(state.inputStatistics.samples).toBe(9600);
    expect(state.inputStatistics.rms).toBeLessThan(state.inputLevel.after!.rms);
    const chunks = f.push.mock.calls.map(([{ samples }]) => samples);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]![0]).toBeCloseTo(0.8, 6);
    expect(chunks[0]![1]).toBeCloseTo(-0.4, 6);
    expect(chunks[0]!.slice(2)).toEqual(new Float32Array(3198));
    expect(chunks.slice(1)).toEqual([new Float32Array(3200), new Float32Array(3200)]);
    expect(vi.mocked(f.model.start).mock.calls[0]![0].options).toEqual({ inputSampleRate: 24000, maxSeconds: 10, language: 'ja', persona: undefined, name: undefined, seed: 0 });
  });

  it.each([2, 8])('adjusts only source PCM at %s-times gain, preserving seed, frame bounds, padding and tail', async inputGain => {
    const pcm = new Float32Array(3201).fill(0.05);
    pcm[3200] = -0.05;
    const originalPeak = pcm[0]!;
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes: 64 * 1024 * 1024, inputLevel: { kind: 'gain', gain: inputGain }, pcm, tailSeconds: 0.2, maxSeconds: 10, inputPacing: 'fast' });
    await f.runner.run();
    const start = vi.mocked(f.model.start).mock.calls[0]![0];
    expect(start.options).toEqual({ inputSampleRate: 24000, maxSeconds: 10, language: 'ja', persona: undefined, name: undefined, seed: 0 });
    const chunks = f.push.mock.calls.map(([{ samples }]) => samples);
    expect(chunks.map(chunk => chunk.length)).toEqual([3200, 3200, 3200, 3200]);
    expect(chunks[0]![0]).toBe(originalPeak * inputGain);
    expect(chunks[1]![0]).toBe(-originalPeak * inputGain);
    expect(chunks[1]!.slice(1)).toEqual(new Float32Array(3199));
    expect(chunks.slice(2)).toEqual([new Float32Array(3200), new Float32Array(3200)]);
    const state = f.runner.getState();
    expect(state).toMatchObject({ status: 'complete', seed: 0, sourceSamples: 3201, paddingSamples: 3199, requestedTailSeconds: 0.2, effectiveTailSeconds: 6400 / 24000, submittedSamples: 12800, frames: 5, inputLevel: { requested: { kind: 'gain', gain: inputGain }, appliedGain: inputGain, clippedSamples: 0, before: { samples: 3201, peak: originalPeak }, after: { samples: 3201, peak: originalPeak * inputGain } }, inputStatistics: { samples: 12800 } });
    expect(state.inputStatistics.rms).toBeLessThan(state.inputLevel.after!.rms);
    const input = await readSpeechWave({ blob: f.blobs[0]! });
    expect(input.getFloat32(44, true)).toBe(originalPeak * inputGain);
    expect(input.getFloat32(44 + 3201 * 4, true)).toBe(0);
  });

  it('snapshots the requested gain when decoding fails without inventing source measurements', async () => {
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes: 64 * 1024 * 1024, inputLevel: { kind: 'gain', gain: 8 }, pcm: new Float32Array([0.25]), tailSeconds: 0, maxSeconds: 10, inputPacing: 'fast' });
    f.decodeFile.mockRejectedValue(new Error('decode failed'));
    await f.runner.run();
    expect(f.runner.getState()).toMatchObject({ status: 'failed', inputLevel: { requested: { kind: 'gain', gain: 8 }, appliedGain: undefined, before: undefined, after: undefined, clippedSamples: undefined }, failure: { message: 'decode failed' } });
    expect(f.model.start).not.toHaveBeenCalled();
  });

  it.each([NaN, 0, -2])('fails invalid gain %s before decode or native start', async inputGain => {
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes: 64 * 1024 * 1024, inputLevel: { kind: 'gain', gain: inputGain }, pcm: new Float32Array([0.25]), tailSeconds: 0, maxSeconds: 10, inputPacing: 'fast' });
    await f.runner.run();
    expect(f.runner.getState()).toMatchObject({ status: 'failed', failure: { message: 'Input gain must be a finite positive number' } });
    expect(f.runner.getState().inputLevel.requested).toEqual({ kind: 'gain', gain: inputGain });
    expect(f.decodeFile).not.toHaveBeenCalled();
    expect(f.model.start).not.toHaveBeenCalled();
  });

  it('separates input preparation and native first/output duration from WAV encoding', async () => {
    let time = 0;
    using clock = {
      spy: vi.spyOn(performance, 'now').mockImplementation(() => time),
      [Symbol.dispose]() {
        this.spy.mockRestore();
      },
    };
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes: 64 * 1024 * 1024, inputLevel: { kind: 'gain' as const, gain: 1 }, pcm: new Float32Array([0.5]), tailSeconds: 0, maxSeconds: 60, inputPacing: 'fast' });
    f.decodeFile.mockImplementation(async () => {
      time = 25;
      return new Float32Array([0.5]);
    });
    const start = vi.mocked(f.model.start).getMockImplementation()!;
    vi.mocked(f.model.start).mockImplementation(async args => {
      time = 70;
      return start(args);
    });
    const push = f.push.getMockImplementation()!;
    f.push.mockImplementation(async args => {
      time = 120;
      return push(args);
    });
    f.end.mockImplementation(async () => {
      time = 200;
    });
    const encode = f.createUrl.getMockImplementation()!;
    f.createUrl.mockImplementation(blob => {
      time += 20;
      return encode(blob);
    });
    await f.runner.run();
    expect(f.runner.getState()).toMatchObject({ inputPreparationMilliseconds: 25, firstOutputMilliseconds: 45, generationMilliseconds: 175, elapsedMilliseconds: 240, text: 'Initial response' });
    void clock;
  });

  it('preserves the source, zero-pads the final frame, and sends explicit trailing silence', async () => {
    const pcm = Float32Array.from({ length: 3201 }, (_, index) => Math.sin(index / 100) * 0.25);
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes: 64 * 1024 * 1024, inputLevel: { kind: 'gain' as const, gain: 1 }, pcm, tailSeconds: 0.2, maxSeconds: 10, inputPacing: 'fast' });
    await f.runner.run();
    expect(f.model.start).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ seed: 0 }) }));
    expect(f.decodeFile).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 24000 }));
    const chunks = f.push.mock.calls.map(([{ samples }]) => samples);
    expect(chunks.map(chunk => chunk.length)).toEqual([3200, 3200, 3200, 3200]);
    expect(chunks[0]).toEqual(pcm.slice(0, 3200));
    expect(chunks[1]?.[0]).toBe(pcm[3200]);
    expect(chunks[1]?.slice(1)).toEqual(new Float32Array(3199));
    expect(chunks.slice(2)).toEqual([new Float32Array(3200), new Float32Array(3200)]);
    expect(f.runner.getState()).toMatchObject({
      status: 'complete',
      seed: 0,
      sourceSamples: 3201,
      paddingSamples: 3199,
      requestedTailSeconds: 0.2,
      effectiveTailSeconds: 6400 / 24000,
      submittedSamples: 12800,
      frames: 5,
      firstSequence: 0,
      lastSequence: 4,
      sequenceDiscontinuities: 0,
      input: { status: 'complete', sampleRate: 24000, seconds: 12800 / 24000 },
      output: { status: 'complete', sampleRate: 24000, seconds: 16000 / 24000 },
      firstFrameStatistics: { samples: 3200, peak: new Float32Array([0.01])[0] },
    });
    expect(f.client.getState()).toMatchObject({ phase: 'completed', model: f.model.info });
    expect(f.model.release).not.toHaveBeenCalled();
    expect(f.end).toHaveBeenCalledOnce();
    const input = await readSpeechWave({ blob: f.blobs[0]! });
    const output = await readSpeechWave({ blob: f.blobs[1]! });
    for (const wave of [input, output]) {
      expect(wave.getUint16(20, true)).toBe(3);
      expect(wave.getUint16(34, true)).toBe(32);
      expect(wave.getUint32(24, true)).toBe(24000);
    }
    expect(input.getFloat32(44 + 3200 * 4, true)).toBe(pcm[3200]);
    expect(input.getFloat32(44 + 3201 * 4, true)).toBe(0);
    expect(output.getFloat32(44, true)).toBe(new Float32Array([0.01])[0]);
    expect(output.getFloat32(44 + 3200 * 4, true)).toBe(new Float32Array([0.02])[0]);
    expect(output.getFloat32(output.byteLength - 4, true)).toBe(new Float32Array([0.05])[0]);
    f.runner.clear();
    expect(f.revokeUrl).toHaveBeenCalledTimes(2);
  });

  it('reserves the initial response frame and shortens silence to the actual max_seconds budget', async () => {
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes: 64 * 1024 * 1024, inputLevel: { kind: 'gain' as const, gain: 1 }, pcm: new Float32Array([0.5]), tailSeconds: 5, maxSeconds: 0.4, inputPacing: 'fast' });
    await f.runner.run();
    expect(f.push).toHaveBeenCalledTimes(2);
    expect(f.runner.getState()).toMatchObject({ status: 'complete', effectiveTailSeconds: 3200 / 24000, frames: 3, submittedSamples: 6400 });
  });

  it('rejects a source that cannot fit without silently truncating it or touching the dialogue', async () => {
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes: 64 * 1024 * 1024, inputLevel: { kind: 'gain' as const, gain: 1 }, pcm: new Float32Array(3201), tailSeconds: 5, maxSeconds: 0.4 - 1 / 24000, inputPacing: 'fast' });
    await f.runner.run();
    expect(f.runner.getState()).toMatchObject({ status: 'failed', failure: { message: expect.stringContaining('exceed the session duration') } });
    expect(f.model.start).not.toHaveBeenCalled();
    expect(f.client.getState().phase).toBe('ready');
    expect(f.createUrl).not.toHaveBeenCalled();
  });

  it('waits for each input frame and cancels without enqueueing the remaining source', async () => {
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes: 64 * 1024 * 1024, inputLevel: { kind: 'gain' as const, gain: 1 }, pcm: new Float32Array(3200 * 4), tailSeconds: 5, maxSeconds: 60, inputPacing: 'fast' });
    const gate = Promise.withResolvers<{ kind: 'continue' }>();
    f.push.mockImplementationOnce(() => gate.promise);
    const running = f.runner.run();
    await vi.waitFor(() => expect(f.push).toHaveBeenCalledOnce());
    expect(f.client.getState().queuedSamples).toBe(3200);
    const cancelled = f.runner.stop({ mode: 'cancel' });
    gate.resolve({ kind: 'continue' });
    await running;
    await cancelled;
    expect(f.push).toHaveBeenCalledOnce();
    expect(f.runner.getState()).toMatchObject({ status: 'partial', submittedSamples: 3200, input: { status: 'partial' }, output: { status: 'partial' } });
    expect(f.model.cancel).toHaveBeenCalled();
    expect(f.model.release).not.toHaveBeenCalled();
  });

  it('cancels a pending decoder immediately and ignores its late completion', async () => {
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes: 64 * 1024 * 1024, inputLevel: { kind: 'gain' as const, gain: 1 }, pcm: new Float32Array([0.1]), tailSeconds: 5, maxSeconds: 60, inputPacing: 'fast' });
    const gate = Promise.withResolvers<Float32Array<ArrayBuffer>>();
    f.decodeFile.mockReturnValue(gate.promise);
    const running = f.runner.run();
    await f.runner.stop({ mode: 'cancel' });
    await running;
    f.runner.clear();
    gate.resolve(new Float32Array(3200));
    await Promise.resolve();
    expect(f.runner.getState()).toMatchObject({ status: 'partial', failure: undefined });
    expect(f.decodeFile.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(f.model.start).not.toHaveBeenCalled();
    expect(f.createUrl).not.toHaveBeenCalled();
  });

  it('keeps the native error details and marks the initial generated audio partial on failure', async () => {
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes: 64 * 1024 * 1024, inputLevel: { kind: 'gain' as const, gain: 1 }, pcm: new Float32Array(3200), tailSeconds: 0, maxSeconds: 60, inputPacing: 'fast' });
    const failure = { code: 'runtime_failed' as const, message: 'Device failed', nativeStatus: -42, nativeInput: 'audio' };
    f.push.mockRejectedValueOnce(new SpeechRuntimeError({ details: failure }));
    await f.runner.run();
    expect(f.runner.getState()).toMatchObject({ status: 'failed', failure, output: { status: 'partial' }, frames: 1 });
    expect(f.model.release).toHaveBeenCalledOnce();
  });

  it('preserves a native failure after cancellation was requested instead of reporting a clean partial run', async () => {
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes: 64 * 1024 * 1024, inputLevel: { kind: 'gain' as const, gain: 1 }, pcm: new Float32Array(3200 * 2), tailSeconds: 0, maxSeconds: 60, inputPacing: 'fast' });
    const gate = Promise.withResolvers<{ kind: 'continue' }>();
    f.push.mockReturnValueOnce(gate.promise);
    const running = f.runner.run();
    await vi.waitFor(() => expect(f.push).toHaveBeenCalledOnce());
    const cancelled = f.runner.stop({ mode: 'cancel' });
    const failure = { code: 'runtime_failed' as const, message: 'Device failed during cancellation', nativeStatus: -42, nativeInput: 'audio' };
    gate.reject(new SpeechRuntimeError({ details: failure }));
    await running;
    await cancelled;
    expect(f.runner.getState()).toMatchObject({ status: 'failed', failure, frames: 1, output: { status: 'partial' } });
    expect(f.model.release).toHaveBeenCalledOnce();
  });

  it('records sequence discontinuities and refuses malformed output without turning it into a complete WAV', async () => {
    await using f = await speechFileRunFixture({ maximumRetainedAudioBytes: 64 * 1024 * 1024, inputLevel: { kind: 'gain' as const, gain: 1 }, pcm: new Float32Array(3200), tailSeconds: 0, maxSeconds: 60, inputPacing: 'fast' });
    const gate = Promise.withResolvers<{ kind: 'continue' }>();
    f.push.mockReturnValue(gate.promise);
    const running = f.runner.run();
    await vi.waitFor(() => expect(f.push).toHaveBeenCalledOnce());
    f.runner.onFrame({ frame: { samples: new Float32Array(3200), text: '', sampleRate: 24000, sequence: 7 } });
    expect(f.runner.getState().sequenceDiscontinuities).toBe(1);
    f.runner.onFrame({ frame: { samples: new Float32Array(2), text: '', sampleRate: 24000, sequence: 8 } });
    gate.resolve({ kind: 'continue' });
    await running;
    expect(f.runner.getState()).toMatchObject({ status: 'failed', output: { status: 'partial' }, failure: { message: 'Invalid or oversized speech file output' } });
  });
});
