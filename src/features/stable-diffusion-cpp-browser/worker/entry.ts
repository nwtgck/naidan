import { imageDiagnosticEnvelopeSchema } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import { previewControlSchema, cancelControlSchema, previewFrameSchema } from '@/features/stable-diffusion-cpp-browser/types';
import { exposeWorkerRemote, postWorkerNotification, subscribeWorkerNotifications } from '@/utils/worker-transport';
import { createImageWorker } from './impl';
import type { ImageWorker } from './types';
const api = createImageWorker({
  reportDiagnostic({ diagnostic }) {
    postWorkerNotification({ endpoint: undefined, schema: imageDiagnosticEnvelopeSchema, value: { type: 'naidan-image-diagnostic-v1', diagnostic } });
  },
  reportPreview({ frame }) {
    postWorkerNotification({ endpoint: undefined, schema: previewFrameSchema, value: frame });
  },
});
subscribeWorkerNotifications({ endpoint: undefined, schema: previewControlSchema, listener: ({ value }) => api.updatePreview({ control: value }) });
subscribeWorkerNotifications({ endpoint: undefined, schema: cancelControlSchema, listener({ value }) {
  api.cancel({ control: value });
} });
exposeWorkerRemote<ImageWorker>({ api, endpoint: undefined });
export const TEST_ONLY = {
};
