export {
  createEncryptedOpfs,
  inspectEncryptedOpfs,
  openEncryptedOpfs,
  readEncryptedOpfsFileSystemId,
} from './api';
export type { EncryptedOpfsInspection } from './api';
export { createEncryptedOpfsInspectionReader } from './inspection';
export type {
  EncryptedOpfsBinaryRecordInspection,
  EncryptedOpfsBinarySlice,
  EncryptedOpfsDecodedBinaryField,
  EncryptedOpfsInspectionOverview,
  EncryptedOpfsInspectionReader,
  EncryptedOpfsInspectedObject,
  EncryptedOpfsPhysicalObjectEntry,
  EncryptedOpfsPhysicalObjectPage,
  EncryptedOpfsSuperblockSlotInspection,
} from './inspection';
export { DEFAULT_ENCRYPTED_OPFS_POLICY } from './file-system/policy';
export type { EncryptedOpfsPolicy } from './file-system/policy';
export { collectEncryptedOpfsGarbage } from './garbage-collector';
export type { EncryptedOpfsGarbageCollectionResult } from './garbage-collector';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
