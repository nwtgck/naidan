import { exposeWorkerRemote, postWorkerNotification, subscribeWorkerNotifications, type WorkerServerApi } from '@/utils/worker-transport';
import { createSpeechSession } from '@/features/speech-cpp-browser/runtime/session';
import { speechError } from '@/features/speech-cpp-browser/types';
import { speechAudioSchema, speechLoadSchema, speechStopSchema, speechStateEnvelopeSchema, speechFrameEnvelopeSchema, decodeSpeechStart, type SpeechWorker } from './protocol';
import { loadSpeechCore } from './core-loader';
import { openNativeSpeechModel } from './native-model';
import type { SpeechArtifact } from '@/features/speech-cpp-browser/artifacts';
import { createSpeechLoadReporter, createSpeechLoadObservation } from './load-progress';
import { createWorkerSpeechInvestigationObserver, speechInvestigationEnvelopeSchema } from './investigation-protocol';
import { speechInvestigationContextSchema } from './investigation-context';

// FileReaderSync belongs only to this dedicated Worker realm.
interface SyncBlobReader {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Standard browser FileReaderSync method.
  readAsArrayBuffer(blob: Blob): ArrayBuffer;
}
declare const FileReaderSync: { new(): SyncBlobReader };
let selected: { artifact: SpeechArtifact, baseUrl: string } | undefined;
const session = createSpeechSession({
  maxQueuedSeconds: 2,
  openModel: async ({ file, signal, onProgress, investigation }) => {
    if (selected === undefined) {
      throw new Error('Missing speech artifact selection');
    }
    const selectedArtifact = selected;
    const observer = createWorkerSpeechInvestigationObserver({ context: investigation });
    const observation = createSpeechLoadObservation({ observer, now: () => performance.now() });
    const report = createSpeechLoadReporter({
      onProgress({ progress }) {
        onProgress({ progress });
        observation?.progress({ progress });
      },
      now: () => performance.now(),
    });
    let completed = false;
    try {
      const loaded = await loadSpeechCore({ ...selectedArtifact, onProgress: report });
      observer?.({ event: { kind: 'stage', stage: 'runtime_integrity_verified', state: 'completed', durationMilliseconds: undefined, heapBytes: undefined, details: { wasmSha256: selectedArtifact.artifact.wasmSha256, schemaSha256: selectedArtifact.artifact.schemaSha256 } } });
      const reader = new FileReaderSync();
      const model = await openNativeSpeechModel({ ...loaded, file, signal, readBlob: ({ blob }) => reader.readAsArrayBuffer(blob), onProgress: report, investigation: observer });
      completed = true;
      return model;
    } finally {
      observation?.finish({ state: completed ? 'completed' : signal.aborted ? 'cancelled' : 'failed' });
    }
  },
  observers: {
    onInvestigation({ context, event }) {
      postWorkerNotification({ endpoint: undefined, schema: speechInvestigationEnvelopeSchema, value: { type: 'naidan_speech_investigation_v1', context, event } });
    },
    onFrame({ frame }) {
      postWorkerNotification({ endpoint: undefined, schema: speechFrameEnvelopeSchema, value: { type: 'naidan_speech_frame_v1', frame } });
    },
    onState({ state }) {
      postWorkerNotification({ endpoint: undefined, schema: speechStateEnvelopeSchema, value: { type: 'naidan_speech_state_v1', state } });
    },
  },
});
const api: WorkerServerApi<SpeechWorker> = {
  async loadModel({ file: inputFile, artifact: inputArtifact, baseUrl: inputBaseUrl, investigation: inputInvestigation }) {
    const { file, artifact, baseUrl, investigation } = speechLoadSchema.parse({ file: inputFile, artifact: inputArtifact, baseUrl: inputBaseUrl, investigation: inputInvestigation });
    selected = { artifact, baseUrl };
    await session.loadModel({ file, investigation });
  },
  async start({ options, investigation }) {
    await session.start({ options: decodeSpeechStart({ value: options }), investigation: investigation === undefined ? undefined : speechInvestigationContextSchema.parse(investigation) });
  },
  async push({ samples, sampleRate }) {
    const result = session.push(speechAudioSchema.parse({ samples, sampleRate }));
    switch (result.kind) {
    case 'accepted':
      // Awaiting the lane bounds main-thread microphone submissions as well as
      // the worker's retained PCM. No next native call enters this model early.
      await session.waitForInput();
      return;
    case 'backpressure': throw speechError({ code: 'queue_full', message: 'Speech input queue is full' });
    case 'not_running': throw speechError({ code: 'invalid_state', message: 'Speech session is not running' });
    default: {
      const exhaustive: never = result;
      throw new Error(String(exhaustive));
    }
    }
  },
  async stop({ mode }) {
    await session.stop(speechStopSchema.parse({ mode }));
  },
  cancel() {
    void session.stop({ mode: 'cancel' }).catch(() => undefined);
  },
  async releaseModel() {
    await session.releaseModel();
  },
};
subscribeWorkerNotifications({
  endpoint: undefined,
  schema: speechStopSchema,
  listener: ({ value }) => {
    void session.stop(value).catch(() => undefined);
  },
});
exposeWorkerRemote<SpeechWorker>({ api, endpoint: undefined });

export const TEST_ONLY = {
};
