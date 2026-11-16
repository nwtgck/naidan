import { nanoid } from 'nanoid';
import { SpeechRuntimeError, speechFailure, type SpeechFailure } from '@/features/speech-cpp-browser/types';
import { initialSpeechRecognitionState, type SpeechRecognitionClient, type SpeechRecognitionObservers, type SpeechRecognitionState, type SpeechRecognitionResult } from './types';
import { createSpeechInvestigationBindings } from '@/features/speech-cpp-browser/investigation-binding';
import type { SpeechInvestigationBinding } from '@/features/speech-cpp-browser/worker/investigation-context';

export type SpeechRecognitionRun = {
  id: string,
  modelName: string,
  inputName: string,
  status: 'preparing' | 'recognizing' | SpeechRecognitionResult['status'] | 'failed',
  text: string,
  languages: string[],
  inputSeconds: number | undefined,
  preparationSeconds: number | undefined,
  /** Elapsed client transcribe call, including transfer/native input copy. */
  recognitionSeconds: number | undefined,
  failure: SpeechFailure | undefined,
};
export type SpeechRecognitionViewState = { runtime: SpeechRecognitionState, run: SpeechRecognitionRun | undefined, failure: SpeechFailure | undefined };

export function initialSpeechRecognitionViewState(): SpeechRecognitionViewState {
  return { runtime: initialSpeechRecognitionState(), run: undefined, failure: undefined };
}

/** File decoding is injected: recognition remains independent of the live UI,
 * browser audio devices, retention stores and any future microphone workflow. */
