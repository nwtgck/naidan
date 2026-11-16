import { nanoid } from 'nanoid';
import { speechFailure, type SpeechFailure } from '@/features/speech-cpp-browser/types';
import type { openLiveCapture, LiveCapture } from './audio-capture';
import { liveAudioSecondsLimit } from './audio-file';

export const speechRecordingSampleRate = 16000;
export type SpeechRecordingClip = { id: string, file: File, url: string, sampleRate: 16000, seconds: number, status: 'complete' | 'limit' | 'partial' };
export type SpeechRecordingState = { phase: 'idle' | 'opening' | 'recording' | 'stopping' | 'ready' | 'failed', elapsedSeconds: number, recordedSeconds: number, clip: SpeechRecordingClip | undefined, failure: SpeechFailure | undefined };

export function initialSpeechRecordingState(): SpeechRecordingState {
  return { phase: 'idle', elapsedSeconds: 0, recordedSeconds: 0, clip: undefined, failure: undefined };
}

/** One bounded recording, using the same browser AEC/NS and mono resampler as
 * conversation capture. No native model is required until recognition starts. */
export function createSpeechRecognitionRecording({ capture, now, onChange, onRecorded }: {
  capture: typeof openLiveCapture,
  now: () => number,
  onChange: ({ state }: { state: SpeechRecordingState }) => void,
  onRecorded: ({ samples, sampleRate, file, language }: { samples: Float32Array<ArrayBuffer>, sampleRate: 16000, file: File, language: string | undefined }) => Promise<void>,
}) {
  type Recording = { lifetime: AbortController, chunks: Float32Array<ArrayBuffer>[], samples: number, capture: LiveCapture | undefined, startedAt: number | undefined, timer: ReturnType<typeof setInterval> | undefined, stopping: Promise<void> | undefined, limited: boolean, language: string | undefined };
  const maximumSamples = speechRecordingSampleRate * liveAudioSecondsLimit;
  let state = initialSpeechRecordingState(), current: Recording | undefined, disposed = false;
  function publish({ change }: { change: Partial<SpeechRecordingState> }): void {
    state = { ...state, ...change };
    if (!disposed) {
      onChange({ state });
    }
  }
  function close({ recording }: { recording: Recording }): void {
    clearInterval(recording.timer);
    recording.lifetime.abort();
    void recording.capture?.finish({ action: 'discard' }).catch(() => {});
  }
  function revoke(): void {
    if (state.clip !== undefined) {
      URL.revokeObjectURL(state.clip.url);
    }
  }
  function discard(): void {
    const previous = current;
    current = undefined;
    if (previous !== undefined) {
      close({ recording: previous });
      previous.chunks = [];
    }
    revoke();
    publish({ change: initialSpeechRecordingState() });
  }
  function snapshot({ recording, status }: { recording: Recording, status: SpeechRecordingClip['status'] }): { samples: Float32Array<ArrayBuffer>, clip: SpeechRecordingClip } | undefined {
    if (recording.samples === 0) {
      return undefined;
    }
    const samples = new Float32Array(recording.samples);
    let offset = 0;
    for (const chunk of recording.chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    recording.chunks = [];
    // IEEE float WAV preserves the PCM used by ASR. At 16 kHz/180 seconds,
    // PCM + chunks + WAV staging + Blob are below 64 MiB even at finalization.
    const bytes = new Uint8Array(44 + samples.byteLength), view = new DataView(bytes.buffer);
    for (const [position, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
      bytes.set(new TextEncoder().encode(text), position);
    }
    view.setUint32(4, samples.byteLength + 36, true);
    view.setUint32(16, 16, true);
    view.setUint16(20, 3, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, speechRecordingSampleRate, true);
    view.setUint32(28, speechRecordingSampleRate * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 32, true);
    view.setUint32(40, samples.byteLength, true);
    for (let index = 0; index < samples.length; index++) {
      view.setFloat32(44 + index * 4, samples[index]!, true);
    }
    const id = nanoid(), file = new File([bytes], `naidan-recording-${id}.wav`, { type: 'audio/wav' });
    return { samples, clip: { id, file, url: URL.createObjectURL(file), sampleRate: speechRecordingSampleRate, seconds: samples.length / speechRecordingSampleRate, status } };
  }
  function fail({ recording, error }: { recording: Recording, error: unknown }): void {
    if (current !== recording) {
      return;
    }
    current = undefined;
    close({ recording });
    let clip: SpeechRecordingClip | undefined;
    try {
      clip = recording.chunks.length > 0 ? snapshot({ recording, status: 'partial' })?.clip : undefined;
    } catch { /* Preserve the original capture failure. */ }
    publish({ change: { phase: 'failed', clip, failure: speechFailure({ error }) } });
  }
  async function stop(): Promise<void> {
    const recording = current;
    if (recording === undefined) {
      return;
    }
    if (recording.stopping !== undefined) {
      await recording.stopping;
      return;
    }
    if (recording.capture === undefined) {
      discard();
      return;
    }
    clearInterval(recording.timer);
    publish({ change: { phase: 'stopping' } });
    const capture = recording.capture;
    recording.stopping = (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          const aborted = () => reject(recording.lifetime.signal.reason);
          recording.lifetime.signal.addEventListener('abort', aborted, { once: true });
          if (recording.lifetime.signal.aborted) {
            aborted();
            return;
          }
          void capture.finish({ action: 'send' }).then(resolve, reject).finally(() => recording.lifetime.signal.removeEventListener('abort', aborted));
        });
        if (current !== recording || recording.lifetime.signal.aborted) {
          return;
        }
        const result = snapshot({ recording, status: recording.limited ? 'limit' : 'complete' });
        current = undefined;
        close({ recording });
        if (result === undefined) {
          publish({ change: { phase: 'idle' } });
          return;
        }
        publish({ change: { phase: 'ready', clip: result.clip, recordedSeconds: result.clip.seconds } });
        if (disposed || state.clip?.id !== result.clip.id) {
          return;
        }
        await onRecorded({ samples: result.samples, sampleRate: speechRecordingSampleRate, file: result.clip.file, language: recording.language });
      } catch (error) {
        fail({ recording, error });
      }
    })();
    await recording.stopping;
  }
  return {
    getState: () => state,
    async start({ language }: { language: string | undefined }): Promise<void> {
      if (disposed) {
        return;
      }
      discard();
      const recording: Recording = { lifetime: new AbortController(), chunks: [], samples: 0, capture: undefined, startedAt: undefined, timer: undefined, stopping: undefined, limited: false, language };
      current = recording;
      publish({ change: { phase: 'opening' } });
      try {
        const opening = capture({
          sampleRate: speechRecordingSampleRate,
          signal: recording.lifetime.signal,
          onPcm({ pcm }) {
            if (current !== recording || recording.lifetime.signal.aborted) {
              return;
            }
            if (pcm.some(sample => !Number.isFinite(sample) || sample < -1 || sample > 1)) {
              fail({ recording, error: new Error('Invalid recording samples') });
              return;
            }
            const count = Math.min(pcm.length, maximumSamples - recording.samples);
            if (count > 0) {
              recording.chunks.push(new Float32Array(pcm.subarray(0, count)));
              recording.samples += count;
            }
            publish({ change: { recordedSeconds: recording.samples / speechRecordingSampleRate } });
            if (recording.samples === maximumSamples) {
              recording.limited = true;
              void Promise.resolve().then(async () => {
                if (current === recording) {
                  await stop();
                }
              });
            }
          },
          onError: ({ error }) => fail({ recording, error }),
        });
        // Permission can resolve after discard/navigation. The late handle must
        // still be closed even when a test/platform capture ignores its signal.
        void opening.then(value => {
          if (current !== recording || recording.lifetime.signal.aborted) {
            void value.finish({ action: 'discard' }).catch(() => {});
          }
        }, () => {});
        recording.capture = await new Promise<LiveCapture>((resolve, reject) => {
          const aborted = () => reject(recording.lifetime.signal.reason);
          recording.lifetime.signal.addEventListener('abort', aborted, { once: true });
          if (recording.lifetime.signal.aborted) {
            aborted();
          }
          void opening.then(resolve, reject).finally(() => recording.lifetime.signal.removeEventListener('abort', aborted));
        });
        if (current !== recording || recording.lifetime.signal.aborted) {
          return;
        }
        recording.startedAt = now();
        publish({ change: { phase: 'recording' } });
        recording.timer = setInterval(() => {
          if (current !== recording || recording.startedAt === undefined) {
            return;
          }
          const elapsedSeconds = Math.min(liveAudioSecondsLimit, Math.max(0, (now() - recording.startedAt) / 1000));
          publish({ change: { elapsedSeconds } });
          if (current === recording && elapsedSeconds === liveAudioSecondsLimit) {
            recording.limited = true;
            void stop();
          }
        }, 100);
      } catch (error) {
        fail({ recording, error });
      }
    },
    stop,
    async discard(): Promise<void> {
      discard();
    },
    async dispose(): Promise<void> {
      disposed = true;
      discard();
    },
  };
}

export const TEST_ONLY = {
};
