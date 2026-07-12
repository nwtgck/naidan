import type {
  EncryptedStorageDebugNode,
  EncryptedStorageDebugNodeRef,
  EncryptedStorageDebugReference,
} from '@/features/debug-encrypted-storage/worker/types';

export interface DebugEncryptedStorageNavigationColumn {
  readonly ref: EncryptedStorageDebugNodeRef,
  readonly title: string,
  readonly kind: string,
  readonly references: readonly EncryptedStorageDebugReference[],
}

export interface DebugEncryptedStorageNavigationHistoryEntry {
  readonly ref: EncryptedStorageDebugNodeRef,
  readonly columns: readonly DebugEncryptedStorageNavigationColumn[],
}

export function createDebugEncryptedStorageNavigationColumn({
  node,
}: {
  node: EncryptedStorageDebugNode,
}): DebugEncryptedStorageNavigationColumn {
  return {
    ref: node.ref,
    title: node.title,
    kind: node.kind,
    references: node.references,
  };
}

export function areDebugEncryptedStorageNodeRefsEqual({
  left,
  right,
}: {
  left: EncryptedStorageDebugNodeRef,
  right: EncryptedStorageDebugNodeRef,
}): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
