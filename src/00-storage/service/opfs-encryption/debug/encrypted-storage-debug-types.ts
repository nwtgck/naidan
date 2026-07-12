import type { EncryptedObjectPhysicalArea } from '@/00-storage/service/opfs-encryption/encrypted-object-store';

export interface EncryptedStorageDebugCapability {
  readonly storageRoot: FileSystemDirectoryHandle,
  readonly storeDirectory: FileSystemDirectoryHandle,
  readonly encryptedStoreId: string,
  readonly objectEncryptionKey: CryptoKey,
  readonly objectAddressKey: CryptoKey,
}

export type EncryptedStorageDebugNodeRef =
  | { readonly type: 'root' }
  | { readonly type: 'control_state' }
  | { readonly type: 'store_header' }
  | { readonly type: 'store_manifest' }
  | { readonly type: 'collection', readonly collectionType: string }
  | {
      readonly type: 'logical_object',
      readonly area: EncryptedObjectPhysicalArea,
      readonly namespace: string,
      readonly key: string,
    }
  | {
      readonly type: 'physical_object',
      readonly area: EncryptedObjectPhysicalArea,
      readonly objectId: string,
      readonly shardId: string,
    }
  | {
      readonly type: 'file_system',
      readonly area: EncryptedObjectPhysicalArea,
      readonly fileSystemId: string,
    }
  | {
      readonly type: 'directory',
      readonly area: EncryptedObjectPhysicalArea,
      readonly fileSystemId: string,
      readonly directoryId: string,
      readonly path: string,
    }
  | {
      readonly type: 'file',
      readonly area: EncryptedObjectPhysicalArea,
      readonly fileSystemId: string,
      readonly fileId: string,
      readonly path: string,
    };

export interface EncryptedStorageDebugReference {
  readonly label: string,
  readonly ref: EncryptedStorageDebugNodeRef,
}

export interface EncryptedStorageDebugField {
  readonly label: string,
  readonly value: string,
}

export interface EncryptedStorageDebugNode {
  readonly ref: EncryptedStorageDebugNodeRef,
  readonly kind: string,
  readonly title: string,
  readonly fields: readonly EncryptedStorageDebugField[],
  readonly value: unknown,
  readonly references: readonly EncryptedStorageDebugReference[],
  readonly physicalPath?: string,
  readonly warnings: readonly string[],
}

export interface EncryptedStorageDebugSearchResult {
  readonly label: string,
  readonly detail: string,
  readonly ref: EncryptedStorageDebugNodeRef,
}

export interface EncryptedStorageDebugIntegrityFinding {
  readonly severity: 'error' | 'warning' | 'info',
  readonly message: string,
  readonly ref?: EncryptedStorageDebugNodeRef,
}

export interface EncryptedStorageDebugIntegrityReport {
  readonly scannedPhysicalObjects: number,
  readonly knownLogicalObjects: number,
  readonly findings: readonly EncryptedStorageDebugIntegrityFinding[],
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
