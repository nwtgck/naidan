import { exposeWorkerRemote, postWorkerNotification, subscribeWorkerNotifications, type WorkerServerApi } from '@/utils/worker-transport';
import { speechError, speechFailure } from '@/features/speech-cpp-browser/types';
import { loadSpeechCore } from '@/features/speech-cpp-browser/worker/core-loader';
import { createSpeechLoadReporter, createSpeechLoadObservation } from '@/features/speech-cpp-browser/worker/load-progress';
import { recognitionAudioSchema, recognitionCancelSchema, recognitionLoadProgressSchema, recognitionProgressSchema, speechLoadSchema, type SpeechRecognitionWorker } from './protocol';
import { openNativeSpeechRecognitionModel } from './native-model';
import type { SpeechRecognitionModelPort } from '@/features/speech-cpp-browser/recognition/types';
import { createWorkerSpeechInvestigationObserver } from '@/features/speech-cpp-browser/worker/investigation-protocol';

interface SyncBlobReader {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Standard browser FileReaderSync method.
  readAsArrayBuffer(blob: Blob): ArrayBuffer;
}
declare const FileReaderSync: { new(): SyncBlobReader };
let model: SpeechRecognitionModelPort | undefined;
let active: Promise<unknown> | undefined;
const lifetime = new AbortController();
const api: WorkerServerApi<SpeechRecognitionWorker> = {
  async loadModel({ file: inputFile, artifact: inputArtifact, baseUrl: inputBaseUrl, investigation: inputInvestigation }) {
    if (model !== undefined || active !== undefined) {
      return { kind: 'failed', failure: speechFailure({ error: speechError({ code: 'invalid_state', message: 'Recognition Worker loads one model during its lifetime' }) }) };
    }
    let observation: ReturnType<typeof createSpeechLoadObservation>, completed = false;
    try {
      const { file, artifact, baseUrl, investigation } = speechLoadSchema.parse({ file: inputFile, artifact: inputArtifact, baseUrl: inputBaseUrl, investigation: inputInvestigation });
      const observer = createWorkerSpeechInvestigationObserver({ context: investigation });
      observation = createSpeechLoadObservation({ observer, now: () => performance.now() });
      const report = createSpeechLoadReporter({
        now: () => performance.now(),
        onProgress({ progress }) {
          observation?.progress({ progress });
          postWorkerNotification({ endpoint: undefined, schema: recognitionLoadProgressSchema, value: { type: 'naidan_recognition_load_v1', progress } });
        },
      });
      const loading = (async () => {
        const loaded = await loadSpeechCore({ artifact, baseUrl, onProgress: report });
        observer?.({ event: { kind: 'stage', stage: 'runtime_integrity_verified', state: 'completed', durationMilliseconds: undefined, heapBytes: undefined, details: { wasmSha256: artifact.wasmSha256, schemaSha256: artifact.schemaSha256 } } });
        const reader = new FileReaderSync();
        model = await openNativeSpeechRecognitionModel({ ...loaded, file, signal: lifetime.signal, readBlob: ({ blob }) => reader.readAsArrayBuffer(blob), onProgress: report, investigation: observer });
        return model;
      })();
      active = loading;
      const loaded = await loading;
      completed = true;
      return { kind: 'loaded', model: loaded.info };
    } catch (error) {
      return { kind: 'failed', failure: speechFailure({ error }) };
    } finally {
      observation?.finish({ state: completed ? 'completed' : lifetime.signal.aborted ? 'cancelled' : 'failed' });
      active = undefined;
    }
  },
  async transcribe({ samples: inputSamples, sampleRate: inputRate, language: inputLanguage, investigation: inputInvestigation }) {
    if (model === undefined || active !== undefined) {
      return { kind: 'failed', failure: speechFailure({ error: speechError({ code: 'invalid_state', message: 'Recognition model is not ready' }) }) };
    }
    try {
      const { samples, sampleRate, language, investigation } = recognitionAudioSchema.parse({ samples: inputSamples, sampleRate: inputRate, language: inputLanguage, investigation: inputInvestigation });
      const recognizing = model.transcribe({
        samples,
        sampleRate,
        language,
        investigation: createWorkerSpeechInvestigationObserver({ context: investigation }),
        onProgress({ progress }) {
          postWorkerNotification({ endpoint: undefined, schema: recognitionProgressSchema, value: { type: 'naidan_recognition_progress_v1', progress } });
        },
      });
      active = recognizing;
      return { kind: 'recognized', result: await recognizing };
    } catch (error) {
      return { kind: 'failed', failure: speechFailure({ error }) };
    } finally {
      active = undefined;
    }
  },
  async releaseModel() {
    lifetime.abort();
    model?.cancel();
    await active?.catch(() => undefined);
    await model?.release();
    model = undefined;
  },
};
subscribeWorkerNotifications({
  endpoint: undefined,
  schema: recognitionCancelSchema,
  listener() {
    model?.cancel();
  },
});
exposeWorkerRemote<SpeechRecognitionWorker>({ api, endpoint: undefined });

export const TEST_ONLY = {
};
