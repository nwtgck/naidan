import { effectScope, type EffectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReferenceRecording } from './useReferenceRecording';
import { MAX_REFERENCE_BYTES, MAX_REFERENCE_SECONDS } from '@/features/audio-generation/types';
class Track extends EventTarget {
  stop = vi.fn();
}
class Recorder extends EventTarget {
  static instances: Recorder[] = [];
  static isTypeSupported = vi.fn((type: string) => type === 'audio/webm;codecs=opus');
  state: RecordingState = 'inactive'; mimeType = 'audio/webm;codecs=opus';
  // Emulates the browser constructor contract.
  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    super(); Recorder.instances.push(this); if (options?.mimeType) this.mimeType = options.mimeType;
  }
  start = vi.fn(() => {
    this.state = 'recording';
  });
  stop = vi.fn(() => {
    this.state = 'inactive';
  });
  data({ blob }: { blob: Blob }): void {
    this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: blob }));
  }
  complete(): void {
    this.dispatchEvent(new Event('stop'));
  }
}
const getUserMedia = vi.fn<MediaDevices['getUserMedia']>();
const accept = vi.fn<Parameters<typeof useReferenceRecording>[0]['accept']>();
let scope: EffectScope; let track: Track; let stream: MediaStream;
beforeEach(() => {
  vi.useFakeTimers(); scope = effectScope(); track = new Track(); Recorder.instances = [];
  stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  accept.mockReset(); accept.mockResolvedValue(undefined); getUserMedia.mockReset(); getUserMedia.mockResolvedValue(stream);
  Recorder.isTypeSupported.mockReset(); Recorder.isTypeSupported.mockImplementation(type => type === 'audio/webm;codecs=opus');
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } }); vi.stubGlobal('MediaRecorder', Recorder); vi.stubGlobal('OfflineAudioContext', class {});
});
afterEach(() => {
  scope.stop(); vi.useRealTimers(); vi.unstubAllGlobals();
});
function recorder() {
  return scope.run(() => useReferenceRecording({ accept }))!;
}
async function flush() {
  await Promise.resolve(); await Promise.resolve();
}
describe('explicit microphone capture lifetime', () => {
  it('never requests permission on construction, then records audio only', async () => {
    const value = recorder(); expect(getUserMedia).not.toHaveBeenCalled(); expect(value.supported.value).toBe(true);
    await value.start(); expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(value.status.value).toBe('recording'); expect(Recorder.instances[0]!.start).toHaveBeenCalledWith(250);
  });
  it('stops microphone tracks before waiting for final data and normalization', async () => {
    const value = recorder(); await value.start(); const native = Recorder.instances[0]!;
    native.data({ blob: new Blob(['first']) }); value.stop();
    expect(track.stop).toHaveBeenCalledOnce(); expect(value.status.value).toBe('stopping'); expect(accept).not.toHaveBeenCalled();
    native.data({ blob: new Blob(['last']) }); native.complete(); await flush();
    expect(accept).toHaveBeenCalledOnce(); expect(accept.mock.calls[0]![0].blob.size).toBe(9); expect(accept.mock.calls[0]![0].blob.type).toBe('audio/webm;codecs=opus');
    expect(value.status.value).toBe('idle'); expect(track.stop).toHaveBeenCalledOnce(); expect(value.error.value).toBeUndefined();
  });
  it('uses a fresh permission request and session for each new recording', async () => {
    const value = recorder(); await value.start(); value.cancel();
    const nextTrack = new Track(); getUserMedia.mockResolvedValueOnce({ getTracks: () => [nextTrack], getAudioTracks: () => [nextTrack] } as unknown as MediaStream);
    await value.start(); expect(Recorder.instances).toHaveLength(2); value.cancel();
    expect(track.stop).toHaveBeenCalledOnce(); expect(nextTrack.stop).toHaveBeenCalledOnce();
  });
  it('automatically requests stop at the duration cap', async () => {
    const value = recorder(); await value.start(); await vi.advanceTimersByTimeAsync(MAX_REFERENCE_SECONDS * 1000);
    expect(Recorder.instances[0]!.stop).toHaveBeenCalledOnce(); expect(track.stop).toHaveBeenCalledOnce(); expect(value.status.value).toBe('stopping');
  });
  it('does not retain permission requests that resolve after cancellation', async () => {
    const pending = Promise.withResolvers<MediaStream>(); getUserMedia.mockReturnValueOnce(pending.promise);
    const value = recorder(); const start = value.start(); expect(value.status.value).toBe('requesting'); value.cancel();
    pending.resolve(stream); await start;
    expect(track.stop).toHaveBeenCalledOnce(); expect(Recorder.instances).toHaveLength(0); expect(value.status.value).toBe('idle');
  });
  it('releases late permission tracks after route disposal', async () => {
    const pending = Promise.withResolvers<MediaStream>(); getUserMedia.mockReturnValueOnce(pending.promise);
    const value = recorder(); const start = value.start(); scope.stop(); pending.resolve(stream); await start;
    expect(track.stop).toHaveBeenCalledOnce(); expect(Recorder.instances).toHaveLength(0); expect(accept).not.toHaveBeenCalled();
  });
  it('permission denial is recoverable and does not retain the microphone', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    const value = recorder(); await value.start(); expect(value.error.value).toBe('permission'); expect(value.status.value).toBe('idle');
    await value.start(); expect(value.status.value).toBe('recording'); expect(value.error.value).toBeUndefined();
  });
  it('cleans up when recorder construction fails after permission is granted', async () => {
    vi.stubGlobal('MediaRecorder', class {
      static isTypeSupported = () => false; constructor() {
        throw new Error('failed');
      }
    });
    const value = recorder(); await value.start(); expect(track.stop).toHaveBeenCalledOnce(); expect(value.status.value).toBe('idle'); expect(value.error.value).toBe('recording');
  });
  it('discarded or abandoned recordings cannot publish late chunks', async () => {
    const value = recorder(); await value.start(); const native = Recorder.instances[0]!;
    native.data({ blob: new Blob(['before']) }); value.cancel(); native.data({ blob: new Blob(['after']) }); native.complete(); await flush();
    expect(track.stop).toHaveBeenCalledOnce(); expect(accept).not.toHaveBeenCalled(); expect(value.status.value).toBe('idle');
  });
  it('cancels processing and does not change a newer recording when old processing resolves', async () => {
    const pending = Promise.withResolvers<void>(); accept.mockReturnValueOnce(pending.promise);
    const value = recorder(); await value.start(); const native = Recorder.instances[0]!; native.data({ blob: new Blob(['x']) }); value.stop(); native.complete();
    expect(value.status.value).toBe('processing'); const signal = accept.mock.calls[0]![0].signal; value.cancel(); expect(signal.aborted).toBe(true);
    await value.start(); pending.resolve(); await flush(); expect(value.status.value).toBe('recording');
  });
  it('reports empty or failed recording and allows retry', async () => {
    const value = recorder(); await value.start(); value.stop(); Recorder.instances[0]!.complete(); await flush();
    expect(value.error.value).toBe('empty'); expect(accept).not.toHaveBeenCalled(); await value.start();
    Recorder.instances[1]!.dispatchEvent(new Event('error')); expect(value.error.value).toBe('recording'); expect(value.status.value).toBe('idle');
  });
  it('bounds accumulated recording bytes and discards oversize chunks', async () => {
    const value = recorder(); await value.start(); const blob = new Blob(['x']); Object.defineProperty(blob, 'size', { value: MAX_REFERENCE_BYTES + 1 });
    Recorder.instances[0]!.data({ blob }); expect(value.error.value).toBe('too-large'); expect(track.stop).toHaveBeenCalledOnce(); expect(accept).not.toHaveBeenCalled();
  });
  it('stops on device removal and disposes an active recording on route exit', async () => {
    const value = recorder(); await value.start(); track.dispatchEvent(new Event('ended'));
    expect(Recorder.instances[0]!.stop).toHaveBeenCalledOnce(); scope.stop(); expect(track.stop).toHaveBeenCalledOnce();
  });
  it('does not attempt a permission request when required browser functions are unavailable', async () => {
    vi.stubGlobal('OfflineAudioContext', undefined); const value = recorder(); expect(value.supported.value).toBe(false);
    await value.start(); expect(value.error.value).toBe('unavailable'); expect(getUserMedia).not.toHaveBeenCalled();
  });
});
