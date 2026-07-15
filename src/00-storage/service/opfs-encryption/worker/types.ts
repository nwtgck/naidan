import type { OpfsEncryptionStateDto } from '@/00-storage/00-dto/opfs-encryption.dto';

export type OpfsEncryptionWorkerRequest = {
  readonly storageRoot: FileSystemDirectoryHandle;
  readonly nativeNamespaceRoot: FileSystemDirectoryHandle;
} & (
  | {
      readonly operation: 'enable';
      readonly passphrase: string;
    }
  | {
      readonly operation: 'disable' | 'reencrypt';
      readonly state: Extract<OpfsEncryptionStateDto, { state: 'encrypted' }>;
      readonly storageUnlockKey: Uint8Array;
      readonly unlockedKeySlotId: string;
    }
  | {
      readonly operation: 'resume';
      readonly state: Extract<OpfsEncryptionStateDto, { state: 'transitioning' }>;
      readonly passphrase: string;
    }
);

export type OpfsEncryptionWorkerResult =
  | { readonly type: 'plain' }
  | { readonly type: 'encrypted' };

/**
 * Owns OPFS encryption work that does not need the UI realm. The initial API
 * intentionally exposes only lifecycle transitions; broader encryption
 * maintenance can be added without renaming the Worker ownership boundary.
 */
export interface IOpfsEncryptionWorker {
  run({ request }: {
    request: OpfsEncryptionWorkerRequest;
  }): Promise<OpfsEncryptionWorkerResult>;
  cancel(): Promise<void>;
}

export interface OpfsEncryptionWorkerClient {
  run({ request, signal }: {
    request: OpfsEncryptionWorkerRequest;
    signal: AbortSignal | undefined;
  }): Promise<OpfsEncryptionWorkerResult>;
  dispose(): Promise<void>;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
