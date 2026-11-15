import type { SpeechCompletionReason, SpeechFailure, SpeechState } from '@/features/speech-cpp-browser/types';
import { speechFailure, speechSampleRate } from '@/features/speech-cpp-browser/types';
import type { SpeechClient, SpeechObservers } from '@/features/speech-cpp-browser/worker/types';
import type { openLiveCapture, LiveCapture } from './audio-capture';
import type { createLivePlayback } from './audio-playback';
import type { decodeLiveAudioFile } from './audio-file';
import { createSpeechFileRun, type SpeechFileRunState } from './speech-file-run';

export type LiveSpeechSession = { id: string, modelName: string, text: string, completion: SpeechCompletionReason | undefined };
export type LiveSpeechState = {
  runtime: SpeechState,
  sessions: LiveSpeechSession[],
  microphone: 'on' | 'off',
  capture: 'closed' | 'opening' | 'open',
  playing: boolean,
  warning: 'input-backpressure' | 'output-backpressure' | undefined,
  failure: SpeechFailure | undefined,
  fileRun: SpeechFileRunState | undefined,
};

export function initialLiveSpeechState(): LiveSpeechState {
  return {
    runtime: { phase: 'unloaded', model: undefined, queuedSamples: 0, completion: undefined, failure: undefined, loadProgress: undefined },
    sessions: [],
    microphone: 'on',
    capture: 'closed',
    playing: false,
    warning: undefined,
    failure: undefined,
    fileRun: undefined,
  };
}

/** A session is a continuous, simultaneous input/output stream. It does not
 * emulate the turn IDs, transcription or rollback of the LFM live protocol. */
