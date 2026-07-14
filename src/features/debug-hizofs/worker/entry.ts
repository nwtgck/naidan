import * as Comlink from 'comlink';
import { createHizoFSInspectionWorker } from './impl';

Comlink.expose(createHizoFSInspectionWorker());

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
