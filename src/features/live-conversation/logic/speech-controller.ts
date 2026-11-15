import type { SpeechCompletionReason, SpeechFailure, SpeechState } from '@/features/speech-cpp-browser/types';
import { speechFailure, speechSampleRate } from '@/features/speech-cpp-browser/types';
import type { SpeechClient, SpeechObservers } from '@/features/speech-cpp-browser/worker/types';
import type { openLiveCapture, LiveCapture, LiveCaptureSettings } from './audio-capture';
import type { createLivePlayback } from './audio-playback';
import type { decodeLiveAudioFile } from './audio-file';
import { createSpeechFileRun, type SpeechFileRunState, type SpeechInputPacing } from './speech-file-run';
import { createLiveAudioRetention, type LiveAudioClip } from './audio-retention';
import { nanoid } from 'nanoid';
import { createSpeechInvestigationBindings, type SpeechInvestigationLease } from '@/features/speech-cpp-browser/investigation-binding';
import type { SpeechInvestigationBinding } from '@/features/speech-cpp-browser/worker/investigation-context';
import { validateConstantInputGain, type SpeechInputLevelSettings } from './audio-level';
import { createLiveSpeechInputLevel, type LiveSpeechInputLevelWindow } from './speech-input-level';

export type { LiveSpeechInputLevelWindow } from './speech-input-level';
export type LiveSpeechInputLevel = { gain: number, observation: 'on' | 'off', window: LiveSpeechInputLevelWindow | undefined, captureSettings: LiveCaptureSettings | undefined };

/** Clips retain accepted input and received output, not proof of native consumption. */
export type LiveSpeechSession = { id: string, modelName: string, text: string, completion: SpeechCompletionReason | undefined, inputAudio: LiveAudioClip | undefined, outputAudio: LiveAudioClip | undefined };
export type LiveSpeechState = {
  runtime: SpeechState,
  sessions: LiveSpeechSession[],
  microphone: 'on' | 'off',
  inputLevel: LiveSpeechInputLevel,
  capture: 'closed' | 'opening' | 'open',
  playing: boolean,
  warning: 'input-backpressure' | 'output-backpressure' | undefined,
  audioWarning: 'retention-limit' | 'retention-failed' | undefined,
  failure: SpeechFailure | undefined,
  fileRun: SpeechFileRunState | undefined,
};

