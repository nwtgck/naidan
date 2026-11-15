import { exposeWorkerRemote, postWorkerNotification, subscribeWorkerNotifications, type WorkerServerApi } from '@/utils/worker-transport';
import { createSpeechSession } from '@/features/speech-cpp-browser/runtime/session';
import { speechError } from '@/features/speech-cpp-browser/types';
import { speechAudioSchema, speechLoadSchema, speechStopSchema, speechStateEnvelopeSchema, speechFrameEnvelopeSchema, decodeSpeechStart, type SpeechWorker } from './protocol';
import { loadSpeechCore } from './core-loader';
import { openNativeSpeechModel } from './native-model';
import type { SpeechArtifact } from '@/features/speech-cpp-browser/artifacts';
import { createSpeechLoadReporter } from './load-progress';

// FileReaderSync belongs only to this dedicated Worker realm.
interface SyncBlobReader {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Standard browser FileReaderSync method.
  readAsArrayBuffer(blob: Blob): ArrayBuffer;
}
declare const FileReaderSync: { new(): SyncBlobReader };
let selected: { artifact: SpeechArtifact, baseUrl: string } | undefined;
const session = createSpeechSession({
  maxQueuedSeconds: 2,
  openModel: async ({ file, signal, onProgress }) => {
    if (selected === undefined) {
      throw new Error('Missing speech artifact selection');
    }
    const report = createSpeechLoadReporter({ onProgress, now: () => performance.now() });
    const loaded = await loadSpeechCore({ ...selected, onProgress: report });
    const reader = new FileReaderSync();
    return openNativeSpeechModel({ ...loaded, file, signal, readBlob: ({ blob }) => reader.readAsArrayBuffer(blob), onProgress: report });
  },
  observers: {
    onFrame({ frame }) {
      postWorkerNotification({ endpoint: undefined, schema: speechFrameEnvelopeSchema, value: { type: 'naidan_speech_frame_v1', frame } });
    },
    onState({ state }) {
      postWorkerNotification({ endpoint: undefined, schema: speechStateEnvelopeSchema, value: { type: 'naidan_speech_state_v1', state } });
    },
  },
});
const api: WorkerServerApi<SpeechWorker> = {
  async loadModel({ file: inputFile, artifact: inputArtifact, baseUrl: inputBaseUrl }) {
    const { file, artifact, baseUrl } = speechLoadSchema.parse({ file: inputFile, artifact: inputArtifact, baseUrl: inputBaseUrl });
    selected = { artifact, baseUrl };
    await session.loadModel({ file });
  },
  async start({ options }) {
    await session.start({ options: decodeSpeechStart({ value: options }) });
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
