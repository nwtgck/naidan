// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { openLiveCapture, type LiveCapture } from '@/features/live-conversation/logic/audio-capture';
import { useSpeechResponseRecording } from './useSpeechResponseRecording';

vi.mock('@/features/live-conversation/logic/audio-capture', () => ({ openLiveCapture: vi.fn() }));
vi.mock('@/features/live-conversation/logic/audio-file', () => ({ liveAudioSecondsLimit: 180 }));

function fixture() {
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:response-recording');
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const finish = vi.fn<LiveCapture['finish']>(async () => {});
  vi.mocked(openLiveCapture).mockReset().mockResolvedValue({ finish });
  const scope = effectScope(), api = scope.run(() => useSpeechResponseRecording())!;
  return {
    api,
    scope,
    finish,
    createUrl,
    revokeUrl,
    pcm({ samples }: { samples: Float32Array<ArrayBuffer> }): void {
      vi.mocked(openLiveCapture).mock.calls.at(-1)![0].onPcm({ pcm: samples });
    },
    async [Symbol.asyncDispose]() {
      scope.stop();
      await Promise.resolve();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
      vi.useRealTimers();
    },
  };
}

it('records without a model and leaves the same exact WAV File ready for an explicit file run', async () => {
  await using f = fixture();
  await f.api.recording.start();
  const packet = new Float32Array([0.25, -0.5]);
  f.pcm({ samples: packet });
  packet.fill(1);
  await f.api.recording.stop();
  expect(f.api.recordingState.value).toMatchObject({ phase: 'ready', recordedSeconds: 2 / 16000, clip: { sampleRate: 16000, status: 'complete' } });
  const file = f.api.recordingState.value.clip!.file;
  expect(file).toBeInstanceOf(File);
  const view = new DataView(await file.arrayBuffer());
  expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getFloat32(44, true)).toBe(0.25);
  expect(view.getFloat32(48, true)).toBe(-0.5);
  expect(f.createUrl).toHaveBeenCalledExactlyOnceWith(file);
  expect(f.finish.mock.calls.filter(([{ action }]) => action === 'send')).toHaveLength(1);
  await Promise.resolve();
  expect(f.api.recordingState.value.clip!.file).toBe(file);
  await f.api.recording.discard();
  expect(f.api.recordingState.value.phase).toBe('idle');
  expect(f.revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:response-recording');
  expect(file.size).toBe(52);
});

it.each(['stop', 'discard', 'scope'] as const)('%s cancels pending microphone permission and closes a late handle', async operation => {
  await using f = fixture();
  const permission = Promise.withResolvers<LiveCapture>();
  vi.mocked(openLiveCapture).mockReturnValueOnce(permission.promise);
  const opening = f.api.recording.start();
  expect(f.api.recordingState.value.phase).toBe('opening');
  if (operation === 'scope') {
    f.scope.stop();
  } else {
    await f.api.recording[operation]();
  }
  await opening;
  expect(vi.mocked(openLiveCapture).mock.calls[0]![0].signal.aborted).toBe(true);
  permission.resolve({ finish: f.finish });
  await Promise.resolve();
  expect(f.finish).toHaveBeenCalledWith({ action: 'discard' });
  expect(f.createUrl).not.toHaveBeenCalled();
});

it('revokes a completed recording when replaced and releases capture and URL on scope disposal', async () => {
  await using f = fixture();
  await f.api.recording.start();
  f.pcm({ samples: new Float32Array([0.125]) });
  await f.api.recording.stop();
  const original = f.api.recordingState.value.clip!.file;
  await f.api.recording.start();
  expect(f.revokeUrl).toHaveBeenCalledOnce();
  expect(f.api.recordingState.value.clip).toBeUndefined();
  f.pcm({ samples: new Float32Array([0.5]) });
  await f.api.recording.stop();
  expect(f.api.recordingState.value.clip!.file).not.toBe(original);
  f.scope.stop();
  expect(f.revokeUrl).toHaveBeenCalledTimes(2);
  expect(vi.mocked(openLiveCapture).mock.calls.every(([{ signal }]) => signal.aborted)).toBe(true);
});

it('keeps the bounded recorder deadline and leaves a limit-marked WAV instead of starting generation', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  await using f = fixture();
  await f.api.recording.start();
  f.pcm({ samples: new Float32Array([0.25]) });
  await vi.advanceTimersByTimeAsync(180000);
  expect(f.api.recordingState.value).toMatchObject({ phase: 'ready', elapsedSeconds: 180, clip: { status: 'limit', seconds: 1 / 16000 } });
  expect(f.createUrl).toHaveBeenCalledOnce();
  expect(vi.mocked(openLiveCapture).mock.calls[0]![0].signal.aborted).toBe(true);
});
