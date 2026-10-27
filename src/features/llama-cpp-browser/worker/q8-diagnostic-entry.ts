import { exposeWorkerRemote, postWorkerNotification } from '@/utils/worker-transport';
import { q8DiagnosticNotificationSchema, type Q8DiagnosticWorkerApi } from '@/features/llama-cpp-browser/performance/q8-diagnostic-worker-types';
import { createQ8DiagnosticWorkerApi } from './q8-diagnostic-api';

exposeWorkerRemote<Q8DiagnosticWorkerApi>({
  endpoint: undefined,
  api: createQ8DiagnosticWorkerApi({
    onProgress: ({ progress }) => postWorkerNotification({ endpoint: undefined, schema: q8DiagnosticNotificationSchema, value: { kind: 'naidan-q8-kernel-progress', progress } }),
  }),
});

export const TEST_ONLY = {
};
