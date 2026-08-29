import { exposeWorkerRemote } from '@/utils/worker-transport';
import { createWeshWorker } from './impl';
import type { IWeshWorker } from './types';

exposeWorkerRemote<IWeshWorker>({
  api: createWeshWorker(),
  endpoint: undefined,
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
