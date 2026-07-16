import type { OpfsEncryptionStateDto } from '@/00-storage/00-dto/opfs-encryption.dto';
import type { OpfsEncryptionTransitionProgress } from '@/00-storage/service/opfs-encryption/transition-progress';

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
  | {
      readonly operation: 'return_to_plain';
      readonly state: Extract<OpfsEncryptionStateDto, { state: 'transitioning' }>;
      readonly passphrase: string | undefined;
    }
  | {
      readonly operation: 'debug_interrupt_enable';
      readonly passphrase: string;
    }
  | {
      readonly operation: 'debug_interrupt_disable';
      readonly state: Extract<OpfsEncryptionStateDto, { state: 'encrypted' }>;
      readonly storageUnlockKey: Uint8Array;
      readonly unlockedKeySlotId: string;
    }
);

export type OpfsEncryptionWorkerResult =
  | { readonly type: 'plain' }
  | { readonly type: 'encrypted' }
  | {
      readonly type: 'interrupted';
      readonly state: Extract<OpfsEncryptionStateDto, { state: 'transitioning' }>;
    };

/**
 * Owns OPFS encryption work that does not need the UI realm. The initial API
 * intentionally exposes only lifecycle transitions; broader encryption
 * maintenance can be added without renaming the Worker ownership boundary.
 */
export type OpfsEncryptionWorkerRemoteProgressCallback = ({ progress }: {
  progress: OpfsEncryptionTransitionProgress;
}) => Promise<void>;

export interface IOpfsEncryptionWorker {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink callbacks must remain top-level proxy arguments.
  run(
    request: OpfsEncryptionWorkerRequest,
    onProgress?: OpfsEncryptionWorkerRemoteProgressCallback,
  ): Promise<OpfsEncryptionWorkerResult>;
  cancel(): Promise<void>;
}

export interface OpfsEncryptionWorkerClient {
  run({ request, signal, onProgress }: {
    request: OpfsEncryptionWorkerRequest;
    signal: AbortSignal | undefined;
    onProgress: (({ progress }: { progress: OpfsEncryptionTransitionProgress }) => void) | undefined;
  }): Promise<OpfsEncryptionWorkerResult>;
  dispose(): Promise<void>;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
