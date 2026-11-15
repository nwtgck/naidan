import { describe, expect, it, vi } from 'vitest';
import { SpeechRuntimeError } from '@/features/speech-cpp-browser/types';
import { readSpeechWave, speechFileRunFixture } from './speech-file-run.test-support';

describe('bounded Haru file input and exact pre-playback WAV output', () => {
  it('separates input preparation and native first/output duration from WAV encoding', async () => {
    let time = 0;
    using clock = {
      spy: vi.spyOn(performance, 'now').mockImplementation(() => time),
      [Symbol.dispose]() {
        this.spy.mockRestore();
      },
    };
    await using f = await speechFileRunFixture({ pcm: new Float32Array([0.5]), tailSeconds: 0, maxSeconds: 60 });
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
    await using f = await speechFileRunFixture({ pcm, tailSeconds: 0.2, maxSeconds: 10 });
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
    await using f = await speechFileRunFixture({ pcm: new Float32Array([0.5]), tailSeconds: 5, maxSeconds: 0.4 });
    await f.runner.run();
    expect(f.push).toHaveBeenCalledTimes(2);
    expect(f.runner.getState()).toMatchObject({ status: 'complete', effectiveTailSeconds: 3200 / 24000, frames: 3, submittedSamples: 6400 });
  });

  it('rejects a source that cannot fit without silently truncating it or touching the dialogue', async () => {
    await using f = await speechFileRunFixture({ pcm: new Float32Array(3201), tailSeconds: 5, maxSeconds: 0.4 - 1 / 24000 });
    await f.runner.run();
    expect(f.runner.getState()).toMatchObject({ status: 'failed', failure: { message: expect.stringContaining('exceed the session duration') } });
    expect(f.model.start).not.toHaveBeenCalled();
    expect(f.client.getState().phase).toBe('ready');
    expect(f.createUrl).not.toHaveBeenCalled();
  });

  it('waits for each input frame and cancels without enqueueing the remaining source', async () => {
    await using f = await speechFileRunFixture({ pcm: new Float32Array(3200 * 4), tailSeconds: 5, maxSeconds: 60 });
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
    await using f = await speechFileRunFixture({ pcm: new Float32Array([0.1]), tailSeconds: 5, maxSeconds: 60 });
    const gate = Promise.withResolvers<Float32Array>();
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
    await using f = await speechFileRunFixture({ pcm: new Float32Array(3200), tailSeconds: 0, maxSeconds: 60 });
    const failure = { code: 'runtime_failed' as const, message: 'Device failed', nativeStatus: -42, nativeInput: 'audio' };
    f.push.mockRejectedValueOnce(new SpeechRuntimeError({ details: failure }));
    await f.runner.run();
    expect(f.runner.getState()).toMatchObject({ status: 'failed', failure, output: { status: 'partial' }, frames: 1 });
    expect(f.model.release).toHaveBeenCalledOnce();
  });

  it('preserves a native failure after cancellation was requested instead of reporting a clean partial run', async () => {
    await using f = await speechFileRunFixture({ pcm: new Float32Array(3200 * 2), tailSeconds: 0, maxSeconds: 60 });
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
    await using f = await speechFileRunFixture({ pcm: new Float32Array(3200), tailSeconds: 0, maxSeconds: 60 });
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
