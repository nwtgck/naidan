import type { IStorageProvider } from '@/00-storage/service/interface';
import type { StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import type { HizoFSAuthenticatedInspectionSession } from '@/00-storage/service/hizofs/inspection';
import type {
  NaidanPersistenceModeV1,
  NaidanPersistenceControlV1,
  PersistenceControlCandidate,
  PersistenceControlCopy,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import type { OpfsEncryptionTransitionProgressListener } from '@/00-storage/service/naidan-opfs/transition-progress';

type HizoFSMode = Extract<NaidanPersistenceModeV1, { readonly type: 'hizofs' }>;
type FileSystemId = HizoFSMode['activeFileSystemId'];

export type OpfsCredentialRequiredAction = 'converge_transition' | 'unlock';

export type OpfsCredentialRequiredCandidate = {
  readonly copy: PersistenceControlCopy;
  readonly sequence: number | undefined;
  readonly state: PersistenceControlCandidate['state'];
};

export type OpfsEncryptionInspection =
  | { readonly type: 'plain' }
  | {
      /**
       * Structurally decoded candidates are deliberately detached from
       * routing authority. A passphrase-bound runtime operation must prove a
       * candidate and exact-recheck both copies before exposing a selected
       * File System ID or registering a session.
       */
      readonly blockingReason: 'protection_unresolved';
      /**
       * Structurally derived UI action only. The selected operation must still
       * authenticate and exact-recheck Persistence Control before it can act.
       */
      readonly requiredAction: OpfsCredentialRequiredAction;
      readonly candidates: readonly [OpfsCredentialRequiredCandidate, OpfsCredentialRequiredCandidate];
      readonly type: 'credential_required';
    }
  | {
      readonly type: 'encrypted';
      readonly control: NaidanPersistenceControlV1;
      readonly mode: HizoFSMode;
    }
  | {
      readonly type: 'transitioning';
      readonly control: NaidanPersistenceControlV1;
      readonly mode: Extract<NaidanPersistenceModeV1, { readonly type: 'transitioning' }>;
    }
  | { readonly type: 'recovery_required'; readonly error: unknown };

export type OpfsEncryptionSettingsInspection =
  | { readonly type: 'plain' }
  | { readonly access: 'locked'; readonly type: 'encrypted' }
  | { readonly access: 'unlocked'; readonly fileSystemId: FileSystemId; readonly type: 'encrypted' }
  | { readonly inspection: Extract<OpfsEncryptionInspection, { type: 'transitioning' }>; readonly type: 'transitioning' }
  | { readonly error: unknown; readonly type: 'recovery_required' };

export type OpfsPersistenceWritableProfile = 'development-unverified' | 'release-qualified';

export type OpfsPersistenceUnlockedMaintenanceResult =
  | { readonly state: 'plain_namespace_in_use' }
  | { readonly remainingEntryCount: number; readonly removedEntryCount: number; readonly state: 'completed' };

export interface OpfsPersistenceManagementCleanHeadBarrier {
  ensureCleanHead(): Promise<void>;
  release(): void;
}

export interface OpfsPersistenceUnlockedSession {
  /** Writable behavior is explicit; release qualification remains a separate gate. */
  readonly writableProfile: OpfsPersistenceWritableProfile;
  readonly backend: IStorageProvider;
  readonly fileSystemId: FileSystemId;
  readonly fileSystemSession: StorageFileSystemSession;
  readonly openAuthenticatedInspectionSession: (() => Promise<Readonly<{
    session: HizoFSAuthenticatedInspectionSession;
    close(): Promise<void>;
  }>>) | undefined;
  close(): Promise<void>;
  openManagementCleanHeadBarrier(): OpfsPersistenceManagementCleanHeadBarrier;
}

export type OpfsPersistenceRetainedCredential = Readonly<{
  passphrase: string;
  sourceSlotId?: string;
}>;

export type OpfsPersistenceTransitionRequest =
  | { readonly operation: 'enable'; readonly passphrase: string }
  | { readonly operation: 'disable'; readonly session: OpfsPersistenceUnlockedSession }
  | {
      readonly operation: 'reencrypt';
      readonly retainedCredentials: readonly OpfsPersistenceRetainedCredential[];
      readonly session: OpfsPersistenceUnlockedSession;
    }
  | {
      readonly operation: 'converge';
      readonly retainedCredentials: readonly OpfsPersistenceRetainedCredential[];
    }
  | { readonly operation: 'return_to_plain'; readonly passphrase: string };

export type OpfsPersistenceTransitionResult = { readonly type: 'completed' };

/**
 * Application composition port for Naidan Persistence Control and HizoFS.
 *
 * The OPFS provider owns application lifecycle and locking only. This port owns
 * passphrase unlock, container selection, transition orchestration, and the
 * secret-bearing capabilities needed by those operations. The provider must
 * never receive raw root keys, physical writers, or format authority.
 */
export interface OpfsPersistenceRuntime {
  readonly writableProfile: OpfsPersistenceWritableProfile;
  inspect({ storageRoot }: { storageRoot: FileSystemDirectoryHandle }): Promise<OpfsEncryptionInspection>;
  runStartupMaintenance({ nativeNamespaceRoot, storageRoot }: {
    nativeNamespaceRoot: FileSystemDirectoryHandle;
    storageRoot: FileSystemDirectoryHandle;
  }): Promise<void>;
  runUnlockedMaintenance({ nativeNamespaceRoot, session, storageRoot }: {
    nativeNamespaceRoot: FileSystemDirectoryHandle;
    session: OpfsPersistenceUnlockedSession;
    storageRoot: FileSystemDirectoryHandle;
  }): Promise<OpfsPersistenceUnlockedMaintenanceResult>;
  unlockWithPassphrase({ passphrase, storageRoot }: {
    passphrase: string;
    storageRoot: FileSystemDirectoryHandle;
  }): Promise<OpfsPersistenceUnlockedSession>;
  changePassphrase({ passphrase, session, storageRoot }: {
    passphrase: string;
    session: OpfsPersistenceUnlockedSession;
    storageRoot: FileSystemDirectoryHandle;
  }): Promise<OpfsPersistenceUnlockedSession>;
  runTransition({ nativeNamespaceRoot, onProgress, request, signal, storageRoot }: {
    nativeNamespaceRoot: FileSystemDirectoryHandle;
    onProgress: OpfsEncryptionTransitionProgressListener | undefined;
    request: OpfsPersistenceTransitionRequest;
    signal: AbortSignal | undefined;
    storageRoot: FileSystemDirectoryHandle;
  }): Promise<OpfsPersistenceTransitionResult>;
}

export type OpfsPersistenceRuntimeFactory = () => Promise<OpfsPersistenceRuntime>;

function testFileSystemId({ value }: { value: string }): FileSystemId {
  return value as FileSystemId;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createCredentialRequiredInspection({ firstSequence, secondSequence }: {
    firstSequence: number | undefined;
    secondSequence: number | undefined;
  }): Extract<OpfsEncryptionInspection, { type: 'credential_required' }> {
    return {
      blockingReason: 'protection_unresolved',
      requiredAction: 'unlock',
      candidates: [
        { copy: 0, sequence: firstSequence, state: 'protection_unresolved' },
        { copy: 1, sequence: secondSequence, state: 'protection_unresolved' },
      ],
      type: 'credential_required',
    };
  },
  createTransitionCredentialRequiredInspection({ firstSequence, secondSequence }: {
    firstSequence: number | undefined;
    secondSequence: number | undefined;
  }): Extract<OpfsEncryptionInspection, { type: 'credential_required' }> {
    return {
      blockingReason: 'protection_unresolved',
      requiredAction: 'converge_transition',
      candidates: [
        { copy: 0, sequence: firstSequence, state: 'protection_unresolved' },
        { copy: 1, sequence: secondSequence, state: 'protection_unresolved' },
      ],
      type: 'credential_required',
    };
  },
  createEncryptedInspection({ fileSystemId }: { fileSystemId: string }): Extract<OpfsEncryptionInspection, { type: 'encrypted' }> {
    const brandedFileSystemId = testFileSystemId({ value: fileSystemId });
    const mode = { activeFileSystemId: brandedFileSystemId, type: 'hizofs' } as const;
    return {
      control: {
        copy: 0,
        format: 'naidan-persistence-control',
        formatVersion: 1,
        mode,
        protection: { digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', type: 'plain_sha256' },
        retiredFileSystemIds: [],
        sequence: 1,
      },
      mode,
      type: 'encrypted',
    };
  },
  createTransitioningInspection({ operation, phase, sourceFileSystemId, targetFileSystemId }: {
    operation: 'decrypt' | 'encrypt' | 're_encrypt';
    phase: 'building_target' | 'cleaning_up_source';
    sourceFileSystemId: string | undefined;
    targetFileSystemId: string | undefined;
  }): Extract<OpfsEncryptionInspection, { type: 'transitioning' }> {
    const source = sourceFileSystemId === undefined
      ? { type: 'plain' } as const
      : { fileSystemId: testFileSystemId({ value: sourceFileSystemId }), type: 'hizofs' } as const;
    const target = targetFileSystemId === undefined
      ? { type: 'plain' } as const
      : { fileSystemId: testFileSystemId({ value: targetFileSystemId }), type: 'hizofs' } as const;
    const mode = {
      operation,
      operationId: 'transitionOperation01' as import('@/00-storage/service/naidan-persistence-control/00-format').TransitionOperationId,
      phase: { source, target, type: phase },
      type: 'transitioning',
    } as const;
    return {
      control: {
        copy: 0,
        format: 'naidan-persistence-control',
        formatVersion: 1,
        mode,
        protection: { digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', type: 'plain_sha256' },
        retiredFileSystemIds: [],
        sequence: 2,
      },
      mode,
      type: 'transitioning',
    };
  },
};