export function createLiveSpeechController({ createClient, capture, playback, decodeFile, onChange }: {
  createClient: ({ observers }: { observers: SpeechObservers }) => SpeechClient,
  capture: typeof openLiveCapture,
  playback: typeof createLivePlayback,
  decodeFile: typeof decodeLiveAudioFile,
  onChange: ({ state }: { state: LiveSpeechState }) => void,
}) {
  let disposed = false;
  let microphone: { lifetime: AbortController, capture: LiveCapture | undefined } | undefined;
  let player: ReturnType<typeof createLivePlayback> | undefined;
  let sessionId: string | undefined;
  let outputTail = Promise.resolve();
  let queuedOutputSamples = 0;
  let outputEpoch = 0;
  let stopping: Promise<void> | undefined;
  let fileRun: ReturnType<typeof createSpeechFileRun> | undefined;
  let fileTask: Promise<void> | undefined;
  let audible: 'on' | 'off' = 'on';
  let state = initialLiveSpeechState();
  function publish({ change }: { change: Partial<LiveSpeechState> }): void {
    state = { ...state, ...change };
    if (!disposed) {
      onChange({ state });
    }
  }
  function endCapture(): void {
    const current = microphone;
    microphone = undefined;
    publish({ change: { capture: 'closed' } });
    current?.lifetime.abort();
    void current?.capture?.finish({ action: 'discard' }).catch(() => {});
  }
  function endOutput(): void {
    outputEpoch++;
    player?.stop();
  }
  function fail({ error }: { error: unknown }): void {
    if (disposed) {
      return;
    }
    publish({ change: { failure: speechFailure({ error }) } });
    void stop({ mode: 'cancel' }).catch(() => {});
  }
  const client = createClient({
    observers: {
      onState({ state: runtime }) {
        if (disposed) {
          return;
        }
        publish({ change: { runtime, failure: runtime.failure ?? state.failure } });
        if (fileTask) {
          fileRun?.onState();
        }
        switch (runtime.phase) {
        case 'completed':
          endCapture();
          if (!fileTask) {
            publish({ change: { sessions: state.sessions.map(session => session.id === sessionId ? { ...session, completion: runtime.completion } : session) } });
          }
          break;
        case 'failed': case 'unloaded': case 'disposed':
          endCapture();
          endOutput();
          break;
        case 'loading_model': case 'ready': case 'starting': case 'running': case 'stopping': break;
        default: {
          const exhaustive: never = runtime.phase;
          throw new Error(String(exhaustive));
        }
        }
      },
      onFrame({ frame }) {
        if (disposed) {
          return;
        }
        if (fileTask) {
          fileRun?.onFrame({ frame });
          return;
        }
        if (!sessionId || !['starting', 'running', 'stopping'].includes(state.runtime.phase)) {
          return;
        }
        if (frame.text) {
          publish({ change: { sessions: state.sessions.map(session => session.id === sessionId ? { ...session, text: session.text + frame.text } : session) } });
        }
        if (!frame.samples.length) {
          return;
        }
        // The observer is synchronous. Bound queued work instead of retaining an
        // unbounded chain when playback cannot keep up with generated frames.
        if (queuedOutputSamples + frame.samples.length > speechSampleRate * 4) {
          publish({ change: { warning: 'output-backpressure' } });
          void stop({ mode: 'cancel' }).catch(() => {});
          return;
        }
        const epoch = outputEpoch;
        const pcm = frame.samples.slice();
        queuedOutputSamples += pcm.length;
        outputTail = outputTail.then(async () => {
          try {
            if (epoch === outputEpoch && !disposed) {
              await player?.append({ pcm, sampleRate: frame.sampleRate });
            }
          } catch (error) {
            fail({ error });
          } finally {
            queuedOutputSamples -= pcm.length;
          }
        });
      },
    },
  });
  state = { ...state, runtime: client.getState() };

  async function clearFileRun(): Promise<void> {
    const current = fileRun;
    // Drop retained audio immediately, even while native cancellation is pending.
    current?.clear();
    if (fileRun === current) {
      fileRun = undefined;
      publish({ change: { fileRun: undefined } });
    }
    try {
      if (fileTask) {
        await current?.stop({ mode: 'cancel' });
      }
    } catch (error) {
      publish({ change: { failure: speechFailure({ error }) } });
    }
  }

  async function stop({ mode }: { mode: 'finish' | 'cancel' }): Promise<void> {
    endCapture();
    switch (mode) {
    case 'cancel': endOutput();
      break;
    case 'finish': break;
    default: {
      const exhaustive: never = mode;
      throw new Error(String(exhaustive));
    }
    }
    const stopped = fileTask && fileRun ? fileRun.stop({ mode }) : client.stop({ mode });
    const observed = stopped.catch(error => {
      publish({ change: { failure: speechFailure({ error }) } });
    });
    stopping ??= observed.finally(() => {
      stopping = undefined;
    });
    await observed;
    await stopping;
  }

  return {
    capability: client.capability,
    getState: () => state,
    async load({ file }: { file: File }): Promise<void> {
      publish({ change: { failure: undefined, warning: undefined } });
      try {
        await clearFileRun();
        await client.loadModel({ file });
      } catch (error) {
        publish({ change: { failure: speechFailure({ error }) } });
      }
    },
    async start({ maxSeconds, language, persona, name }: { maxSeconds: number, language: string, persona: string | undefined, name: string | undefined }): Promise<void> {
      if (disposed || microphone || stopping || fileTask || !state.runtime.model || !['ready', 'completed'].includes(state.runtime.phase)) {
        return;
      }
      const modelName = state.runtime.model.name;
      const current: { lifetime: AbortController, capture: LiveCapture | undefined } = { lifetime: new AbortController(), capture: undefined };
      microphone = current;
      endOutput();
      publish({ change: { failure: undefined, warning: undefined, capture: 'opening' } });
      player ??= playback({ onPlaying: ({ playing }) => publish({ change: { playing } }) });
      player.mute({ value: audible });
      // Activate audio in the button gesture, before microphone permission waits.
      const activated = player.activate();
      void activated.catch(() => {});
      try {
        current.capture = await capture({
          sampleRate: speechSampleRate,
          signal: current.lifetime.signal,
          onPcm({ pcm }) {
            if (microphone !== current || state.runtime.phase !== 'running') {
              return;
            }
            // Keep the duplex clock running while muted, without transmitting
            // microphone samples to the model.
            const samples = (() => {
              switch (state.microphone) {
              case 'on': return pcm;
              case 'off': return new Float32Array(pcm.length);
              default: {
                const exhaustive: never = state.microphone;
                throw new Error(String(exhaustive));
              }
              }
            })();
            const result = client.push({ samples, sampleRate: speechSampleRate });
            switch (result.kind) {
            case 'accepted': case 'not_running': break;
            case 'backpressure':
              publish({ change: { warning: 'input-backpressure' } });
              void stop({ mode: 'cancel' }).catch(() => {});
              break;
            default: {
              const exhaustive: never = result;
              throw new Error(String(exhaustive));
            }
            }
          },
          onError: fail,
        });
        current.lifetime.signal.throwIfAborted();
        publish({ change: { capture: 'open' } });
        await activated;
        current.lifetime.signal.throwIfAborted();
        player.begin();
        sessionId = crypto.randomUUID();
        publish({ change: { sessions: [...state.sessions, { id: sessionId, modelName, text: '', completion: undefined }] } });
        await client.start({ options: { inputSampleRate: speechSampleRate, maxSeconds, language, persona, name, seed: undefined } });
      } catch (error) {
        if (!current.lifetime.signal.aborted && !disposed) {
          fail({ error });
        }
        if (microphone === current) {
          endCapture();
        } else {
          await current.capture?.finish({ action: 'discard' });
        }
      }
    },
    async runFile({ file, maxSeconds, language, persona, name, tailSeconds, seed }: { file: File, maxSeconds: number, language: string, persona: string | undefined, name: string | undefined, tailSeconds: number, seed: number }): Promise<void> {
      if (disposed || microphone || stopping || fileTask || !state.runtime.model || !['ready', 'completed'].includes(state.runtime.phase)) {
        return;
      }
      fileRun?.clear();
      endOutput();
      publish({ change: { failure: undefined, warning: undefined, fileRun: undefined } });
      const current = createSpeechFileRun({
        client,
        file,
        options: { inputSampleRate: speechSampleRate, maxSeconds, language, persona, name, seed },
        tailSeconds,
        decodeFile,
        onChange({ state: run }) {
          if (fileRun === current) {
            publish({ change: { fileRun: run, failure: run.failure ?? state.failure } });
          }
        },
      });
      fileRun = current;
      // Reserve the file lane before start can synchronously emit a frame.
      const running = Promise.resolve().then(() => current.run());
      fileTask = running;
      try {
        await running;
      } finally {
        if (fileTask === running) {
          fileTask = undefined;
        }
      }
    },
    clearFileRun,
    stop,
    muteMicrophone({ value }: { value: 'on' | 'off' }): void {
      publish({ change: { microphone: value } });
    },
    mutePlayback({ value }: { value: 'on' | 'off' }): void {
      audible = value;
      player?.mute({ value });
    },
    async reset(): Promise<void> {
      await stop({ mode: 'cancel' });
      sessionId = undefined;
      publish({ change: { sessions: [], warning: undefined, failure: undefined } });
    },
    async release(): Promise<void> {
      endCapture();
      endOutput();
      try {
        await clearFileRun();
        await client.releaseModel();
      } catch (error) {
        publish({ change: { failure: speechFailure({ error }) } });
      } finally {
        await player?.close();
        player = undefined;
      }
    },
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      endCapture();
      endOutput();
      try {
        await clearFileRun();
        await client.dispose();
      } finally {
        await player?.close();
        player = undefined;
      }
    },
  };
}

export const TEST_ONLY = {
};
