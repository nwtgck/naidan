import type { FileSystemId } from '@/00-storage/service/hizofs/compatibility/persistence-control-primitives';
import type {
  NaidanPersistenceControlV1,
  PersistenceControlCandidate,
  PersistenceControlCopy,
  PersistenceControlSelectionErrorCode,
} from '@/00-storage/service/naidan-persistence-control/00-format';

export type PersistenceControlModeInspection =
  | { readonly type: 'plain' }
  | { readonly activeFileSystemId: FileSystemId; readonly type: 'hizofs' }
  | {
      readonly operation: 'decrypt' | 'encrypt' | 're_encrypt';
      readonly operationId: string;
      readonly phase: {
        readonly source: { readonly fileSystemId?: FileSystemId; readonly type: 'hizofs' | 'plain' };
        readonly target: { readonly fileSystemId?: FileSystemId; readonly type: 'hizofs' | 'plain' };
        readonly type: 'building_target' | 'cleaning_up_source';
      };
      readonly type: 'transitioning';
    };

/**
 * This DTO intentionally retains the exact parsed persisted control object.
 * The debug feature is an audit surface for storage implementers and reviewers,
 * not a general-user summary. Keeping the authoritative DTO prevents a mapper
 * from silently omitting newly persisted fields such as proof material.
 */
export type PersistenceControlCopyInspection = {
  readonly authenticationFileSystemId: FileSystemId | undefined;
  readonly control: NaidanPersistenceControlV1 | undefined;
  readonly copy: PersistenceControlCopy;
  readonly mode: PersistenceControlModeInspection | undefined;
  readonly physicalPath: readonly [string, string];
  readonly protection: 'hizofs_aes_256_gcm' | 'plain_sha256' | undefined;
  readonly reason: string | undefined;
  readonly retiredFileSystemIds: readonly FileSystemId[];
  readonly selected: boolean;
  readonly sequence: number | undefined;
  readonly state: PersistenceControlCandidate['state'];
};

export type PersistenceControlSelectionInspection =
  | {
      readonly copy: PersistenceControlCopy;
      readonly redundancy: 'converged' | 'degraded';
      readonly sequence: number;
      readonly state: 'selected';
    }
  | {
      readonly code: PersistenceControlSelectionErrorCode;
      readonly message: string;
      readonly state: 'rejected';
    };

export type PersistenceControlInspection = {
  readonly copies: readonly [PersistenceControlCopyInspection, PersistenceControlCopyInspection];
  readonly observedSequences: readonly [number | undefined, number | undefined];
  readonly selection: PersistenceControlSelectionInspection;
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
