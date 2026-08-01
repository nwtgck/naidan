import type { FileSystemId } from '@/00-storage/service/hizofs/compatibility';
import {
  decodeTransitionProgressEnvelope,
  encodeTransitionProgressEnvelope,
  NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS,
  type NaidanTransitionProgressEnvelopeV1,
  type TransitionOperationId,
  type TransitionProgressCopy,
  type TransitionProgressPayloadV1,
  transitionProgressAuthenticationFileSystemId,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import {
  openProtectedTransitionProgress,
  protectTransitionProgress,
  type PersistenceControlRandomSource,
  type PersistenceControlRootKeyDerivationCapability,
} from '@/00-storage/service/naidan-persistence-control/crypto';

export interface TransitionProgressReadablePhysicalPort {
  readFileBounded({ copy, maximumByteLength }: {
    copy: TransitionProgressCopy;
    maximumByteLength: number;
  }): Promise<Uint8Array | undefined>;
}

export interface TransitionProgressPhysicalPort extends TransitionProgressReadablePhysicalPort {
  publishWholeFileDurably({ bytes, copy }: { bytes: Uint8Array; copy: TransitionProgressCopy }): Promise<void>;
  removeFile({ copy }: { copy: TransitionProgressCopy }): Promise<void>;
  runExclusive<T>({ operation }: { operation: () => Promise<T> }): Promise<T>;
}

export type TransitionProgressRootKeyResolution =
  | { readonly state: 'unresolved' }
  | { readonly rootKey: PersistenceControlRootKeyDerivationCapability; readonly state: 'resolved' };

export interface TransitionProgressProofAuthority {
  resolveRootKey({ fileSystemId }: { fileSystemId: FileSystemId }): Promise<TransitionProgressRootKeyResolution>;
}

export type TransitionProgressCandidate =
  | { readonly copy: TransitionProgressCopy; readonly reason: string; readonly state: 'structurally_invalid' }
  | { readonly copy: TransitionProgressCopy; readonly envelope: NaidanTransitionProgressEnvelopeV1; readonly state: 'protection_unresolved' }
  | { readonly copy: TransitionProgressCopy; readonly envelope: NaidanTransitionProgressEnvelopeV1; readonly reason: string; readonly state: 'proof_invalid' }
  | {
      readonly copy: TransitionProgressCopy;
      readonly envelope: NaidanTransitionProgressEnvelopeV1;
      readonly payload: TransitionProgressPayloadV1;
      readonly state: 'proof_valid';
    };

export type SelectedTransitionProgressAuthority = Readonly<{
  copy: TransitionProgressCopy;
  envelope: NaidanTransitionProgressEnvelopeV1;
  payload: TransitionProgressPayloadV1;
  redundancy: 'converged' | 'degraded';
}>;

export class TransitionProgressSelectionError extends Error {
  public constructor({ code, message }: { code: TransitionProgressSelectionErrorCode; message: string }) {
    super(message);
    this.code = code;
    this.name = 'TransitionProgressSelectionError';
  }

  public readonly code: TransitionProgressSelectionErrorCode;
}

export type TransitionProgressSelectionErrorCode =
  | 'copy_identity_mismatch'
  | 'higher_protection_unresolved'
  | 'no_proof_valid_authority'
  | 'operation_mismatch'
  | 'sequence_reuse_corruption';

export class TransitionProgressPublicationError extends Error {
  public constructor({ cause, code, committedAuthority, message }: {
    cause: unknown;
    code: 'authority_commit_failed' | 'convergence_failed' | 'generation_conflict' | 'protection_unresolved';
    committedAuthority: SelectedTransitionProgressAuthority | undefined;
    message: string;
  }) {
    super(message, { cause });
    this.code = code;
    this.committedAuthority = committedAuthority;
    this.name = 'TransitionProgressPublicationError';
  }

  public readonly code: 'authority_commit_failed' | 'convergence_failed' | 'generation_conflict' | 'protection_unresolved';
  public readonly committedAuthority: SelectedTransitionProgressAuthority | undefined;
}

function reason({ cause }: { cause: unknown }): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

function bytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function endpointEqual({ left, right }: {
  left: TransitionProgressPayloadV1['sourceEndpoint'];
  right: TransitionProgressPayloadV1['sourceEndpoint'];
}): boolean {
  if (left.type !== right.type) return false;
  switch (left.type) {
  case 'plain': return true;
  case 'hizofs': return right.type === 'hizofs' && left.fileSystemId === right.fileSystemId;
  default: return left satisfies never;
  }
}

function payloadSemanticallyEquals({ left, right }: {
  left: TransitionProgressPayloadV1;
  right: TransitionProgressPayloadV1;
}): boolean {
  return left.journalGeneration === right.journalGeneration
    && left.providerCheckpointCodec === right.providerCheckpointCodec
    && left.providerCheckpointState === right.providerCheckpointState
    && left.sourceAuthorityIdentity === right.sourceAuthorityIdentity
    && left.targetAuthorityIdentity === right.targetAuthorityIdentity
    && endpointEqual({ left: left.sourceEndpoint, right: right.sourceEndpoint })
    && endpointEqual({ left: left.targetEndpoint, right: right.targetEndpoint })
    && bytesEqual({ left: left.portableProgressBytes, right: right.portableProgressBytes })
    && bytesEqual({ left: left.providerCheckpointBytes, right: right.providerCheckpointBytes });
}

async function classifyCandidate({ bytes, copy, proofAuthority }: {
  bytes: Uint8Array | undefined;
  copy: TransitionProgressCopy;
  proofAuthority: TransitionProgressProofAuthority;
}): Promise<TransitionProgressCandidate> {
  if (bytes === undefined) return { copy, reason: 'missing', state: 'structurally_invalid' };
  let envelope: NaidanTransitionProgressEnvelopeV1;
  try {
    envelope = decodeTransitionProgressEnvelope({ bytes });
  } catch (cause: unknown) {
    return { copy, reason: reason({ cause }), state: 'structurally_invalid' };
  }
  if (envelope.copy !== copy) return { copy, envelope, reason: 'persisted copy does not match filename', state: 'proof_invalid' };
  const resolution = await proofAuthority.resolveRootKey({ fileSystemId: envelope.authenticationFileSystemId });
  switch (resolution.state) {
  case 'unresolved': return { copy, envelope, state: 'protection_unresolved' };
  case 'resolved': {
    const payload = await openProtectedTransitionProgress({ envelope, rootKey: resolution.rootKey });
    if (payload === undefined) return { copy, envelope, reason: 'transition-progress authentication failed', state: 'proof_invalid' };
    if (transitionProgressAuthenticationFileSystemId({ sourceEndpoint: payload.sourceEndpoint, targetEndpoint: payload.targetEndpoint }) !== envelope.authenticationFileSystemId) {
      return { copy, envelope, reason: 'authentication File System ID does not match endpoint binding', state: 'proof_invalid' };
    }
    return { copy, envelope, payload, state: 'proof_valid' };
  }
  default: return resolution satisfies never;
  }
}

function structuralSequence({ candidate }: { candidate: TransitionProgressCandidate }): number | undefined {
  switch (candidate.state) {
  case 'structurally_invalid': return undefined;
  case 'protection_unresolved':
  case 'proof_invalid':
  case 'proof_valid': return candidate.envelope.sequence;
  default: return candidate satisfies never;
  }
}

export async function readTransitionProgressCandidates({ physical, proofAuthority }: {
  physical: TransitionProgressReadablePhysicalPort;
  proofAuthority: TransitionProgressProofAuthority;
}): Promise<readonly [TransitionProgressCandidate, TransitionProgressCandidate]> {
  const maximumByteLength = NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.limits.companionJsonBytes;
  return [
    await classifyCandidate({ bytes: await physical.readFileBounded({ copy: 0, maximumByteLength }), copy: 0, proofAuthority }),
    await classifyCandidate({ bytes: await physical.readFileBounded({ copy: 1, maximumByteLength }), copy: 1, proofAuthority }),
  ];
}

function selectTransitionProgressAuthority({ candidates }: {
  candidates: readonly [TransitionProgressCandidate, TransitionProgressCandidate];
}): SelectedTransitionProgressAuthority | undefined {
  if (candidates[0].copy === candidates[1].copy) {
    throw new TransitionProgressSelectionError({ code: 'copy_identity_mismatch', message: 'transition-progress candidates must represent distinct copies' });
  }
  for (const candidate of candidates) {
    if (candidate.state !== 'structurally_invalid' && candidate.envelope.copy !== candidate.copy) {
      throw new TransitionProgressSelectionError({ code: 'copy_identity_mismatch', message: 'transition-progress filename copy and persisted copy disagree' });
    }
  }
  const sequences = candidates.map(candidate => structuralSequence({ candidate }));
  if (sequences[0] !== undefined && sequences[0] === sequences[1]) {
    throw new TransitionProgressSelectionError({ code: 'sequence_reuse_corruption', message: 'transition-progress sequence was reused across copies' });
  }
  const highestStructuralSequence = Math.max(...sequences.map(value => value ?? 0));
  if (highestStructuralSequence === 0) return undefined;
  const highestCandidate = candidates.find(candidate => structuralSequence({ candidate }) === highestStructuralSequence);
  if (highestCandidate === undefined) {
    throw new TransitionProgressSelectionError({ code: 'no_proof_valid_authority', message: 'highest transition-progress candidate is missing' });
  }
  switch (highestCandidate.state) {
  case 'protection_unresolved':
    throw new TransitionProgressSelectionError({
      code: 'higher_protection_unresolved',
      message: 'higher transition-progress candidate protection is unresolved',
    });
  case 'proof_invalid':
  case 'proof_valid': break;
  case 'structurally_invalid':
    throw new TransitionProgressSelectionError({ code: 'no_proof_valid_authority', message: 'highest transition-progress candidate is structurally invalid' });
  default: return highestCandidate satisfies never;
  }
  const valid = candidates.filter((candidate): candidate is Extract<TransitionProgressCandidate, { state: 'proof_valid' }> => candidate.state === 'proof_valid')
    .sort((left, right) => right.envelope.sequence - left.envelope.sequence);
  const selected = valid[0];
  if (selected === undefined) {
    throw new TransitionProgressSelectionError({ code: 'no_proof_valid_authority', message: 'no proof-valid transition-progress authority exists' });
  }
  const other = valid[1];
  return {
    copy: selected.copy,
    envelope: selected.envelope,
    payload: structuredClone(selected.payload),
    redundancy: other !== undefined
      && other.envelope.operationId === selected.envelope.operationId
      && other.envelope.authenticationFileSystemId === selected.envelope.authenticationFileSystemId
      && payloadSemanticallyEquals({ left: other.payload, right: selected.payload })
      ? 'converged'
      : 'degraded',
  };
}

export async function openTransitionProgress({ operationId, physical, proofAuthority }: {
  operationId: TransitionOperationId;
  physical: TransitionProgressReadablePhysicalPort;
  proofAuthority: TransitionProgressProofAuthority;
}): Promise<SelectedTransitionProgressAuthority | undefined> {
  const selected = selectTransitionProgressAuthority({ candidates: await readTransitionProgressCandidates({ physical, proofAuthority }) });
  if (selected !== undefined && selected.envelope.operationId !== operationId) {
    throw new TransitionProgressSelectionError({ code: 'operation_mismatch', message: 'transition-progress authority belongs to another operation' });
  }
  return selected;
}

function planPublication({ candidates, selected }: {
  candidates: readonly [TransitionProgressCandidate, TransitionProgressCandidate];
  selected: SelectedTransitionProgressAuthority | undefined;
}): Readonly<{
  first: { copy: TransitionProgressCopy; sequence: number };
  second: { copy: TransitionProgressCopy; sequence: number };
}> {
  const floor = Math.max(...candidates.map(candidate => structuralSequence({ candidate }) ?? 0));
  if (floor > Number.MAX_SAFE_INTEGER - 2) throw new RangeError('transition-progress sequence is exhausted');
  const firstCopy: TransitionProgressCopy = selected === undefined ? 0 : selected.copy === 0 ? 1 : 0;
  return {
    first: { copy: firstCopy, sequence: floor + 1 },
    second: { copy: firstCopy === 0 ? 1 : 0, sequence: floor + 2 },
  };
}

async function verifyPublishedCopy({ copy, envelope, physical, proofAuthority }: {
  copy: TransitionProgressCopy;
  envelope: NaidanTransitionProgressEnvelopeV1;
  physical: TransitionProgressPhysicalPort;
  proofAuthority: TransitionProgressProofAuthority;
}): Promise<SelectedTransitionProgressAuthority> {
  const candidate = await classifyCandidate({
    bytes: await physical.readFileBounded({
      copy,
      maximumByteLength: NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.limits.companionJsonBytes,
    }),
    copy,
    proofAuthority,
  });
  if (candidate.state !== 'proof_valid'
    || candidate.envelope.sequence !== envelope.sequence
    || candidate.envelope.operationId !== envelope.operationId) {
    throw new Error(`transition-progress copy ${copy} failed proof-valid read-back`);
  }
  return { copy, envelope: candidate.envelope, payload: candidate.payload, redundancy: 'degraded' };
}

async function publishOne({ copy, operationId, payload, physical, proofAuthority, randomSource, rootKey, sequence }: {
  copy: TransitionProgressCopy;
  operationId: TransitionOperationId;
  payload: TransitionProgressPayloadV1;
  physical: TransitionProgressPhysicalPort;
  proofAuthority: TransitionProgressProofAuthority;
  randomSource: PersistenceControlRandomSource | undefined;
  rootKey: PersistenceControlRootKeyDerivationCapability;
  sequence: number;
}): Promise<SelectedTransitionProgressAuthority> {
  const envelope = await protectTransitionProgress({
    authenticationFileSystemId: transitionProgressAuthenticationFileSystemId({ sourceEndpoint: payload.sourceEndpoint, targetEndpoint: payload.targetEndpoint }),
    copy,
    operationId,
    payload,
    randomSource,
    rootKey,
    sequence,
  });
  let publicationFailure: unknown;
  try {
    await physical.publishWholeFileDurably({ bytes: encodeTransitionProgressEnvelope({ envelope }), copy });
  } catch (cause: unknown) {
    publicationFailure = cause;
  }
  try {
    return await verifyPublishedCopy({ copy, envelope, physical, proofAuthority });
  } catch (verificationFailure: unknown) {
    if (publicationFailure !== undefined) throw publicationFailure;
    throw verificationFailure;
  }
}

function requireResolvedTransitionProgressRootKey({ resolution, selected }: {
  resolution: TransitionProgressRootKeyResolution;
  selected: SelectedTransitionProgressAuthority | undefined;
}): PersistenceControlRootKeyDerivationCapability {
  switch (resolution.state) {
  case 'resolved': return resolution.rootKey;
  case 'unresolved':
    throw new TransitionProgressPublicationError({
      cause: undefined,
      code: 'protection_unresolved',
      committedAuthority: selected,
      message: 'cannot publish transition progress without its HizoFS root-key proof capability',
    });
  default: return resolution satisfies never;
  }
}

export async function publishTransitionProgress({ expectedJournalGeneration, operationId, payload, physical, proofAuthority, randomSource }: {
  expectedJournalGeneration: bigint | undefined;
  operationId: TransitionOperationId;
  payload: TransitionProgressPayloadV1;
  physical: TransitionProgressPhysicalPort;
  proofAuthority: TransitionProgressProofAuthority;
  randomSource: PersistenceControlRandomSource | undefined;
}): Promise<SelectedTransitionProgressAuthority> {
  return await physical.runExclusive({ operation: async () => {
    const candidates = await readTransitionProgressCandidates({ physical, proofAuthority });
    const selected = selectTransitionProgressAuthority({ candidates });
    if (selected !== undefined && selected.envelope.operationId !== operationId) {
      throw new TransitionProgressPublicationError({
        cause: undefined,
        code: 'generation_conflict',
        committedAuthority: selected,
        message: 'transition-progress authority belongs to another operation',
      });
    }
    const actualGeneration = selected?.payload.journalGeneration;
    if (actualGeneration !== expectedJournalGeneration) {
      throw new TransitionProgressPublicationError({
        cause: undefined,
        code: 'generation_conflict',
        committedAuthority: selected,
        message: 'transition-progress journal generation compare-and-swap failed',
      });
    }
    const expectedNextGeneration = (expectedJournalGeneration ?? -1n) + 1n;
    if (payload.journalGeneration !== expectedNextGeneration) {
      throw new TransitionProgressPublicationError({
        cause: undefined,
        code: 'generation_conflict',
        committedAuthority: selected,
        message: 'new transition-progress payload does not advance the journal generation exactly once',
      });
    }
    const authenticationFileSystemId = transitionProgressAuthenticationFileSystemId({ sourceEndpoint: payload.sourceEndpoint, targetEndpoint: payload.targetEndpoint });
    const resolution = await proofAuthority.resolveRootKey({ fileSystemId: authenticationFileSystemId });
    const rootKey = requireResolvedTransitionProgressRootKey({ resolution, selected });
    const plan = planPublication({ candidates, selected });
    let committed: SelectedTransitionProgressAuthority;
    try {
      committed = await publishOne({
        ...plan.first,
        operationId,
        payload,
        physical,
        proofAuthority,
        randomSource,
        rootKey,
      });
    } catch (cause: unknown) {
      throw new TransitionProgressPublicationError({
        cause,
        code: 'authority_commit_failed',
        committedAuthority: undefined,
        message: 'transition-progress authority commit failed',
      });
    }
    try {
      const converged = await publishOne({
        ...plan.second,
        operationId,
        payload,
        physical,
        proofAuthority,
        randomSource,
        rootKey,
      });
      return { ...converged, redundancy: 'converged' };
    } catch (cause: unknown) {
      throw new TransitionProgressPublicationError({
        cause,
        code: 'convergence_failed',
        committedAuthority: committed,
        message: 'transition-progress redundancy convergence failed after authority commit',
      });
    }
  } });
}

export async function clearTransitionProgress({ expectedJournalGeneration, operationId, physical, proofAuthority }: {
  expectedJournalGeneration: bigint;
  operationId: TransitionOperationId;
  physical: TransitionProgressPhysicalPort;
  proofAuthority: TransitionProgressProofAuthority;
}): Promise<void> {
  await physical.runExclusive({ operation: async () => {
    const selected = await openTransitionProgress({ operationId, physical, proofAuthority });
    if (selected === undefined) return;
    if (selected.payload.journalGeneration !== expectedJournalGeneration) {
      throw new TransitionProgressPublicationError({
        cause: undefined,
        code: 'generation_conflict',
        committedAuthority: selected,
        message: 'transition-progress clear generation compare-and-swap failed',
      });
    }
    const failures: unknown[] = [];
    for (const copy of [0, 1] as const) {
      try {
        await physical.removeFile({ copy });
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    const remaining = await readTransitionProgressCandidates({ physical, proofAuthority });
    if (remaining.some(candidate => candidate.state !== 'structurally_invalid')) {
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, 'transition-progress clear did not remove both fixed copies');
    }
  } });
}

export const TEST_ONLY = {
  transitionProgressAuthenticationFileSystemId,
  payloadSemanticallyEquals,
  selectTransitionProgressAuthority,
};