export function initialLiveSpeechState(): LiveSpeechState {
  return {
    runtime: { phase: 'unloaded', model: undefined, queuedSamples: 0, completion: undefined, failure: undefined, loadProgress: undefined },
    sessions: [],
    microphone: 'on',
    inputLevel: { gain: 1, observation: 'off', window: undefined, captureSettings: undefined },
    capture: 'closed',
    playing: false,
    warning: undefined,
    audioWarning: undefined,
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
  const investigations = createSpeechInvestigationBindings();
  let dialogueInvestigation: SpeechInvestigationLease | undefined;
  const retained = createLiveAudioRetention({ maximumBytes: 64 * 1024 * 1024 });
  type Recording = { id: string, partial: boolean, input: 'recording' | 'unavailable', output: 'recording' | 'unavailable' };
  let recording: Recording | undefined;
  let state = initialLiveSpeechState();
  const inputLevel = createLiveSpeechInputLevel({ sampleRate: speechSampleRate });
  function publish({ change }: { change: Partial<LiveSpeechState> }): void {
    state = { ...state, ...change };
    if (!disposed) {
      onChange({ state });
    }
  }
  function readCaptureSettings({ observation }: { observation: 'on' | 'off' }): LiveCaptureSettings | undefined {
    switch (observation) {
    case 'on': return microphone?.capture?.getSettings?.();
    case 'off': return undefined;
    default: {
      const exhaustive: never = observation;
      throw new Error(String(exhaustive));
    }
    }
  }
  function endCapture(): void {
    const current = microphone;
    microphone = undefined;
    inputLevel.reset();
    publish({ change: { capture: 'closed', inputLevel: { ...state.inputLevel, window: undefined, captureSettings: undefined } } });
    current?.lifetime.abort();
    void current?.capture?.finish({ action: 'discard' }).catch(() => {});
  }
  function endOutput(): void {
    outputEpoch++;
    player?.stop();
  }
  function clearLiveAudio(): void {
    recording = undefined;
    retained.clear();
    publish({ change: { audioWarning: undefined, sessions: state.sessions.map(session => ({ ...session, inputAudio: undefined, outputAudio: undefined })) } });
  }
  function retentionFailed({ current }: { current: Recording }): void {
    if (recording === current) {
      recording = undefined;
    }
    retained.drop({ key: `${current.id}/input` });
    retained.drop({ key: `${current.id}/output` });
    publish({ change: { audioWarning: 'retention-failed', sessions: state.sessions.map(session => session.id === current.id ? { ...session, inputAudio: undefined, outputAudio: undefined } : session) } });
  }
  function retain({ side, pcm, sampleRate }: { side: 'input' | 'output', pcm: Float32Array, sampleRate: number }): void {
    const current = recording;
    if (current === undefined) {
      return;
    }
    const retentionState = current[side];
    switch (retentionState) {
    case 'recording': break;
    case 'unavailable': return;
    default: {
      const exhaustive: never = retentionState;
      throw new Error(String(exhaustive));
    }
    }
    try {
      const result = retained.append({ key: `${current.id}/${side}`, sampleRate, pcm });
      switch (result) {
      case 'kept': case 'skipped': break;
      case 'limit':
        current[side] = 'unavailable';
        current.partial = true;
        publish({ change: { audioWarning: 'retention-limit' } });
        break;
      default: {
        const exhaustive: never = result;
        throw new Error(String(exhaustive));
      }
      }
    } catch {
      retentionFailed({ current });
    }
  }
  function finishLiveAudio({ current, status }: { current: Recording | undefined, status: LiveAudioClip['status'] }): void {
    if (current === undefined || recording !== current) {
      return;
    }
    recording = undefined;
    try {
      const retainedStatus = current.partial ? 'partial' : status;
      const inputAudio = retained.finish({ key: `${current.id}/input`, status: retainedStatus });
      const outputAudio = retained.finish({ key: `${current.id}/output`, status: retainedStatus });
      publish({ change: { sessions: state.sessions.map(session => session.id === current.id ? { ...session, inputAudio, outputAudio } : session) } });
    } catch {
      retentionFailed({ current });
    }
  }
  function completedAudioStatus({ completion }: { completion: SpeechCompletionReason | undefined }): LiveAudioClip['status'] {
    switch (completion) {
    case 'finished': return state.failure === undefined && state.warning === undefined ? 'complete' : 'partial';
    case 'cancelled': case 'max_seconds': case undefined: return 'partial';
    default: {
      const exhaustive: never = completion;
      throw new Error(String(exhaustive));
    }
    }
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
      onInvestigation: investigations.receive,
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
          dialogueInvestigation?.release();
          dialogueInvestigation = undefined;
          endCapture();
          if (!fileTask) {
            publish({ change: { sessions: state.sessions.map(session => session.id === sessionId ? { ...session, completion: runtime.completion } : session) } });
            finishLiveAudio({ current: recording, status: completedAudioStatus({ completion: runtime.completion }) });
          }
          break;
        case 'failed': case 'unloaded': case 'disposed':
          dialogueInvestigation?.release();
          dialogueInvestigation = undefined;
          finishLiveAudio({ current: recording, status: 'partial' });
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
        // Keep generated audio independently of playback mute, cancellation or
        // backpressure. The retained helper owns its opt-in copy.
        retain({ side: 'output', pcm: frame.samples, sampleRate: frame.sampleRate });
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
    const current = recording;
    endCapture();
    switch (mode) {
    case 'cancel':
      if (current !== undefined) {
        current.partial = true;
      }
      endOutput();
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
    dialogueInvestigation?.release();
    dialogueInvestigation = undefined;
    // A stop RPC alone does not confirm a complete accepted recording.
    finishLiveAudio({ current, status: 'partial' });
  }

  return {
    capability: client.capability,
    getState: () => state,
    async load({ file, investigation }: { file: File, investigation?: SpeechInvestigationBinding }): Promise<void> {
      const observed = investigations.bind({ binding: investigation });
      publish({ change: { failure: undefined, warning: undefined } });
      try {
        await clearFileRun();
        await client.loadModel({ file, ...(observed === undefined ? {} : { investigation: observed.context }) });
      } catch (error) {
        publish({ change: { failure: speechFailure({ error }) } });
      } finally {
        observed?.release();
      }
    },
    async start({ maxSeconds, language, persona, name, investigation }: { maxSeconds: number, language: string, persona: string | undefined, name: string | undefined, investigation?: SpeechInvestigationBinding }): Promise<void> {
      if (disposed || microphone || stopping || fileTask || !state.runtime.model || !['ready', 'completed'].includes(state.runtime.phase)) {
        return;
      }
      const modelName = state.runtime.model.name;
      dialogueInvestigation?.release();
      dialogueInvestigation = investigations.bind({ binding: investigation });
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
            if (state.inputLevel.gain !== 1 || state.inputLevel.observation === 'on') {
              const window = inputLevel.process({ pcm: samples, gain: state.inputLevel.gain, observe: state.inputLevel.observation === 'on' });
              if (window !== undefined) {
                publish({ change: { inputLevel: { ...state.inputLevel, window } } });
              }
            }
            const result = client.push({ samples, sampleRate: speechSampleRate });
            switch (result.kind) {
            case 'accepted':
              // Queue acceptance is not a guarantee of native consumption.
              retain({ side: 'input', pcm: samples, sampleRate: speechSampleRate });
              break;
            case 'not_running': break;
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
        publish({ change: { capture: 'open', inputLevel: { ...state.inputLevel, captureSettings: readCaptureSettings({ observation: state.inputLevel.observation }) } } });
        await activated;
        current.lifetime.signal.throwIfAborted();
        player.begin();
        sessionId = nanoid();
        recording = retained.isEnabled() ? { id: sessionId, partial: false, input: 'recording', output: 'recording' } : undefined;
        publish({ change: { sessions: [...state.sessions, { id: sessionId, modelName, text: '', completion: undefined, inputAudio: undefined, outputAudio: undefined }] } });
        await client.start({ options: { inputSampleRate: speechSampleRate, maxSeconds, language, persona, name, seed: undefined }, ...(dialogueInvestigation === undefined ? {} : { investigation: dialogueInvestigation.context }) });
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
    async runFile({ file, maxSeconds, language, persona, name, tailSeconds, seed, inputPacing, inputLevel, maximumRetainedAudioBytes, investigation }: { file: File, maxSeconds: number, language: string, persona: string | undefined, name: string | undefined, tailSeconds: number, seed: number, inputPacing: SpeechInputPacing, inputLevel: SpeechInputLevelSettings, maximumRetainedAudioBytes: number, investigation?: SpeechInvestigationBinding }): Promise<void> {
      if (disposed || microphone || stopping || fileTask || !state.runtime.model || !['ready', 'completed'].includes(state.runtime.phase)) {
        return;
      }
      fileRun?.clear();
      const observed = investigations.bind({ binding: investigation });
      endOutput();
      publish({ change: { failure: undefined, warning: undefined, fileRun: undefined } });
      const current = createSpeechFileRun({
        client,
        file,
        options: { inputSampleRate: speechSampleRate, maxSeconds, language, persona, name, seed },
        tailSeconds,
        inputPacing,
        inputLevel,
        maximumRetainedAudioBytes,
        ...(observed === undefined ? {} : { investigation: observed.context }),
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
        observed?.release();
        if (fileTask === running) {
          fileTask = undefined;
        }
      }
    },
    getFileRunAudio({ id, role }: { id: string, role: 'input' | 'output' }): Blob | undefined {
      return fileRun?.getState().id === id ? fileRun.getAudio({ role }) : undefined;
    },
    clearFileRun,
    stop,
    setInputGain({ gain }: { gain: number }): void {
      if (disposed || gain === state.inputLevel.gain) {
        return;
      }
      validateConstantInputGain({ gain });
      inputLevel.reset();
      publish({ change: { inputLevel: { ...state.inputLevel, gain, window: undefined } } });
    },
    observeInputLevel({ value }: { value: 'on' | 'off' }): void {
      if (disposed || value === state.inputLevel.observation) {
        return;
      }
      inputLevel.reset();
      publish({ change: { inputLevel: { ...state.inputLevel, observation: value, window: undefined, captureSettings: readCaptureSettings({ observation: value }) } } });
    },
    muteMicrophone({ value }: { value: 'on' | 'off' }): void {
      if (value === state.microphone) {
        return;
      }
      switch (state.inputLevel.observation) {
      case 'on':
        inputLevel.reset();
        publish({ change: { microphone: value, inputLevel: { ...state.inputLevel, window: undefined } } });
        break;
      case 'off': publish({ change: { microphone: value } });
        break;
      default: {
        const exhaustive: never = state.inputLevel.observation;
        throw new Error(String(exhaustive));
      }
      }
    },
    mutePlayback({ value }: { value: 'on' | 'off' }): void {
      audible = value;
      player?.mute({ value });
    },
    retainAudio({ value }: { value: 'on' | 'off' }): void {
      if (disposed) {
        return;
      }
      retained.setEnabled({ value });
      switch (value) {
      case 'on': break;
      case 'off': clearLiveAudio();
        break;
      default: {
        const exhaustive: never = value;
        throw new Error(String(exhaustive));
      }
      }
    },
    async reset(): Promise<void> {
      sessionId = undefined;
      clearLiveAudio();
      await stop({ mode: 'cancel' });
      publish({ change: { sessions: [], warning: undefined, failure: undefined } });
    },
    async release(): Promise<void> {
      sessionId = undefined;
      clearLiveAudio();
      endCapture();
      endOutput();
      try {
        await clearFileRun();
        await client.releaseModel();
      } catch (error) {
        publish({ change: { failure: speechFailure({ error }) } });
      } finally {
        dialogueInvestigation?.release();
        dialogueInvestigation = undefined;
        investigations.clear();
        await player?.close();
        player = undefined;
      }
    },
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      sessionId = undefined;
      clearLiveAudio();
      endCapture();
      endOutput();
      try {
        await clearFileRun();
        await client.dispose();
      } finally {
        dialogueInvestigation?.release();
        dialogueInvestigation = undefined;
        investigations.clear();
        await player?.close();
        player = undefined;
      }
    },
  };
}

export const TEST_ONLY = {
};
