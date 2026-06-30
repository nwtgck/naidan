import * as Comlink from 'comlink';
import { createGlobalSearchWorker } from './impl';

Comlink.expose(createGlobalSearchWorker());

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
