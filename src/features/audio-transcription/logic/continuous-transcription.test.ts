// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createContinuousAudioTranscription, initialContinuousAudioTranscriptionState, transcriptionRegionSeconds } from './continuous-transcription';

const sampleRate = 8000;
type Result = Awaited<ReturnType<Parameters<typeof createContinuousAudioTranscription>[0]['recognize']>>;

function fixture({ maxRegionSeconds }: { maxRegionSeconds: number }) {
  const recognize = vi.fn<Parameters<typeof createContinuousAudioTranscription>[0]['recognize']>(async () => ({ text: 'recognized', status: 'complete', failure: undefined }));
  const onStopRequested = vi.fn();
  const scheduler = createContinuousAudioTranscription({ sampleRate, language: 'ja', maxRegionSeconds, initial: initialContinuousAudioTranscriptionState(), recognize, onChange() {}, onStopRequested });
  return {
    scheduler,
    recognize,
    onStopRequested,
    append({ seconds }: { seconds: number }): void {
      scheduler.append({ pcm: new Float32Array(seconds * sampleRate).fill(0.25) });
    },
    [Symbol.dispose]() {
      scheduler.discard();
    },
  };
}

it('keeps one request in flight and coalesces pending provisional audio to the latest prefix', async () => {
  using value = fixture({ maxRegionSeconds: transcriptionRegionSeconds });
  const first = Promise.withResolvers<Result>(), second = Promise.withResolvers<Result>();
  value.recognize.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  value.append({ seconds: 1 });
  await vi.waitFor(() => expect(value.recognize).toHaveBeenCalledOnce());
  value.append({ seconds: 1 });
  value.append({ seconds: 1 });
  value.append({ seconds: 1 });
  expect(value.recognize).toHaveBeenCalledOnce();
  first.resolve({ text: 'old wording', status: 'complete', failure: undefined });
  await vi.waitFor(() => expect(value.recognize).toHaveBeenCalledTimes(2));
  expect(value.recognize.mock.calls[1]![0].samples.length).toBe(4 * sampleRate);
  expect(value.scheduler.getState().provisionalText).toBe('old wording');
  const finished = value.scheduler.finish();
  second.resolve({ text: 'corrected wording', status: 'complete', failure: undefined });
  await finished;
  expect(value.scheduler.getState()).toMatchObject({ confirmedText: 'corrected wording', provisionalText: '', confirmedRevision: 1, bufferedSeconds: 0 });
  expect(value.recognize).toHaveBeenCalledTimes(2);
});

it('prioritizes non-overlapping final regions and commits them once in source order', async () => {
  using value = fixture({ maxRegionSeconds: transcriptionRegionSeconds });
  const first = Promise.withResolvers<Result>();
  value.recognize.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ text: 'first final', status: 'complete', failure: undefined }).mockResolvedValueOnce({ text: 'second final', status: 'complete', failure: undefined }).mockResolvedValueOnce({ text: 'tail', status: 'complete', failure: undefined });
  value.append({ seconds: 1 });
  await vi.waitFor(() => expect(value.recognize).toHaveBeenCalledOnce());
  value.append({ seconds: 2 * transcriptionRegionSeconds });
  first.resolve({ text: 'first draft', status: 'complete', failure: undefined });
  await value.scheduler.finish();
  expect(value.recognize.mock.calls.map(([args]) => args.samples.length / sampleRate)).toEqual([1, transcriptionRegionSeconds, transcriptionRegionSeconds, 1]);
  expect(value.scheduler.getState()).toMatchObject({
    confirmedText: `\
first final
second final
tail`,
    provisionalText: '',
    confirmedRevision: 3,
    bufferedSeconds: 0,
  });
});

it('does not transfer master PCM and promotes the exact last successful prefix on stop', async () => {
  using value = fixture({ maxRegionSeconds: transcriptionRegionSeconds });
  const input = new Float32Array(sampleRate).fill(0.25);
  value.recognize.mockImplementation(async ({ samples }) => {
    expect(samples).not.toBe(input);
    const moved = structuredClone(samples, { transfer: [samples.buffer] });
    expect(moved[0]).toBe(0.25);
    return { text: 'complete prefix', status: 'complete', failure: undefined };
  });
  value.scheduler.append({ pcm: input });
  await vi.waitFor(() => expect(value.scheduler.getState().provisionalText).toBe('complete prefix'));
  expect(input.length).toBe(sampleRate);
  expect(value.scheduler.getState().confirmedText).toBe('');
  await value.scheduler.finish();
  expect(value.recognize).toHaveBeenCalledOnce();
  expect(value.scheduler.getState().confirmedText).toBe('complete prefix');
});