export function createSpeechRecognitionController({ createClient, decodeFile, now, onChange }: {
  createClient: ({ observers }: { observers: SpeechRecognitionObservers }) => SpeechRecognitionClient,
  decodeFile: ({ file, sampleRate, signal }: { file: Blob, sampleRate: number, signal: AbortSignal }) => Promise<Float32Array<ArrayBuffer>>,
  now: () => number,
  onChange: ({ state }: { state: SpeechRecognitionViewState }) => void,
}) {
  let state = initialSpeechRecognitionViewState();
  let disposed = false;
  let running: { lifetime: AbortController, task: Promise<void> } | undefined;
  const investigations = createSpeechInvestigationBindings();
  function publish({ change }: { change: Partial<SpeechRecognitionViewState> }): void {
    state = { ...state, ...change };
    if (!disposed) {
      onChange({ state });
    }
  }
  const client = createClient({
    observers: {
      onInvestigation: investigations.receive,
      onState({ state: runtime }) {
        if (!disposed) {
          publish({ change: { runtime, failure: runtime.failure ?? state.failure } });
        }
      },
    },
  });
  state = { ...state, runtime: client.getState() };
  async function cancel({ includeModelLoad }: { includeModelLoad: boolean }): Promise<void> {
    const current = running;
    if (current === undefined && !includeModelLoad) {
      return;
    }
    current?.lifetime.abort();
    await client.cancel();
    await current?.task;
  }
  async function run({ inputName, prepare, language, investigation }: { inputName: string, prepare: ({ signal, modelSampleRate }: { signal: AbortSignal, modelSampleRate: number }) => Promise<{ samples: Float32Array<ArrayBuffer>, sampleRate: number }>, language: string | undefined, investigation: SpeechInvestigationBinding | undefined }): Promise<void> {
    const model = state.runtime.model;
    if (disposed || running !== undefined || state.runtime.phase !== 'ready' || model === undefined) {
      return;
    }
    const id = nanoid(), lifetime = new AbortController();
    const observed = investigations.bind({ binding: investigation });
    let run: SpeechRecognitionRun = { id, modelName: model.name, inputName, status: 'preparing', text: '', languages: [], inputSeconds: undefined, preparationSeconds: undefined, recognitionSeconds: undefined, failure: undefined };
    publish({ change: { run, failure: undefined } });
    function update({ change }: { change: Partial<SpeechRecognitionRun> }): void {
      run = { ...run, ...change };
      if (state.run?.id === id) {
        publish({ change: { run } });
      }
    }
    const task = Promise.resolve().then(async () => {
      const preparing = now();
      let recognizing: number | undefined;
      try {
        // Preserve source File ownership. This temporary mono PCM is decoded
        // at the model rate, without normalization or trimming, then transferred.
        const audio = await new Promise<{ samples: Float32Array<ArrayBuffer>, sampleRate: number }>((resolve, reject) => {
          const aborted = () => reject(lifetime.signal.reason);
          lifetime.signal.addEventListener('abort', aborted, { once: true });
          if (lifetime.signal.aborted) {
            aborted();
            return;
          }
          // Browser decoders themselves are not abortable. Stop observing
          // them immediately and discard late PCM without blocking release.
          void prepare({ signal: lifetime.signal, modelSampleRate: model.sampleRate }).then(resolve, reject).finally(() => lifetime.signal.removeEventListener('abort', aborted));
        });
        lifetime.signal.throwIfAborted();
        const { samples, sampleRate } = audio;
        update({ change: { inputSeconds: samples.length / sampleRate, preparationSeconds: (now() - preparing) / 1000, status: 'recognizing' } });
        recognizing = now();
        const result = await client.transcribe({ samples, sampleRate, language, ...(observed === undefined ? {} : { investigation: observed.context }) });
        const status = (() => {
          switch (result.status) {
          case 'complete': return lifetime.signal.aborted ? 'cancelled' as const : result.status;
          case 'cancelled': case 'model_limit': case 'max_seconds': return result.status;
          default: {
            const exhaustive: never = result.status;
            throw new Error(String(exhaustive));
          }
          }
        })();
        update({ change: { text: result.text, languages: result.languages, status, recognitionSeconds: (now() - recognizing) / 1000 } });
      } catch (error) {
        const failure = client.getState().failure ?? (error instanceof SpeechRuntimeError ? error.details : lifetime.signal.aborted ? undefined : speechFailure({ error }));
        update({ change: { status: failure === undefined && lifetime.signal.aborted ? 'cancelled' : 'failed', failure, preparationSeconds: run.preparationSeconds ?? (now() - preparing) / 1000, recognitionSeconds: recognizing === undefined ? undefined : (now() - recognizing) / 1000 } });
        if (failure !== undefined) {
          publish({ change: { failure } });
        }
      }
    });
    const current = { lifetime, task };
    running = current;
    try {
      await task;
    } finally {
      observed?.release();
      if (running === current) {
        running = undefined;
      }
    }
  }
  return {
    capability: client.capability,
    getState: () => state,
    async load({ file, investigation }: { file: File, investigation?: SpeechInvestigationBinding }): Promise<void> {
      if (disposed) {
        return;
      }
      await cancel({ includeModelLoad: true });
      publish({ change: { failure: undefined } });
      const observed = investigations.bind({ binding: investigation });
      try {
        await client.loadModel({ file, ...(observed === undefined ? {} : { investigation: observed.context }) });
      } catch (error) {
        publish({ change: { failure: speechFailure({ error }) } });
      } finally {
        observed?.release();
      }
    },
    async runFile({ file, language, investigation }: { file: File, language: string | undefined, investigation?: SpeechInvestigationBinding }): Promise<void> {
      await run({ inputName: file.name, language, investigation, prepare: async ({ signal, modelSampleRate }) => ({ samples: await decodeFile({ file, sampleRate: modelSampleRate, signal }), sampleRate: modelSampleRate }) });
    },
    /** The caller transfers ownership of temporary PCM, without WAV decoding. */
    async runAudio({ samples, sampleRate, inputName, language, investigation }: { samples: Float32Array<ArrayBuffer>, sampleRate: number, inputName: string, language: string | undefined, investigation?: SpeechInvestigationBinding }): Promise<void> {
      await run({ inputName, language, investigation, prepare: async () => ({ samples, sampleRate }) });
    },
    cancel: () => cancel({ includeModelLoad: true }),
    /** Cancel only this controller's active decode/transcribe task, preserving a model load. */
    cancelRun: () => cancel({ includeModelLoad: false }),
    async clearRun(): Promise<void> {
      await cancel({ includeModelLoad: false });
      publish({ change: { run: undefined, failure: state.runtime.failure } });
    },
    async release(): Promise<void> {
      await cancel({ includeModelLoad: true });
      try {
        await client.releaseModel();
      } catch (error) {
        publish({ change: { failure: speechFailure({ error }) } });
      }
    },
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        await cancel({ includeModelLoad: true });
      } finally {
        await client.dispose();
        investigations.clear();
        state = { runtime: client.getState(), run: undefined, failure: undefined };
      }
    },
  };
}

export const TEST_ONLY = {
};
