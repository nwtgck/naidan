// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createSpeechRecognitionRecording, speechRecordingSampleRate } from './speech-recognition-recording';
import type { openLiveCapture, LiveCapture } from './audio-capture';

function fixture() {
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recording');
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const finish = vi.fn<LiveCapture['finish']>(async () => {});
  const capture = vi.fn<typeof openLiveCapture>(async () => ({ finish }));
  const onRecorded = vi.fn<Parameters<typeof createSpeechRecognitionRecording>[0]['onRecorded']>(async () => {});
  const recorder = createSpeechRecognitionRecording({ capture, onRecorded, now: () => performance.now(), onChange() {} });
  return {
    recorder,
    capture,
    finish,
    onRecorded,
    createUrl,
    revokeUrl,
    pcm({ samples }: { samples: Float32Array }): void {
 capture.mock.calls.at(-1)![0].onPcm({ pcm: samples });
    },
    async [Symbol.asyncDispose]() {
      await recorder.dispose();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
      vi.useRealTimers();
    },
  };
}

it('flushes once and preserves the exact recorded PCM in a reusable float WAV and the direct recognition call', async () => {
  await using value = fixture();
  await value.recorder.start({ language: 'ja' });
  const samples = new Float32Array([0, -0.25, 0.5]);
  value.pcm({ samples });
  samples.fill(1);
  value.finish.mockImplementation(async ({ action }) => {
    if (action === 'send') {
      value.pcm({ samples: new Float32Array([0.125]) });
    }
  });
  await Promise.all([value.recorder.stop(), value.recorder.stop()]);
  const state = value.recorder.getState();
  expect(state).toMatchObject({ phase: 'ready', clip: { sampleRate: 16000, seconds: 4 / 16000, status: 'complete' } });
  expect(value.finish.mock.calls.filter(([{ action }]) => action === 'send')).toHaveLength(1);
  expect(value.onRecorded).toHaveBeenCalledOnce();
  const audio = value.onRecorded.mock.calls[0]![0];
  expect(Array.from(audio.samples)).toEqual([0, -0.25, 0.5, 0.125]);
  expect(audio.file).toBe(state.clip!.file);
  expect(audio.language).toBe('ja');
  const view = new DataView(await state.clip!.file.arrayBuffer());
  expect(view.getUint16(20, true)).toBe(3);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(speechRecordingSampleRate);
  expect(view.getUint32(40, true)).toBe(16);
  expect(Array.from({ length: 4 }, (_, index) => view.getFloat32(44 + index * 4, true))).toEqual([0, -0.25, 0.5, 0.125]);
  const file = state.clip!.file;
  await value.recorder.discard();
  expect(value.revokeUrl).toHaveBeenCalledWith('blob:recording');
  expect(file.size).toBe(60);
  expect((await file.arrayBuffer()).byteLength).toBe(60);
});

it.each(['discard', 'dispose', 'stop'] as const)('%s cancels a pending permission immediately and closes a late capture handle', async operation => {
  await using value = fixture();
  const permission = Promise.withResolvers<LiveCapture>();
  value.capture.mockReturnValue(permission.promise);
  const opening = value.recorder.start({ language: undefined });
  expect(value.recorder.getState().phase).toBe('opening');
  await value.recorder[operation]();
  await opening;
  expect(value.capture.mock.calls[0]![0].signal.aborted).toBe(true);
  permission.resolve({ finish: value.finish });
  await Promise.resolve();
  expect(value.finish).toHaveBeenCalledWith({ action: 'discard' });
  expect(value.recorder.getState().phase).toBe('idle');
  expect(value.onRecorded).not.toHaveBeenCalled();
});

it('discards a pending flush and ignores its late completion after a new recording starts', async () => {
  await using value = fixture();
  await value.recorder.start({ language: undefined });
  value.pcm({ samples: new Float32Array([0.25]) });
  const flushed = Promise.withResolvers<void>();
  value.finish.mockImplementation(async ({ action }) => {
    if (action === 'send') {
      await flushed.promise;
    }
  });
  const stopped = value.recorder.stop();
  await value.recorder.discard();
  await stopped;
  await value.recorder.start({ language: undefined });
  flushed.resolve();
  await Promise.resolve();
  expect(value.recorder.getState().phase).toBe('recording');
  expect(value.onRecorded).not.toHaveBeenCalled();
  expect(value.createUrl).not.toHaveBeenCalled();
});

it('bounds PCM at 180 seconds and shares automatic/manual stopping without a second finalization', async () => {
  await using value = fixture();
  await value.recorder.start({ language: undefined });
  value.pcm({ samples: new Float32Array(16000 * 180 + 100) });
  await value.recorder.stop();
  expect(value.recorder.getState()).toMatchObject({ phase: 'ready', recordedSeconds: 180, clip: { seconds: 180, status: 'limit' } });
  expect(value.onRecorded).toHaveBeenCalledOnce();
  expect(value.onRecorded.mock.calls[0]![0].samples.length).toBe(16000 * 180);
  expect(value.recorder.getState().clip!.file.size).toBe(44 + 16000 * 180 * 4);
  expect(value.recorder.getState().clip!.file.size).toBeLessThan(16 * 1024 * 1024);
});

it('publishes elapsed time independently of PCM duration and automatically stops the wall-clock deadline', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  await using value = fixture();
  await value.recorder.start({ language: undefined });
  value.pcm({ samples: new Float32Array(160) });
  await vi.advanceTimersByTimeAsync(1100);
  expect(value.recorder.getState()).toMatchObject({ elapsedSeconds: 1.1, recordedSeconds: 0.01 });
  await vi.advanceTimersByTimeAsync(178900);
  expect(value.recorder.getState()).toMatchObject({ phase: 'ready', elapsedSeconds: 180, clip: { status: 'limit', seconds: 0.01 } });
  expect(value.onRecorded).toHaveBeenCalledOnce();
  expect(value.capture.mock.calls[0]![0].signal.aborted).toBe(true);
});

it('does not let an old limit callback stop a replacement recording in the same turn', async () => {
  await using value = fixture();
  await value.recorder.start({ language: undefined });
  value.pcm({ samples: new Float32Array(16000 * 180) });
  await value.recorder.start({ language: 'ja' });
  await Promise.resolve();
  expect(value.recorder.getState()).toMatchObject({ phase: 'recording', recordedSeconds: 0, clip: undefined });
  expect(value.onRecorded).not.toHaveBeenCalled();
  expect(value.capture.mock.calls[1]![0].signal.aborted).toBe(false);
});

it('reports a disconnected microphone honestly and keeps a partial WAV without automatically recognizing it', async () => {
  await using value = fixture();
  await value.recorder.start({ language: undefined });
  value.pcm({ samples: new Float32Array([0.25]) });
  value.capture.mock.calls[0]![0].onError({ error: new Error('microphone disconnected') });
  expect(value.recorder.getState()).toMatchObject({ phase: 'failed', clip: { status: 'partial' }, failure: { message: 'microphone disconnected' } });
  expect(value.onRecorded).not.toHaveBeenCalled();
  expect(value.capture.mock.calls[0]![0].signal.aborted).toBe(true);
});

it('rejects nonfinite samples without producing a misleading complete recording', async () => {
  await using value = fixture();
  await value.recorder.start({ language: undefined });
  value.pcm({ samples: new Float32Array([NaN]) });
  expect(value.recorder.getState()).toMatchObject({ phase: 'failed', clip: undefined });
  expect(value.onRecorded).not.toHaveBeenCalled();
  expect(value.capture.mock.calls[0]![0].signal.aborted).toBe(true);
});
