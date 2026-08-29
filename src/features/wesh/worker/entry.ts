import { openNaidanStorageDirectoryWorkerMount } from '@/00-storage/service/naidan-opfs/worker-mount-runtime';
import { exposeWorkerRemote } from '@/utils/worker-transport';
import { createWeshWorker } from './impl';
import type { IWeshWorker } from './types';

exposeWorkerRemote<IWeshWorker>({
  api: createWeshWorker({
    openStorageDirectoryWorkerMount: openNaidanStorageDirectoryWorkerMount,
  }),
  endpoint: undefined,
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