it('suppresses provisional jobs during capture flush but accepts and recognizes its final samples', async () => {
  using value = fixture({ maxRegionSeconds: transcriptionRegionSeconds });
  value.scheduler.prepareFinish();
  value.append({ seconds: 2 });
  await Promise.resolve();
  expect(value.recognize).not.toHaveBeenCalled();
  await value.scheduler.finish();
  expect(value.recognize.mock.calls[0]![0].samples.length).toBe(2 * sampleRate);
});

it('keeps an uninterrupted phrase provisional and commits it after a sustained pause', async () => {
  using value = fixture({ maxRegionSeconds: transcriptionRegionSeconds });
  value.append({ seconds: 8 });
  await vi.waitFor(() => expect(value.scheduler.getState().provisionalText).toBe('recognized'));
  expect(value.scheduler.getState().confirmedText).toBe('');
  value.scheduler.append({ pcm: new Float32Array(sampleRate * 0.2) });
  expect(value.scheduler.getState().pendingRegionCount).toBe(0);
  value.append({ seconds: 1 });
  value.scheduler.append({ pcm: new Float32Array(sampleRate * 0.5) });
  await vi.waitFor(() => expect(value.scheduler.getState().confirmedText).toBe('recognized'));
  expect(value.scheduler.getState().bufferedSeconds).toBe(0);
});

it('uses the configured segment ceiling for speech without a pause', async () => {
  using value = fixture({ maxRegionSeconds: 20 });
  value.append({ seconds: 21 });
  await value.scheduler.finish();
  expect(value.recognize.mock.calls.map(([args]) => args.samples.length / sampleRate)).toEqual([20, 1]);
});

it('measures microphone activity from the received frames before recognition can start', async () => {
  using value = fixture({ maxRegionSeconds: transcriptionRegionSeconds });
  value.append({ seconds: 0.08 });
  expect(value.scheduler.getState().microphoneLevel).toBe(0.25);
  value.scheduler.append({ pcm: new Float32Array(sampleRate * 0.08) });
  expect(value.scheduler.getState().microphoneLevel).toBe(0);
  expect(value.recognize).not.toHaveBeenCalled();
});

it('discards an old in-flight result when clearing text and continues on new microphone audio', async () => {
  using value = fixture({ maxRegionSeconds: transcriptionRegionSeconds });
  const first = Promise.withResolvers<Result>();
  value.recognize.mockReturnValueOnce(first.promise);
  value.append({ seconds: 1 });
  await vi.waitFor(() => expect(value.recognize).toHaveBeenCalledOnce());
  value.scheduler.clearText();
  value.append({ seconds: 1 });
  first.resolve({ text: 'discarded speech', status: 'complete', failure: undefined });
  await value.scheduler.finish();
  expect(value.scheduler.getState()).toMatchObject({ confirmedText: 'recognized', provisionalText: '', bufferedSeconds: 0, recordedSeconds: 2 });
});

it('processes input beyond 180 seconds while bounding every request and releasing confirmed PCM', async () => {
  using value = fixture({ maxRegionSeconds: transcriptionRegionSeconds });
  for (let index = 0; index < 28; index++) {
    value.append({ seconds: transcriptionRegionSeconds });
    await vi.waitFor(() => expect(value.scheduler.getState().bufferedSeconds).toBe(0));
  }
  await value.scheduler.finish();
  expect(value.scheduler.getState()).toMatchObject({ recordedSeconds: 28 * transcriptionRegionSeconds, confirmedRevision: 28, failure: undefined, stopReason: undefined });
  expect(value.recognize.mock.calls.every(([args]) => args.samples.length <= sampleRate * transcriptionRegionSeconds)).toBe(true);
});

