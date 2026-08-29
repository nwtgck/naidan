import { exposeWorkerRemote } from '@/utils/worker-transport';
import { createGlobalSearchWorker } from './impl';
import type { IGlobalSearchWorker } from './types';

exposeWorkerRemote<IGlobalSearchWorker>({
  api: createGlobalSearchWorker(),
  endpoint: undefined,
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
