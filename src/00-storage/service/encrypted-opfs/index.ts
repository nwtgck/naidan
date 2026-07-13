export {
  createEncryptedOpfs,
  inspectEncryptedOpfs,
  openEncryptedOpfs,
  readEncryptedOpfsFileSystemId,
} from './api';
export type { EncryptedOpfsInspection } from './api';
export { collectEncryptedOpfsGarbage } from './garbage-collector';
export type { EncryptedOpfsGarbageCollectionResult } from './garbage-collector';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
