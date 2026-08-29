import { exposeWorkerRemote } from '@/utils/worker-transport';
import { createAdvancedTextEditorV3Worker } from './impl';
import type { IAdvancedTextEditorV3Worker } from './types';

exposeWorkerRemote<IAdvancedTextEditorV3Worker>({
  api: createAdvancedTextEditorV3Worker(),
  endpoint: undefined,
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
