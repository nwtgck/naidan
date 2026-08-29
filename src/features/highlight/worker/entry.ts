import { exposeWorkerRemote } from '@/utils/worker-transport';
import { createHighlightWorker } from './impl';
import type { IHighlightWorker } from './types';

exposeWorkerRemote<IHighlightWorker>({
  api: createHighlightWorker(),
  endpoint: undefined,
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
