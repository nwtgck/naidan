import { exposeWorkerRemote } from '@/utils/worker-transport';
import { createFileExplorerWorker } from './impl';
import type { IFileExplorerWorker } from './types';

exposeWorkerRemote<IFileExplorerWorker>({
  api: createFileExplorerWorker(),
  endpoint: undefined,
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
