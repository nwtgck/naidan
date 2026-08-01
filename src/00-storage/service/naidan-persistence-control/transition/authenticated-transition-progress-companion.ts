import type { FileSystemId } from '@/00-storage/service/hizofs/compatibility';
import {
  transitionProgressAuthenticationFileSystemId,
  type NaidanPersistenceEndpointV1,
  type TransitionOperationId,
  type TransitionProgressPayloadV1,
  type TransitionProgressProviderCheckpointCodec,
  type TransitionProgressProviderCheckpointState,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import type {
  PersistenceControlRandomSource,
  PersistenceControlRootKeyDerivationCapability,
} from '@/00-storage/service/naidan-persistence-control/crypto';
import {
  clearTransitionProgress,
  openTransitionProgress,
  publishTransitionProgress,
  type TransitionProgressPhysicalPort,
  type TransitionProgressProofAuthority,
} from '@/00-storage/service/naidan-persistence-control/store';

export type AuthenticatedTransitionProgressBinding = Readonly<{
  operationId: TransitionOperationId;
  providerCheckpointCodec: TransitionProgressProviderCheckpointCodec;
  sourceAuthorityIdentity: string;
  sourceEndpoint: NaidanPersistenceEndpointV1;
  targetAuthorityIdentity: string;
  targetEndpoint: NaidanPersistenceEndpointV1;
}>;

export type AuthenticatedTransitionProgressSnapshot = Readonly<{
  journalGeneration: bigint;
  portableProgressBytes: Uint8Array;
  providerCheckpointBytes: Uint8Array;
  providerCheckpointCodec: TransitionProgressProviderCheckpointCodec;
  providerCheckpointState: TransitionProgressProviderCheckpointState;
}>;

export interface TransitionProgressRootKeyProofScope {
  withRootKeyProof<T>({ fileSystemId, operation }: {
    fileSystemId: FileSystemId;
    operation: ({ rootKey }: {
      rootKey: PersistenceControlRootKeyDerivationCapability;
    }) => Promise<T>;
  }): Promise<T>;
}

function sameEndpoint({ left, right }: {
  left: NaidanPersistenceEndpointV1;
  right: NaidanPersistenceEndpointV1;
}): boolean {
  switch (left.type) {
  case 'plain': return right.type === 'plain';
  case 'hizofs': return right.type === 'hizofs' && left.fileSystemId === right.fileSystemId;
  default: return left satisfies never;
  }
}

function validateSelectedBinding({ binding, payload }: {
  binding: AuthenticatedTransitionProgressBinding;
  payload: TransitionProgressPayloadV1;
}): void {
  if (payload.providerCheckpointCodec !== binding.providerCheckpointCodec
    || payload.sourceAuthorityIdentity !== binding.sourceAuthorityIdentity
    || payload.targetAuthorityIdentity !== binding.targetAuthorityIdentity
    || !sameEndpoint({ left: payload.sourceEndpoint, right: binding.sourceEndpoint })
    || !sameEndpoint({ left: payload.targetEndpoint, right: binding.targetEndpoint })) {
    throw new TypeError('transition-progress companion belongs to another authority or endpoint binding');
  }
}

function snapshot({ payload }: {
  payload: TransitionProgressPayloadV1;
}): AuthenticatedTransitionProgressSnapshot {
  return {
    journalGeneration: payload.journalGeneration,
    portableProgressBytes: Uint8Array.from(payload.portableProgressBytes),
    providerCheckpointBytes: Uint8Array.from(payload.providerCheckpointBytes),
    providerCheckpointCodec: payload.providerCheckpointCodec,
    providerCheckpointState: payload.providerCheckpointState,
  };
}

/**
 * Owns one exact transition-progress companion without retaining a root-key
 * capability. Every read, publish, or clear enters the authenticated HizoFS
 * proof scope only for the duration of that operation, while the caller sees
 * detached opaque progress bytes rather than secret-bearing authority.
 */
export class AuthenticatedTransitionProgressCompanion {
  readonly #authenticationFileSystemId: FileSystemId;
  readonly #binding: AuthenticatedTransitionProgressBinding;
  readonly #physical: TransitionProgressPhysicalPort;
  readonly #proofScope: TransitionProgressRootKeyProofScope;
  readonly #randomSource: PersistenceControlRandomSource | undefined;

  public constructor({ binding, physical, proofScope, randomSource }: {
    binding: AuthenticatedTransitionProgressBinding;
    physical: TransitionProgressPhysicalPort;
    proofScope: TransitionProgressRootKeyProofScope;
    randomSource: PersistenceControlRandomSource | undefined;
  }) {
    this.#binding = structuredClone(binding);
    this.#physical = physical;
    this.#proofScope = proofScope;
    this.#randomSource = randomSource;
    this.#authenticationFileSystemId = transitionProgressAuthenticationFileSystemId({
      sourceEndpoint: binding.sourceEndpoint,
      targetEndpoint: binding.targetEndpoint,
    });
  }

  async #withProof<T>({ operation }: {
    operation: ({ proofAuthority }: {
      proofAuthority: TransitionProgressProofAuthority;
    }) => Promise<T>;
  }): Promise<T> {
    return await this.#proofScope.withRootKeyProof({
      fileSystemId: this.#authenticationFileSystemId,
      operation: async ({ rootKey }) => await operation({
        proofAuthority: {
          resolveRootKey: async ({ fileSystemId }) => fileSystemId === this.#authenticationFileSystemId
            ? { rootKey, state: 'resolved' }
            : { state: 'unresolved' },
        },
      }),
    });
  }

  public async clear({ expectedJournalGeneration }: {
    expectedJournalGeneration: bigint;
  }): Promise<void> {
    await this.#withProof({ operation: async ({ proofAuthority }) => await clearTransitionProgress({
      expectedJournalGeneration,
      operationId: this.#binding.operationId,
      physical: this.#physical,
      proofAuthority,
    }) });
  }

  public async load(): Promise<AuthenticatedTransitionProgressSnapshot | undefined> {
    return await this.#withProof({ operation: async ({ proofAuthority }) => {
      const selected = await openTransitionProgress({
        operationId: this.#binding.operationId,
        physical: this.#physical,
        proofAuthority,
      });
      if (selected === undefined) return undefined;
      validateSelectedBinding({ binding: this.#binding, payload: selected.payload });
      return snapshot({ payload: selected.payload });
    } });
  }

  public async publish({ expectedJournalGeneration, progress }: {
    expectedJournalGeneration: bigint | undefined;
    progress: Omit<AuthenticatedTransitionProgressSnapshot, 'providerCheckpointCodec'>;
  }): Promise<AuthenticatedTransitionProgressSnapshot> {
    return await this.#withProof({ operation: async ({ proofAuthority }) => {
      const selected = await publishTransitionProgress({
        expectedJournalGeneration,
        operationId: this.#binding.operationId,
        payload: {
          journalGeneration: progress.journalGeneration,
          portableProgressBytes: Uint8Array.from(progress.portableProgressBytes),
          providerCheckpointBytes: Uint8Array.from(progress.providerCheckpointBytes),
          providerCheckpointCodec: this.#binding.providerCheckpointCodec,
          providerCheckpointState: progress.providerCheckpointState,
          sourceAuthorityIdentity: this.#binding.sourceAuthorityIdentity,
          sourceEndpoint: structuredClone(this.#binding.sourceEndpoint),
          targetAuthorityIdentity: this.#binding.targetAuthorityIdentity,
          targetEndpoint: structuredClone(this.#binding.targetEndpoint),
        },
        physical: this.#physical,
        proofAuthority,
        randomSource: this.#randomSource,
      });
      validateSelectedBinding({ binding: this.#binding, payload: selected.payload });
      return snapshot({ payload: selected.payload });
    } });
  }
}

export const TEST_ONLY = {
  sameEndpoint,
  validateSelectedBinding,
};
