import * as Comlink from 'comlink';
import { openNaidanStorageDirectoryWorkerMount } from '@/00-storage/service/naidan-opfs/worker-mount-runtime';
import { createWeshWorker } from './impl';

Comlink.expose(createWeshWorker({
  openStorageDirectoryWorkerMount: openNaidanStorageDirectoryWorkerMount,
}));

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
