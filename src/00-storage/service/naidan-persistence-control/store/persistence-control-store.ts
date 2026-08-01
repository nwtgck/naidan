import type { FileSystemId } from '@/00-storage/service/hizofs/compatibility';
import {
  decodePersistenceControl,
  encodePersistenceControl,
  NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS,
  persistenceControlAuthenticationFileSystemId,
  persistenceControlSemanticallyEquals,
  planPersistenceControlPublication,
  selectPersistenceControlAuthority,
  type NaidanPersistenceControlCoreV1,
  type NaidanPersistenceModeV1,
  type NaidanPersistenceControlV1,
  type PersistenceControlCandidate,
  type PersistenceControlCopy,
  type SelectedPersistenceControlAuthority,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import {
  createHizoFSControlProtection,
  createPlainControlProtection,
  verifyHizoFSControlProtection,
  verifyPlainControlProtection,
  type PersistenceControlRandomSource,
  type PersistenceControlRootKeyDerivationCapability,
} from '@/00-storage/service/naidan-persistence-control/crypto';

export type PersistenceControlSemanticState = {
  readonly mode: NaidanPersistenceModeV1;
  readonly retiredFileSystemIds: readonly FileSystemId[];
};

export interface PersistenceControlReadablePhysicalPort {
  readFileBounded({ copy, maximumByteLength }: { copy: PersistenceControlCopy; maximumByteLength: number }): Promise<Uint8Array | undefined>;
}

export interface PersistenceControlPhysicalPort extends PersistenceControlReadablePhysicalPort {
  publishWholeFileDurably({ bytes, copy }: { bytes: Uint8Array; copy: PersistenceControlCopy }): Promise<void>;
  runExclusive<T>({ operation }: { operation: () => Promise<T> }): Promise<T>;
}

export type PersistenceControlRootKeyResolution =
  | { readonly state: 'unresolved' }
  | { readonly rootKey: PersistenceControlRootKeyDerivationCapability; readonly state: 'resolved' };

export interface PersistenceControlProofAuthority {
  resolveRootKey({ fileSystemId }: { fileSystemId: FileSystemId }): Promise<PersistenceControlRootKeyResolution>;
  validateEndpointReadiness({ control }: { control: NaidanPersistenceControlV1 }): Promise<'invalid' | 'valid'>;
}

export type PersistenceControlReadResult = {
  readonly candidates: readonly [PersistenceControlCandidate, PersistenceControlCandidate];
  readonly observedSequences: readonly [number | undefined, number | undefined];
};

export class PersistenceControlPublicationError extends Error {
  public constructor({ cause, code, committedAuthority, message }: {
    cause: unknown;
    code: 'authority_commit_failed' | 'convergence_failed' | 'publication_protection_unresolved';
    committedAuthority: SelectedPersistenceControlAuthority | undefined;
    message: string;
  }) {
    super(message, { cause });
    this.code = code;
    this.committedAuthority = committedAuthority;
    this.name = 'PersistenceControlPublicationError';
  }

  public readonly code: 'authority_commit_failed' | 'convergence_failed' | 'publication_protection_unresolved';
  public readonly committedAuthority: SelectedPersistenceControlAuthority | undefined;
}

function reason({ cause }: { cause: unknown }): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

async function classifyControl({ bytes, copy, proofAuthority }: {
  bytes: Uint8Array | undefined;
  copy: PersistenceControlCopy;
  proofAuthority: PersistenceControlProofAuthority;
}): Promise<PersistenceControlCandidate> {
  if (bytes === undefined) return { copy, reason: 'missing', state: 'structurally_invalid' };
  let control: NaidanPersistenceControlV1;
  try {
    control = decodePersistenceControl({ bytes });
  } catch (cause: unknown) {
    return { copy, reason: reason({ cause }), state: 'structurally_invalid' };
  }
  if (control.copy !== copy) return { control, copy, reason: 'persisted copy does not match filename', state: 'proof_invalid' };

  // Protection must be resolved before endpoint identity is treated as
  // checkable authority. In particular, a protected higher candidate whose
  // root key is unavailable is not proof-invalid and must remain visible as
  // protection_unresolved so lower routing stays blocked.
  switch (control.protection.type) {
  case 'plain_sha256':
    if (!(await verifyPlainControlProtection({ control }))) {
      return { control, copy, reason: 'plain digest mismatch', state: 'proof_invalid' };
    }
    break;
  case 'hizofs_aes_256_gcm': {
    const resolution = await proofAuthority.resolveRootKey({ fileSystemId: control.protection.authenticationFileSystemId });
    switch (resolution.state) {
    case 'unresolved': return { control, copy, state: 'protection_unresolved' };
    case 'resolved':
      if (!(await verifyHizoFSControlProtection({ control, rootKey: resolution.rootKey }))) {
        return { control, copy, reason: 'HizoFS control authenticator mismatch', state: 'proof_invalid' };
      }
      break;
    default: {
      const unhandled: never = resolution;
      throw new Error(`unhandled root-key resolution: ${String(unhandled)}`);
    }
    }
    break;
  }
  default: {
    const unhandled: never = control.protection;
    throw new Error(`unhandled control protection: ${String(unhandled)}`);
  }
  }

  const endpointReadiness = await proofAuthority.validateEndpointReadiness({ control });
  switch (endpointReadiness) {
  case 'invalid': return { control, copy, reason: 'endpoint readiness or identity validation failed', state: 'proof_invalid' };
  case 'valid': return { control, copy, state: 'proof_valid' };
  default: return endpointReadiness satisfies never;
  }
}

function structurallyObservedSequence({ candidate }: {
  candidate: PersistenceControlCandidate;
}): number | undefined {
  switch (candidate.state) {
  case 'structurally_invalid': return undefined;
  case 'proof_invalid':
  case 'proof_valid':
  case 'protection_unresolved': return candidate.control.sequence;
  default: return candidate satisfies never;
  }
}

export async function readPersistenceControlCandidates({ physical, proofAuthority }: {
  physical: PersistenceControlReadablePhysicalPort;
  proofAuthority: PersistenceControlProofAuthority;
}): Promise<PersistenceControlReadResult> {
  const maximumByteLength = NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.limits.persistenceControlJsonBytes;
  const bytes0 = await physical.readFileBounded({ copy: 0, maximumByteLength });
  const bytes1 = await physical.readFileBounded({ copy: 1, maximumByteLength });
  const candidate0 = await classifyControl({ bytes: bytes0, copy: 0, proofAuthority });
  const candidate1 = await classifyControl({ bytes: bytes1, copy: 1, proofAuthority });
  const observedSequences = [
    structurallyObservedSequence({ candidate: candidate0 }),
    structurallyObservedSequence({ candidate: candidate1 }),
  ] as const;
  return { candidates: [candidate0, candidate1], observedSequences };
}

export async function openPersistenceControl({ physical, proofAuthority }: {
  physical: PersistenceControlReadablePhysicalPort;
  proofAuthority: PersistenceControlProofAuthority;
}): Promise<SelectedPersistenceControlAuthority> {
  return selectPersistenceControlAuthority((await readPersistenceControlCandidates({ physical, proofAuthority })));
}

async function createProtectedControl({ copy, proofAuthority, randomSource, semanticState, sequence }: {
  copy: PersistenceControlCopy;
  proofAuthority: PersistenceControlProofAuthority;
  randomSource: PersistenceControlRandomSource | undefined;
  semanticState: PersistenceControlSemanticState;
  sequence: number;
}): Promise<NaidanPersistenceControlV1> {
  const core: NaidanPersistenceControlCoreV1 = {
    copy,
    format: 'naidan-persistence-control',
    formatVersion: 1,
    mode: semanticState.mode,
    retiredFileSystemIds: semanticState.retiredFileSystemIds,
    sequence,
  };
  const authenticationFileSystemId = persistenceControlAuthenticationFileSystemId({ mode: semanticState.mode });
  if (authenticationFileSystemId === undefined) return { ...core, protection: await createPlainControlProtection({ core }) };
  const resolution = await proofAuthority.resolveRootKey({ fileSystemId: authenticationFileSystemId });
  switch (resolution.state) {
  case 'unresolved':
    throw new PersistenceControlPublicationError({
      cause: undefined,
      code: 'publication_protection_unresolved',
      committedAuthority: undefined,
      message: 'cannot publish HizoFS-protected control without the authentication root key',
    });
  case 'resolved':
    return {
      ...core,
      protection: await createHizoFSControlProtection({
        authenticationFileSystemId,
        core,
        randomSource,
        rootKey: resolution.rootKey,
      }),
    };
  default: return resolution satisfies never;
  }
}

async function verifyPublishedCopy({ control, copy, physical, proofAuthority }: {
  control: NaidanPersistenceControlV1;
  copy: PersistenceControlCopy;
  physical: PersistenceControlPhysicalPort;
  proofAuthority: PersistenceControlProofAuthority;
}): Promise<SelectedPersistenceControlAuthority> {
  const bytes = await physical.readFileBounded({
    copy,
    maximumByteLength: NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.limits.persistenceControlJsonBytes,
  });
  const candidate = await classifyControl({ bytes, copy, proofAuthority });
  if (candidate.state !== 'proof_valid'
    || candidate.control.sequence !== control.sequence
    || !persistenceControlSemanticallyEquals({ left: candidate.control, right: control })) {
    throw new Error(`Persistence Control copy ${copy} failed proof-valid exact semantic read-back`);
  }
  return { control: candidate.control, copy, redundancy: 'degraded' };
}

export async function publishPersistenceControl({
  bootstrapAuthorization,
  physical,
  proofAuthority,
  randomSource,
  semanticState,
}: {
  bootstrapAuthorization: 'verified_plain_namespace' | undefined;
  physical: PersistenceControlPhysicalPort;
  proofAuthority: PersistenceControlProofAuthority;
  randomSource: PersistenceControlRandomSource | undefined;
  semanticState: PersistenceControlSemanticState;
}): Promise<SelectedPersistenceControlAuthority> {
  return await physical.runExclusive({
    operation: async () => {
      const before = await readPersistenceControlCandidates({ physical, proofAuthority });
      let selected: SelectedPersistenceControlAuthority | undefined;
      try {
        selected = selectPersistenceControlAuthority({ candidates: before.candidates });
      } catch (cause: unknown) {
        const bothMissing = before.candidates.every(candidate => candidate.state === 'structurally_invalid' && candidate.reason === 'missing');
        if (bootstrapAuthorization !== 'verified_plain_namespace' || !bothMissing) throw cause;
      }
      const plan = planPersistenceControlPublication({
        observedSequences: before.observedSequences,
        selectedAuthority: selected === undefined ? undefined : { copy: selected.copy, sequence: selected.control.sequence },
      });
      const firstControl = await createProtectedControl({
        copy: plan.authorityCommitPoint.copy,
        proofAuthority,
        randomSource,
        semanticState,
        sequence: plan.authorityCommitPoint.sequence,
      });
      let committedAuthority: SelectedPersistenceControlAuthority | undefined;
      try {
        await physical.publishWholeFileDurably({ bytes: encodePersistenceControl({ control: firstControl }), copy: firstControl.copy });
        committedAuthority = await verifyPublishedCopy({ control: firstControl, copy: firstControl.copy, physical, proofAuthority });
      } catch (cause: unknown) {
        throw new PersistenceControlPublicationError({
          cause,
          code: 'authority_commit_failed',
          committedAuthority: undefined,
          message: 'Persistence Control authority commit point did not verify',
        });
      }
      const secondControl = await createProtectedControl({
        copy: plan.convergence.copy,
        proofAuthority,
        randomSource,
        semanticState,
        sequence: plan.convergence.sequence,
      });
      try {
        await physical.publishWholeFileDurably({ bytes: encodePersistenceControl({ control: secondControl }), copy: secondControl.copy });
        await verifyPublishedCopy({ control: secondControl, copy: secondControl.copy, physical, proofAuthority });
        return selectPersistenceControlAuthority({ candidates: (await readPersistenceControlCandidates({ physical, proofAuthority })).candidates });
      } catch (cause: unknown) {
        throw new PersistenceControlPublicationError({
          cause,
          code: 'convergence_failed',
          committedAuthority,
          message: 'Persistence Control authority committed but redundancy convergence failed',
        });
      }
    },
  });
}

export async function resolvePersistenceControlPublicationOutcome({ desiredState, physical, proofAuthority }: {
  desiredState: PersistenceControlSemanticState;
  physical: PersistenceControlPhysicalPort;
  proofAuthority: PersistenceControlProofAuthority;
}): Promise<'committed_degraded' | 'committed_converged' | 'not_committed'> {
  let selected: SelectedPersistenceControlAuthority;
  try {
    selected = await openPersistenceControl({ physical, proofAuthority });
  } catch {
    return 'not_committed';
  }
  const desiredControl: NaidanPersistenceControlV1 = {
    ...selected.control,
    mode: desiredState.mode,
    retiredFileSystemIds: desiredState.retiredFileSystemIds,
  };
  if (!persistenceControlSemanticallyEquals({ left: selected.control, right: desiredControl })) return 'not_committed';
  switch (selected.redundancy) {
  case 'converged': return 'committed_converged';
  case 'degraded': return 'committed_degraded';
  default: return selected.redundancy satisfies never;
  }
}

export const TEST_ONLY = {
  classifyControl,
  createProtectedControl,
  verifyPublishedCopy,
};
