import type { EncryptedStorageDebugCapability } from '@/00-storage/service/opfs-encryption/encrypted-storage-debug-capability';
import type { EncryptedObjectPhysicalArea } from '@/00-storage/service/opfs-encryption/encrypted-object-store';

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

/**
 * The exact JSON text represented by a persisted encrypted-storage record.
 *
 * Encrypted Storage Inspector exists to expose Naidan's persistence protocol.
 * Persisted JSON is therefore the primary source of truth; runtime previews,
 * summaries, and semantic interpretations must never masquerade as stored DTO
 * fields.
 */
export interface EncryptedStorageDebugPersistedJson {
  readonly json: string,
  readonly parseStatus: 'valid' | 'invalid',
  readonly source: 'decrypted_persisted_bytes' | 'selected_persisted_dto',
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

export interface IDebugEncryptedStorageWorker {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- The capability is a structured-cloned Comlink boundary value.
  configure(capability: EncryptedStorageDebugCapability): Promise<void>;

  loadNode({ ref }: {
    ref: EncryptedStorageDebugNodeRef,
  }): Promise<EncryptedStorageDebugNode>;

  loadPersistedJson({ ref }: {
    ref: EncryptedStorageDebugNodeRef,
  }): Promise<EncryptedStorageDebugPersistedJson | undefined>;

  search({ query }: {
    query: string,
  }): Promise<EncryptedStorageDebugSearchResult[]>;

  scanIntegrity(): Promise<EncryptedStorageDebugIntegrityReport>;

  dispose(): Promise<void>;
}

export interface DebugEncryptedStorageWorkerClient {
  loadNode({ ref }: {
    ref: EncryptedStorageDebugNodeRef,
  }): Promise<EncryptedStorageDebugNode>;

  loadPersistedJson({ ref }: {
    ref: EncryptedStorageDebugNodeRef,
  }): Promise<EncryptedStorageDebugPersistedJson | undefined>;

  search({ query }: {
    query: string,
  }): Promise<EncryptedStorageDebugSearchResult[]>;

  scanIntegrity(): Promise<EncryptedStorageDebugIntegrityReport>;

  dispose(): Promise<void>;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
