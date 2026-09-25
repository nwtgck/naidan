import { imageDiagnosticEnvelopeSchema } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import { exposeWorkerRemote, postWorkerNotification } from '@/utils/worker-transport';
import { createImageWorker } from './impl';
import type { ImageWorker } from './types';
exposeWorkerRemote<ImageWorker>({ api: createImageWorker({ reportDiagnostic({ diagnostic }) {
  postWorkerNotification({ endpoint: undefined, schema: imageDiagnosticEnvelopeSchema, value: { type: 'naidan-image-diagnostic-v1', diagnostic } });
} }), endpoint: undefined });
export const TEST_ONLY = {
};
