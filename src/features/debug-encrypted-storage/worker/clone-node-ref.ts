import type { EncryptedStorageDebugNodeRef } from './types';

/**
 * Rebuilds a debug node reference as a plain structured-cloneable object.
 *
 * Vue recursively proxies objects stored in refs and reactive collections.
 * Passing one of those proxies through Comlink fails before the Worker can
 * inspect it. Keep this conversion at the Worker boundary so navigation can
 * freely use reactive state without leaking framework objects across threads.
 */
export function cloneEncryptedStorageDebugNodeRef({
  ref,
}: {
  ref: EncryptedStorageDebugNodeRef,
}): EncryptedStorageDebugNodeRef {
  switch (ref.type) {
  case 'root':
    return { type: 'root' };
  case 'control_state':
    return { type: 'control_state' };
  case 'store_header':
    return { type: 'store_header' };
  case 'store_manifest':
    return { type: 'store_manifest' };
  case 'collection':
    return {
      type: 'collection',
      collectionType: ref.collectionType,
    };
  case 'logical_object':
    return {
      type: 'logical_object',
      area: ref.area,
      namespace: ref.namespace,
      key: ref.key,
    };
  case 'physical_object':
    return {
      type: 'physical_object',
      area: ref.area,
      objectId: ref.objectId,
      shardId: ref.shardId,
    };
  case 'file_system':
    return {
      type: 'file_system',
      area: ref.area,
      fileSystemId: ref.fileSystemId,
    };
  case 'directory':
    return {
      type: 'directory',
      area: ref.area,
      fileSystemId: ref.fileSystemId,
      directoryId: ref.directoryId,
      path: ref.path,
    };
  case 'file':
    return {
      type: 'file',
      area: ref.area,
      fileSystemId: ref.fileSystemId,
      fileId: ref.fileId,
      path: ref.path,
    };
  default: {
    const _ex: never = ref;
    throw new Error(`Unhandled encrypted storage debug node reference: ${String(_ex)}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
