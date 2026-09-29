import { computed, onScopeDispose, ref } from 'vue';
import { MAX_REFERENCE_BYTES, MAX_REFERENCE_SECONDS } from '@/features/audio-generation/types';
import { ReferenceAudioError, type ReferenceAudioErrorCode } from '@/features/audio-generation/reference-audio';

type RecordingSession = {
  controller: AbortController,
  stream: MediaStream | undefined,
  recorder: MediaRecorder | undefined,
  stopTracks: () => void,
  detach: () => void,
  timer: ReturnType<typeof setTimeout> | undefined,
  clock: ReturnType<typeof setInterval> | undefined,
};
/** Microphone access starts ONLY on the explicit Record action. A cancelled or
 * abandoned permission prompt may still resolve; stop those late tracks at once.
 * Keep capture and normalization separate from the shared inference Worker.
 */
export function useReferenceRecording({ accept }: { accept: ({ blob, signal }: { blob: Blob, signal: AbortSignal }) => Promise<void> }) {
  const status = ref<'idle' | 'requesting' | 'recording' | 'stopping' | 'processing'>('idle');
  const elapsed = ref(0); const error = ref<ReferenceAudioErrorCode>();
  const supported = computed(() => typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof MediaRecorder === 'function' && typeof OfflineAudioContext === 'function');
  let current: RecordingSession | undefined; let disposed = false;
  function release({ session }: { session: RecordingSession }): void {
    if (session.timer !== undefined) clearTimeout(session.timer);
    if (session.clock !== undefined) clearInterval(session.clock);
    session.timer = undefined; session.clock = undefined;
    session.stopTracks();
  }
  function fail({ session, cause }: { session: RecordingSession, cause: unknown }): void {
    if (current !== session) return;
    error.value = cause instanceof ReferenceAudioError ? cause.code : (cause instanceof Error || cause instanceof DOMException) && ['NotAllowedError', 'SecurityError'].includes(cause.name) ? 'permission' : (cause instanceof Error || cause instanceof DOMException) && ['NotFoundError', 'NotReadableError'].includes(cause.name) ? 'microphone' : 'recording';
    cancel();
  }
  function cancel(): void {
    const session = current; current = undefined;
    if (session) {
      session.controller.abort(); session.detach();
      try {
        const recorder = session.recorder;
        if (recorder) {
          const state = recorder.state;
          switch (state) {
          case 'recording': case 'paused': recorder.stop(); break;
          case 'inactive': break;
          default: { const exhaustive: never = state; throw new Error(String(exhaustive)); }
          }
        }
      } catch { /* Tracks must still be released. */ }
      release({ session });
    }
    status.value = 'idle';
  }
  function stop(): void {
    const session = current;
    if (!session || status.value !== 'recording') return;
    status.value = 'stopping';
    try {
      session.recorder!.stop();
      // stop() schedules a final dataavailable/stop pair; the microphone is no
      // longer needed while waiting for those events or browser decoding.
      release({ session });
    } catch (cause) {
      fail({ session, cause });
    }
  }
  async function start(): Promise<void> {
    if (disposed || current) return;
    error.value = undefined; elapsed.value = 0;
    if (!supported.value) {
      error.value = 'unavailable'; return;
    }
    const session: RecordingSession = { controller: new AbortController(), stream: undefined, recorder: undefined, stopTracks: () => {}, detach: () => {}, timer: undefined, clock: undefined };
    current = session; status.value = 'requesting';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (current !== session || disposed) {
        stream.getTracks().forEach(track => track.stop()); return;
      }
      session.stream = stream;
      let tracksStopped = false;
      session.stopTracks = () => {
        if (tracksStopped) return; tracksStopped = true;
        stream.getTracks().forEach(track => track.stop());
      };
      const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      session.recorder = recorder;
      const chunks: Blob[] = []; let size = 0;
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Browser MediaRecorder event listener signature.
      const data = (event: BlobEvent): void => {
        if (current !== session || !event.data.size) return;
        size += event.data.size;
        if (size > MAX_REFERENCE_BYTES) {
          fail({ session, cause: new ReferenceAudioError({ code: 'too-large' }) }); return;
        }
        chunks.push(event.data);
      };
      const failed = (): void => fail({ session, cause: new ReferenceAudioError({ code: 'recording' }) });
      const ended = (): void => stop();
      const complete = async (): Promise<void> => {
        if (current !== session) return;
        release({ session }); session.detach();
        status.value = 'processing';
        try {
          if (!size) throw new ReferenceAudioError({ code: 'empty' });
          await accept({ blob: new Blob(chunks, { type: recorder.mimeType || chunks[0]!.type }), signal: session.controller.signal });
          if (current === session) {
            current = undefined; status.value = 'idle';
          }
        } catch (cause) {
          fail({ session, cause });
        }
      };
      const stopped = (): void => {
        void complete();
      };
      recorder.addEventListener('dataavailable', data); recorder.addEventListener('stop', stopped); recorder.addEventListener('error', failed);
      stream.getAudioTracks().forEach(track => track.addEventListener('ended', ended));
      session.detach = () => {
        recorder.removeEventListener('dataavailable', data); recorder.removeEventListener('stop', stopped); recorder.removeEventListener('error', failed);
        stream.getAudioTracks().forEach(track => track.removeEventListener('ended', ended));
      };
      recorder.start(250); status.value = 'recording';
      const started = performance.now();
      session.clock = setInterval(() => {
        elapsed.value = (performance.now() - started) / 1000;
      }, 250);
      session.timer = setTimeout(stop, MAX_REFERENCE_SECONDS * 1000);
    } catch (cause) {
      fail({ session, cause });
    }
  }
  onScopeDispose(() => {
    disposed = true; cancel();
  });
  return { status, elapsed, error, supported, start, stop, cancel, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}
export const TEST_ONLY = {
};