it('requests a soft stop once when recognition falls behind and drains every accepted region', async () => {
  using value = fixture({ maxRegionSeconds: transcriptionRegionSeconds });
  const first = Promise.withResolvers<Result>();
  value.recognize.mockReturnValueOnce(first.promise);
  value.append({ seconds: 8 });
  await vi.waitFor(() => expect(value.recognize).toHaveBeenCalledOnce());
  value.append({ seconds: 37 });
  value.append({ seconds: 1 });
  await vi.waitFor(() => expect(value.onStopRequested).toHaveBeenCalledExactlyOnceWith({ reason: 'backpressure' }));
  expect(value.scheduler.getState().bufferedSeconds).toBe(46);
  const finished = value.scheduler.finish();
  first.resolve({ text: 'first', status: 'complete', failure: undefined });
  await finished;
  expect(value.scheduler.getState()).toMatchObject({ confirmedRevision: Math.ceil(46 / transcriptionRegionSeconds), bufferedSeconds: 0, failure: undefined, stopReason: 'backpressure' });
});

it('reports a hard bound explicitly without retaining an oversized input', async () => {
  using value = fixture({ maxRegionSeconds: transcriptionRegionSeconds });
  value.append({ seconds: 61 });
  await value.scheduler.finish();
  expect(value.scheduler.getState()).toMatchObject({ recordedSeconds: 0, bufferedSeconds: 0, failure: { code: 'queue_full' }, stopReason: 'buffer_limit' });
  expect(value.recognize).not.toHaveBeenCalled();
});

it.each(['cancelled', 'model_limit', 'max_seconds', 'failed'] as const)('keeps %s output provisional and never commits incomplete recognition', async status => {
  using value = fixture({ maxRegionSeconds: transcriptionRegionSeconds });
  const failure = status === 'failed' ? { code: 'runtime_failed' as const, message: 'native failed', nativeStatus: -9, nativeInput: 'audio' } : undefined;
  value.recognize.mockResolvedValue({ text: 'partial words', status, failure });
  value.append({ seconds: 1 });
  await value.scheduler.finish();
  expect(value.scheduler.getState()).toMatchObject({ confirmedText: '', confirmedRevision: 0, provisionalText: 'partial words', bufferedSeconds: 1, failure: failure ?? { code: 'runtime_failed' } });
});

it('preserves the previous useful draft when a later request returns a failed snapshot with empty text', async () => {
  using value = fixture({ maxRegionSeconds: transcriptionRegionSeconds });
  const failure = { code: 'runtime_failed' as const, message: 'native failed', nativeStatus: -9, nativeInput: 'audio' };
  value.recognize.mockResolvedValueOnce({ text: 'confirmed paragraph', status: 'complete', failure: undefined })
    .mockResolvedValueOnce({ text: 'previous draft', status: 'complete', failure: undefined })
    .mockResolvedValueOnce({ text: '', status: 'failed', failure });
  value.append({ seconds: transcriptionRegionSeconds });
  await vi.waitFor(() => expect(value.scheduler.getState().confirmedText).toBe('confirmed paragraph'));
  value.append({ seconds: 1 });
  await vi.waitFor(() => expect(value.scheduler.getState().provisionalText).toBe('previous draft'));
  value.append({ seconds: 1 });
  await value.scheduler.finish();
  expect(value.scheduler.getState()).toMatchObject({ confirmedText: 'confirmed paragraph', confirmedRevision: 1, provisionalText: 'previous draft', failure });
});

it('ignores a late result after discard', async () => {
  using value = fixture({ maxRegionSeconds: transcriptionRegionSeconds });
  const result = Promise.withResolvers<Result>();
  value.recognize.mockReturnValue(result.promise);
  value.append({ seconds: 1 });
  await vi.waitFor(() => expect(value.recognize).toHaveBeenCalledOnce());
  value.scheduler.discard();
  result.resolve({ text: 'late result', status: 'complete', failure: undefined });
  await Promise.resolve();
  expect(value.scheduler.getState().confirmedText).toBe('');
  expect(value.scheduler.getState().provisionalText).toBe('');
});

it('rejects invalid PCM before recognition', async () => {
  using value = fixture({ maxRegionSeconds: transcriptionRegionSeconds });
  value.scheduler.append({ pcm: new Float32Array([Number.NaN]) });
  expect(value.scheduler.getState().failure?.code).toBe('invalid_audio');
  expect(value.recognize).not.toHaveBeenCalled();
});
