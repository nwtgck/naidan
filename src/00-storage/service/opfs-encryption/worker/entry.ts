import * as Comlink from 'comlink';
import { createOpfsEncryptionWorker } from './impl';

Comlink.expose(createOpfsEncryptionWorker());

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
