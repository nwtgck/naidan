// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpeechRuntimeError } from '@/features/speech-cpp-browser/types';
import type { SpeechInputPacing } from './speech-file-run';
import { speechFileRunFixture, speechReplayVisibility } from './speech-file-run.test-support';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));

afterEach(() => vi.useRealTimers());

async function replayWaves({ inputPacing }: { inputPacing: SpeechInputPacing }): Promise<Uint8Array[]> {
  const pcm = Float32Array.from({ length: 3201 }, (_, index) => Math.sin(index / 100) * 0.25);
  await using f = await speechFileRunFixture({ pcm, tailSeconds: 0.2, maxSeconds: 10, inputPacing });
  const running = f.runner.run();
  if (inputPacing === 'real_time') {
    await vi.advanceTimersByTimeAsync(1000);
  }
  await running;
  return Promise.all(f.blobs.map(async blob => new Uint8Array(await blob.arrayBuffer())));
}

describe('fixed audio at real-time deadlines', () => {
  it('starts input after dialogue readiness, keeps sequence zero separate, and works without a DOM', async () => {
    expect(typeof document).toBe('undefined');
    const gate = Promise.withResolvers<void>();
    await using f = await speechFileRunFixture({ pcm: new Float32Array(6400).fill(0.25), tailSeconds: 0, maxSeconds: 10, inputPacing: 'real_time' });
    using unblock = {
      [Symbol.dispose]() {
        gate.resolve();
      },
    };
    const start = vi.mocked(f.model.start).getMockImplementation()!;
    vi.mocked(f.model.start).mockImplementation(async args => {
      const dialogue = await start(args);
      await gate.promise;
      return dialogue;
    });
    const running = f.runner.run();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.runner.getState()).toMatchObject({ stage: 'starting_dialogue', frames: 1, firstOutputMilliseconds: 0, replayTiming: { dialogueReadyMilliseconds: undefined, maxOutputLatenessMilliseconds: undefined } });
    expect(f.push).not.toHaveBeenCalled();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.runner.getState()).toMatchObject({ stage: 'feeding_input', replayTiming: { dialogueReadyMilliseconds: 500 } });
    await vi.advanceTimersByTimeAsync(133);
    expect(f.push).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.push).toHaveBeenCalledOnce();
    expect(f.push.mock.calls[0]?.[0].samples).toEqual(new Float32Array(3200).fill(0.25));
    await vi.advanceTimersByTimeAsync(200);
    await running;
    expect(f.runner.getState()).toMatchObject({ status: 'complete', stage: 'finished', plannedInputSamples: 6400, submittedSamples: 6400, replayTiming: { dialogueReadyMilliseconds: 500, catchUpFrames: 0, interruption: undefined } });
    void unblock;
  });

  it('offers further frames independently of a pending native call and enters finish before the queue drains', async () => {
    const gate = Promise.withResolvers<{ kind: 'continue' }>();
    await using f = await speechFileRunFixture({ pcm: new Float32Array(9600), tailSeconds: 0, maxSeconds: 10, inputPacing: 'real_time' });
    using unblock = {
      [Symbol.dispose]() {
        gate.resolve({ kind: 'continue' });
      },
    };
    f.push.mockReturnValueOnce(gate.promise);
    const stopped = vi.spyOn(f.client, 'stop');
    const running = f.runner.run();
    await vi.advanceTimersByTimeAsync(401);
    expect(f.push).toHaveBeenCalledOnce();
    expect(f.client.getState().queuedSamples).toBe(9600);
    expect(stopped).toHaveBeenCalledWith({ mode: 'finish' });
    expect(f.runner.getState()).toMatchObject({ stage: 'draining_input', submittedSamples: 9600, replayTiming: { maxQueuedSamples: 9600, producerDurationMilliseconds: 400 } });
    gate.resolve({ kind: 'continue' });
    await running;
    expect(f.runner.getState().status).toBe('complete');
    void unblock;
  });

  it('finishes while waiting for the next deadline without escalating to cancel or offering tail audio', async () => {
    const gate = Promise.withResolvers<{ kind: 'continue' }>();
    await using f = await speechFileRunFixture({ pcm: new Float32Array(32000), tailSeconds: 5, maxSeconds: 60, inputPacing: 'real_time' });
    using unblock = {
      [Symbol.dispose]() {
        gate.resolve({ kind: 'continue' });
      },
    };
    f.push.mockReturnValueOnce(gate.promise);
    const stopped = vi.spyOn(f.client, 'stop');
    const running = f.runner.run();
    await vi.advanceTimersByTimeAsync(150);
    const finishing = f.runner.stop({ mode: 'finish' });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.push).toHaveBeenCalledOnce();
    expect(f.model.cancel).not.toHaveBeenCalled();
    expect(stopped.mock.calls.every(([{ mode }]) => mode === 'finish')).toBe(true);
    gate.resolve({ kind: 'continue' });
    await finishing;
    await running;
    expect(f.runner.getState()).toMatchObject({ status: 'partial', submittedSamples: 3200, replayTiming: { producerDurationMilliseconds: 150, drainDurationMilliseconds: 100, interruption: 'user_finish' } });
    expect(f.model.cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    void unblock;
  });

  it('records a large producer delay and catches up without dropping or rebasing input', async () => {
    let wall = 0;
    using clock = {
      spy: vi.spyOn(performance, 'now').mockImplementation(() => wall),
      [Symbol.dispose]() {
        this.spy.mockRestore();
      },
    };
    const pcm = Float32Array.from({ length: 9600 }, (_, index) => Math.sin(index / 10) * 0.25);
    await using f = await speechFileRunFixture({ pcm, tailSeconds: 0, maxSeconds: 10, inputPacing: 'real_time' });
    const running = f.runner.run();
    await vi.advanceTimersByTimeAsync(0);
    wall = 500;
    await vi.advanceTimersByTimeAsync(150);
    await running;
    expect(f.push.mock.calls.map(([{ samples }]) => samples)).toEqual([pcm.slice(0, 3200), pcm.slice(3200, 6400), pcm.slice(6400)]);
    expect(f.runner.getState()).toMatchObject({ status: 'complete', replayTiming: { catchUpFrames: 2, interruption: undefined, producerDurationMilliseconds: 500 } });
    expect(f.runner.getState().replayTiming?.maxScheduleLatenessMilliseconds).toBeCloseTo(500 - 1000 / 7.5);
    expect(f.runner.getState().replayTiming?.maxOutputLatenessMilliseconds).toBeCloseTo(500 - 1000 / 7.5);
    void clock;
  });

  it('stops at the existing two-second backlog bound and keeps accepted input as partial', async () => {
    const gate = Promise.withResolvers<{ kind: 'continue' }>();
    await using f = await speechFileRunFixture({ pcm: new Float32Array(64000).fill(0.25), tailSeconds: 0, maxSeconds: 10, inputPacing: 'real_time' });
    using unblock = {
      [Symbol.dispose]() {
        gate.resolve({ kind: 'continue' });
      },
    };
    f.push.mockReturnValueOnce(gate.promise);
    const running = f.runner.run();
    await vi.advanceTimersByTimeAsync(2200);
    expect(f.runner.getState()).toMatchObject({ stage: 'draining_input', submittedSamples: 48000, replayTiming: { maxQueuedSamples: 48000, interruption: 'backpressure' } });
    expect(f.model.cancel).toHaveBeenCalled();
    gate.resolve({ kind: 'continue' });
    await running;
    expect(f.runner.getState()).toMatchObject({ status: 'partial', failure: undefined, submittedSamples: 48000, input: { status: 'partial' } });
    const input = new DataView(await f.blobs[0]!.arrayBuffer());
    expect(input.getUint32(40, true)).toBe(48000 * 4);
    expect(input.getFloat32(input.byteLength - 4, true)).toBe(0.25);
    void unblock;
  });

  it('preserves identical PCM and padding/tail WAV bytes in fast and real-time runs', async () => {
    const fast = await replayWaves({ inputPacing: 'fast' });
    const realTime = await replayWaves({ inputPacing: 'real_time' });
    expect(realTime).toEqual(fast);
  });

  it('interrupts an initially hidden real-time run without decoding or starting a dialogue', async () => {
    using visibility = speechReplayVisibility({ initial: 'hidden' });
    await using f = await speechFileRunFixture({ pcm: new Float32Array(3200), tailSeconds: 0, maxSeconds: 10, inputPacing: 'real_time' });
    await f.runner.run();
    expect(f.decodeFile).not.toHaveBeenCalled();
    expect(f.model.start).not.toHaveBeenCalled();
    expect(f.runner.getState()).toMatchObject({ status: 'partial', stage: 'finished', replayTiming: { interruption: 'page_hidden', dialogueReadyMilliseconds: undefined } });
    expect(visibility.removed).toHaveBeenCalledOnce();
  });

  it('cancels on page hiding, removes the deadline, and never resumes on visibility restoration', async () => {
    using visibility = speechReplayVisibility({ initial: 'visible' });
    await using f = await speechFileRunFixture({ pcm: new Float32Array(32000), tailSeconds: 5, maxSeconds: 60, inputPacing: 'real_time' });
    const running = f.runner.run();
    await vi.advanceTimersByTimeAsync(150);
    visibility.change({ value: 'hidden' });
    await running;
    expect(f.runner.getState()).toMatchObject({ status: 'partial', submittedSamples: 3200, replayTiming: { interruption: 'page_hidden' } });
    visibility.change({ value: 'visible' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.push).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(visibility.removed).toHaveBeenCalledOnce();
  });

  it('keeps fast input independent of page visibility and installs no producer timer or visibility listener', async () => {
    using visibility = speechReplayVisibility({ initial: 'hidden' });
    await using f = await speechFileRunFixture({ pcm: new Float32Array(3200), tailSeconds: 0, maxSeconds: 10, inputPacing: 'fast' });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    await f.runner.run();
    expect(f.runner.getState()).toMatchObject({ status: 'complete', replayTiming: undefined });
    expect(visibility.added).not.toHaveBeenCalled();
    expect(timers).not.toHaveBeenCalled();
    timers.mockRestore();
  });

  it('clears a waiting producer and retained audio without creating late result URLs', async () => {
    await using f = await speechFileRunFixture({ pcm: new Float32Array(32000), tailSeconds: 5, maxSeconds: 60, inputPacing: 'real_time' });
    const running = f.runner.run();
    await vi.advanceTimersByTimeAsync(0);
    f.runner.clear();
    await running;
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.push).not.toHaveBeenCalled();
    expect(f.createUrl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.model.release).not.toHaveBeenCalled();
  });

  it('keeps native error details after a real-time cancellation', async () => {
    const gate = Promise.withResolvers<{ kind: 'continue' }>();
    await using f = await speechFileRunFixture({ pcm: new Float32Array(6400), tailSeconds: 0, maxSeconds: 10, inputPacing: 'real_time' });
    const failure = { code: 'runtime_failed' as const, message: 'Device failed', nativeStatus: -42, nativeInput: 'audio' };
    using unblock = {
      [Symbol.dispose]() {
        gate.reject(new SpeechRuntimeError({ details: failure }));
      },
    };
    f.push.mockReturnValueOnce(gate.promise);
    const running = f.runner.run();
    await vi.advanceTimersByTimeAsync(150);
    const cancelled = f.runner.stop({ mode: 'cancel' });
    gate.reject(new SpeechRuntimeError({ details: failure }));
    await cancelled;
    await running;
    expect(f.runner.getState()).toMatchObject({ status: 'failed', failure, replayTiming: { interruption: 'user_cancel' } });
    void unblock;
  });

  it('finishes a pending decode without starting or cancelling a native dialogue later', async () => {
    const gate = Promise.withResolvers<Float32Array>();
    await using f = await speechFileRunFixture({ pcm: new Float32Array(3200), tailSeconds: 0, maxSeconds: 10, inputPacing: 'real_time' });
    using unblock = {
      [Symbol.dispose]() {
        gate.resolve(new Float32Array(3200));
      },
    };
    f.decodeFile.mockReturnValueOnce(gate.promise);
    const running = f.runner.run();
    await f.runner.stop({ mode: 'finish' });
    gate.resolve(new Float32Array(3200));
    await running;
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.runner.getState()).toMatchObject({ status: 'partial', replayTiming: { interruption: 'user_finish', dialogueReadyMilliseconds: undefined } });
    expect(f.model.start).not.toHaveBeenCalled();
    expect(f.model.cancel).not.toHaveBeenCalled();
    expect(f.createUrl).not.toHaveBeenCalled();
    void unblock;
  });

  it('keeps a native end failure after an explicit finish instead of labeling it a clean partial result', async () => {
    await using f = await speechFileRunFixture({ pcm: new Float32Array(32000), tailSeconds: 0, maxSeconds: 10, inputPacing: 'real_time' });
    const failure = { code: 'runtime_failed' as const, message: 'Native end failed', nativeStatus: -43, nativeInput: 'end' };
    f.end.mockRejectedValueOnce(new SpeechRuntimeError({ details: failure }));
    const running = f.runner.run();
    await vi.advanceTimersByTimeAsync(150);
    await expect(f.runner.stop({ mode: 'finish' })).rejects.toMatchObject({ details: failure });
    await running;
    expect(f.runner.getState()).toMatchObject({ status: 'failed', failure, replayTiming: { interruption: 'user_finish' }, output: { status: 'partial' } });
  });
});
