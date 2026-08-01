import {
  HIZOFS_SUPERBLOCK_FILES,
  HIZOFS_V1_FORMAT_CONSTANTS,
  createPublicationSequence,
  createSuperblockHeader,
  decodeSuperblockHeader,
  decodeSuperblockPlaintext,
  encodeHomeRecordReference,
  encodeOptionalHomeRecordReference,
  encodeOptionalPhysicalRecordReference,
  encodeSuperblockHeader,
  encodeSuperblockPlaintext,
  type CommitSequence,
  type FeatureBits,
  type FileSystemId,
  type HomeRecordReference,
  type MutationId,
  type PhysicalRecordReference,
  type PublicationId,
  type PublicationSequence,
  type SuperblockHeaderV1,
  type SuperblockPlaintextV1,
  type UnlockSequence,
} from "@/00-storage/service/hizofs/00-format";
import {
  authenticatedSuperblockBytes,
  decryptAuthenticatedSuperblock,
  encryptSuperblock,
  generatePublicationId,
  generateSuperblockNonce,
  plaintextSuperblockBytes,
  superblockNonce,
  type FileSystemRootKey,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/crypto";
import type { HizoFSWritableBackend, HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import { canonicalContainerPath, parentContainerDirectory } from "@/00-storage/service/hizofs/physical-store/paths";
import { authenticatedStoreError } from "./errors";
import { runAndCloseAuthenticatedFile } from "./file-operation";
import {
  authenticatedHizoFSPhysicalBytes,
  type AuthenticatedHizoFSPhysicalBytes,
} from "./physical-bytes";
import {
  measureAuthenticatedCryptoOperation,
  type AuthenticatedStoreDiagnosticsPort,
} from "./runtime-diagnostics-port";
import {
  createAuthenticatedWholeFile,
  readAuthenticatedWholeFile,
} from "./whole-file";

export type SuperblockCopyState = "normal" | "superblock_redundancy_degraded";

export type SuperblockLogicalState = Readonly<{
  activeCommitHomeRef: HomeRecordReference;
  activeCommitSequence: CommitSequence;
  activeMutationId: MutationId;
  fallbackCommitHomeRef: HomeRecordReference | null;
  minimumUnlockSequence: UnlockSequence;
  relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  requiredFeatureBits: FeatureBits;
}>;

export type HistoricalRootFeatureState = "supported_or_absent" | "unsupported";

export type OpenedSuperblockCopies = Readonly<{
  authenticatedLogicalStates: readonly SuperblockLogicalState[];
  copyState: SuperblockCopyState;
  historicalRootFeatureState: HistoricalRootFeatureState;
  logicalState: SuperblockLogicalState;
  maximumStructurallyObservedPublicationSequence: PublicationSequence;
  selectedCopy: 0 | 1;
  selectedPublicationId: PublicationId;
  selectedPublicationSequence: PublicationSequence;
}>;

type AuthenticatedSuperblockCopy = Readonly<{
  header: SuperblockHeaderV1;
  logicalState: SuperblockLogicalState;
  physicalCopy: 0 | 1;
  plaintext: SuperblockPlaintextV1;
}>;

type SuperblockCopyReadResult =
  | Readonly<{ kind: "invalid"; structurallyObservedPublicationSequence?: PublicationSequence }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ copy: AuthenticatedSuperblockCopy; kind: "valid" }>;

function superblockPath({ copy }: { copy: 0 | 1 }) {
  return canonicalContainerPath({ value: HIZOFS_SUPERBLOCK_FILES[copy] });
}

function bytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function optionalBytesEqual({ left, right }: {
  left: Uint8Array;
  right: Uint8Array;
}): boolean {
  return bytesEqual({ left, right });
}

function logicalStateFrom({ header, plaintext }: {
  header: SuperblockHeaderV1;
  plaintext: SuperblockPlaintextV1;
}): SuperblockLogicalState {
  return {
    activeCommitHomeRef: plaintext.activeCommitHomeRef,
    activeCommitSequence: header.activeCommitSequence,
    activeMutationId: plaintext.activeMutationId,
    fallbackCommitHomeRef: plaintext.fallbackCommitHomeRef,
    minimumUnlockSequence: plaintext.minimumUnlockSequence,
    relocationIndexRootPhysicalRef: plaintext.relocationIndexRootPhysicalRef,
    requiredFeatureBits: plaintext.requiredFeatureBits,
  };
}

function sameLogicalState({ left, right }: {
  left: SuperblockLogicalState;
  right: SuperblockLogicalState;
}): boolean {
  return left.activeCommitSequence === right.activeCommitSequence
    && bytesEqual({
      left: encodeHomeRecordReference({ reference: left.activeCommitHomeRef }),
      right: encodeHomeRecordReference({ reference: right.activeCommitHomeRef }),
    })
    && bytesEqual({ left: left.activeMutationId, right: right.activeMutationId })
    && optionalBytesEqual({
      left: encodeOptionalHomeRecordReference({ reference: left.fallbackCommitHomeRef }),
      right: encodeOptionalHomeRecordReference({ reference: right.fallbackCommitHomeRef }),
    })
    && left.minimumUnlockSequence === right.minimumUnlockSequence
    && optionalBytesEqual({
      left: encodeOptionalPhysicalRecordReference({ reference: left.relocationIndexRootPhysicalRef }),
      right: encodeOptionalPhysicalRecordReference({ reference: right.relocationIndexRootPhysicalRef }),
    })
    && left.requiredFeatureBits === right.requiredFeatureBits;
}

function superblockFlags({ logicalState }: { logicalState: SuperblockLogicalState }): number {
  let flags = 0;
  if (logicalState.fallbackCommitHomeRef !== null) {
    flags |= HIZOFS_V1_FORMAT_CONSTANTS.flags.superblockFallbackCommitPresent;
  }
  if (logicalState.relocationIndexRootPhysicalRef !== null) {
    flags |= HIZOFS_V1_FORMAT_CONSTANTS.flags.superblockRelocationIndexRootPresent;
  }
  return flags;
}

function isExpectedInvalidCopyFailure({ cause }: { cause: unknown }): boolean {
  if (cause instanceof RangeError || cause instanceof TypeError) return true;
  return typeof cause === "object"
    && cause !== null
    && "name" in cause
    && (cause as { readonly name?: unknown }).name === "OperationError";
}

async function readSuperblockCopy({ backend, copy, diagnostics, fileSystemId, rootKey }: {
  backend: HizoFSReadableBackend;
  copy: 0 | 1;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  rootKey: FileSystemRootKey;
}): Promise<SuperblockCopyReadResult> {
  const bytes = await readAuthenticatedWholeFile({
    backend,
    maximumByteLength: HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockFile,
    path: superblockPath({ copy }),
  });
  if (bytes === undefined) return { kind: "missing" };
  if (bytes.byteLength !== HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockFile) return { kind: "invalid" };

  const headerSize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockHeader;
  const exactHeader = bytes.subarray(0, headerSize);
  let header: SuperblockHeaderV1;
  try {
    header = decodeSuperblockHeader({ bytes: exactHeader });
  } catch (cause: unknown) {
    if (isExpectedInvalidCopyFailure({ cause })) return { kind: "invalid" };
    throw cause;
  }
  if (header.copy !== copy || header.fileSystemId !== fileSystemId) return { kind: "invalid" };
  const structurallyObservedPublicationSequence = header.publicationSequence;

  let plaintextBytes: Uint8Array;
  try {
    plaintextBytes = await measureAuthenticatedCryptoOperation({
      diagnostics,
      operation: "decrypt",
      run: async () => await decryptAuthenticatedSuperblock({
        ciphertext: authenticatedSuperblockBytes({ bytes: bytes.subarray(headerSize) }),
        copy,
        exactHeader,
        fileSystemId,
        nonce: superblockNonce({ bytes: header.nonce }),
        publicationSequence: header.publicationSequence,
        rootKey,
      }),
    });
  } catch (cause: unknown) {
    if (typeof cause === "object"
      && cause !== null
      && "name" in cause
      && (cause as { readonly name?: unknown }).name === "OperationError") {
      return { kind: "invalid", structurallyObservedPublicationSequence };
    }
    throw cause;
  }

  try {
    const plaintext = decodeSuperblockPlaintext({ bytes: plaintextBytes, flags: header.flags });
    return {
      copy: {
        header,
        logicalState: logicalStateFrom({ header, plaintext }),
        physicalCopy: copy,
        plaintext,
      },
      kind: "valid",
    };
  } catch (cause: unknown) {
    if (isExpectedInvalidCopyFailure({ cause })) {
      return { kind: "invalid", structurallyObservedPublicationSequence };
    }
    throw cause;
  }
}

function maximumStructurallyObservedPublicationSequence({ results }: {
  results: readonly SuperblockCopyReadResult[];
}): bigint {
  let maximum = 0n;
  for (const result of results) {
    const observed = (() => {
      switch (result.kind) {
      case "valid": return result.copy.header.publicationSequence;
      case "invalid": return result.structurallyObservedPublicationSequence;
      case "missing": return undefined;
      default: {
        const exhaustive: never = result;
        throw new Error(`Unhandled Superblock copy result: ${((exhaustive satisfies never) as { readonly kind: string }).kind}`);
      }
      }
    })();
    if (observed !== undefined && observed > maximum) maximum = observed;
  }
  return maximum;
}

function selectAuthenticatedCopies({ results }: {
  results: readonly SuperblockCopyReadResult[];
}): readonly AuthenticatedSuperblockCopy[] {
  const copies: AuthenticatedSuperblockCopy[] = [];
  for (const result of results) {
    switch (result.kind) {
    case "invalid":
    case "missing":
      break;
    case "valid":
      copies.push(result.copy);
      break;
    default: {
      const exhaustive: never = result;
      throw new Error(`Unhandled Superblock copy result: ${((exhaustive satisfies never) as { readonly kind: string }).kind}`);
    }
    }
  }
  return copies.sort((left, right) => {
    if (left.header.publicationSequence === right.header.publicationSequence) return 0;
    return left.header.publicationSequence > right.header.publicationSequence ? -1 : 1;
  });
}

function requiresUnsupportedFeatures({ logicalState, supportedFeatureBits }: {
  logicalState: SuperblockLogicalState;
  supportedFeatureBits: FeatureBits;
}): boolean {
  return (logicalState.requiredFeatureBits & ~supportedFeatureBits) !== 0n;
}

function assertSupportedFeatures({ logicalState, supportedFeatureBits }: {
  logicalState: SuperblockLogicalState;
  supportedFeatureBits: FeatureBits;
}): void {
  if (requiresUnsupportedFeatures({ logicalState, supportedFeatureBits })) {
    throw authenticatedStoreError({
      code: "unsupported_required_feature",
      message: "selected Superblock requires unsupported feature semantics",
    });
  }
}

function openedFromValidCopies({ copies, maximumObservedSequence, supportedFeatureBits }: {
  copies: readonly AuthenticatedSuperblockCopy[];
  maximumObservedSequence: PublicationSequence;
  supportedFeatureBits: FeatureBits;
}): OpenedSuperblockCopies {
  const selected = copies[0];
  if (selected === undefined) throw new Error("authenticated Superblock selection invariant failed");
  const sameSequenceSibling = copies.find(copy => copy !== selected
    && copy.header.publicationSequence === selected.header.publicationSequence);
  if (sameSequenceSibling !== undefined) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "two authenticated Superblock copies reuse one Publication Sequence",
    });
  }
  assertSupportedFeatures({ logicalState: selected.logicalState, supportedFeatureBits });
  const sibling = copies[1];
  return {
    authenticatedLogicalStates: Object.freeze(copies.map(copy => copy.logicalState)),
    copyState: sibling !== undefined && sameLogicalState({ left: selected.logicalState, right: sibling.logicalState })
      ? "normal"
      : "superblock_redundancy_degraded",
    // A supported newest authority remains readable, but an authenticated older
    // root with unknown semantics must stay visible so maintenance cannot erase it.
    historicalRootFeatureState: sibling !== undefined
      && requiresUnsupportedFeatures({ logicalState: sibling.logicalState, supportedFeatureBits })
      ? "unsupported"
      : "supported_or_absent",
    logicalState: selected.logicalState,
    maximumStructurallyObservedPublicationSequence: maximumObservedSequence,
    selectedCopy: selected.physicalCopy,
    selectedPublicationId: selected.plaintext.publicationId,
    selectedPublicationSequence: selected.header.publicationSequence,
  };
}

async function readSuperblockSnapshot({ backend, diagnostics, fileSystemId, rootKey, supportedFeatureBits }: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  rootKey: FileSystemRootKey;
  supportedFeatureBits: FeatureBits;
}): Promise<Readonly<{
  copies: readonly AuthenticatedSuperblockCopy[];
  opened: OpenedSuperblockCopies;
  results: readonly SuperblockCopyReadResult[];
}>> {
  const results = await Promise.all(([0, 1] as const).map(async copy => await readSuperblockCopy({
    backend,
    copy,
    diagnostics,
    fileSystemId,
    rootKey,
  })));
  const copies = selectAuthenticatedCopies({ results });
  if (copies.length === 0) {
    const allMissing = results.every(result => result.kind === "missing");
    throw authenticatedStoreError({
      code: allMissing ? "incomplete_container" : "control_plane_corrupt",
      message: allMissing
        ? "no Superblock copy is available"
        : "no authenticated Superblock copy is available",
    });
  }
  const maximumObservedSequence = createPublicationSequence({
    value: maximumStructurallyObservedPublicationSequence({ results }),
  });
  return {
    copies,
    opened: openedFromValidCopies({ copies, maximumObservedSequence, supportedFeatureBits }),
    results,
  };
}

export async function openSuperblockCopies({ backend, diagnostics, fileSystemId, rootKey, supportedFeatureBits }: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  rootKey: FileSystemRootKey;
  supportedFeatureBits: FeatureBits;
}): Promise<OpenedSuperblockCopies> {
  return (await readSuperblockSnapshot({ backend, diagnostics, fileSystemId, rootKey, supportedFeatureBits })).opened;
}

function freshNonce({ randomSource, usedNonces }: {
  randomSource?: RandomByteSource;
  usedNonces: readonly Uint8Array[];
}) {
  for (let attempt = 0; attempt < HIZOFS_V1_FORMAT_CONSTANTS.limits.randomIdentityGenerationAttempts; attempt += 1) {
    const nonce = generateSuperblockNonce({ randomSource });
    if (!usedNonces.some(used => bytesEqual({ left: used, right: nonce }))) return nonce;
  }
  throw new Error("Superblock nonce generation exhausted the collision retry bound");
}

type PreparedSuperblockCopy = Readonly<{
  bytes: AuthenticatedHizoFSPhysicalBytes;
  copy: 0 | 1;
  logicalState: SuperblockLogicalState;
  publicationId: PublicationId;
  publicationSequence: PublicationSequence;
}>;

async function prepareSuperblockCopy({ copy, diagnostics, fileSystemId, logicalState, publicationSequence, randomSource, rootKey, usedNonces, usedPublicationIds }: {
  copy: 0 | 1;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  logicalState: SuperblockLogicalState;
  publicationSequence: PublicationSequence;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
  usedNonces: Uint8Array[];
  usedPublicationIds: PublicationId[];
}): Promise<PreparedSuperblockCopy> {
  const nonce = freshNonce({ randomSource, usedNonces });
  const publicationId = await generatePublicationId({
    isUsed: async ({ id }) => usedPublicationIds.some(used => bytesEqual({ left: used, right: id })),
    randomSource,
  });
  usedNonces.push(Uint8Array.from(nonce));
  usedPublicationIds.push(publicationId);
  const flags = superblockFlags({ logicalState });
  const header = createSuperblockHeader({
    activeCommitSequence: logicalState.activeCommitSequence,
    copy,
    fileSystemId,
    flags,
    nonce,
    publicationSequence,
  });
  const exactHeader = encodeSuperblockHeader({ header });
  const plaintext: SuperblockPlaintextV1 = {
    activeCommitHomeRef: logicalState.activeCommitHomeRef,
    activeMutationId: logicalState.activeMutationId,
    fallbackCommitHomeRef: logicalState.fallbackCommitHomeRef,
    minimumUnlockSequence: logicalState.minimumUnlockSequence,
    publicationId,
    relocationIndexRootPhysicalRef: logicalState.relocationIndexRootPhysicalRef,
    requiredFeatureBits: logicalState.requiredFeatureBits,
  };
  const encrypted = await measureAuthenticatedCryptoOperation({
    diagnostics,
    operation: "encrypt",
    run: async () => await encryptSuperblock({
      copy,
      exactHeader,
      fileSystemId,
      nonce,
      plaintext: plaintextSuperblockBytes({ bytes: encodeSuperblockPlaintext({ flags, plaintext }) }),
      publicationSequence,
      rootKey,
    }),
  });
  const bytes = new Uint8Array(exactHeader.byteLength + encrypted.byteLength);
  bytes.set(exactHeader, 0);
  bytes.set(encrypted, exactHeader.byteLength);
  return {
    bytes: authenticatedHizoFSPhysicalBytes({ bytes }),
    copy,
    logicalState,
    publicationId,
    publicationSequence,
  };
}

async function verifyPreparedSuperblockCopy({ backend, diagnostics, fileSystemId, prepared, rootKey }: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  prepared: PreparedSuperblockCopy;
  rootKey: FileSystemRootKey;
}): Promise<AuthenticatedSuperblockCopy> {
  const readBack = await readSuperblockCopy({ backend, copy: prepared.copy, diagnostics, fileSystemId, rootKey });
  if (readBack.kind !== "valid"
    || readBack.copy.header.publicationSequence !== prepared.publicationSequence
    || !bytesEqual({ left: readBack.copy.plaintext.publicationId, right: prepared.publicationId })
    || !sameLogicalState({ left: readBack.copy.logicalState, right: prepared.logicalState })) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: `Superblock copy ${prepared.copy} failed authenticated exact read-back`,
    });
  }
  return readBack.copy;
}

async function publishSuperblockCopy({
  backend,
  copy,
  diagnostics,
  fileSystemId,
  logicalState,
  publicationSequence,
  randomSource,
  rootKey,
  usedNonces,
  usedPublicationIds,
}: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  copy: 0 | 1;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  logicalState: SuperblockLogicalState;
  publicationSequence: PublicationSequence;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
  usedNonces: Uint8Array[];
  usedPublicationIds: PublicationId[];
}): Promise<AuthenticatedSuperblockCopy> {
  const prepared = await prepareSuperblockCopy({
    copy,
    diagnostics,
    fileSystemId,
    logicalState,
    publicationSequence,
    randomSource,
    rootKey,
    usedNonces,
    usedPublicationIds,
  });
  await createAuthenticatedWholeFile({
    backend,
    bytes: prepared.bytes,
    path: superblockPath({ copy }),
  });
  return await verifyPreparedSuperblockCopy({ backend, diagnostics, fileSystemId, prepared, rootKey });
}

export async function createInitialSuperblockCopies({ backend, diagnostics, fileSystemId, logicalState, randomSource, rootKey, supportedFeatureBits }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  logicalState: SuperblockLogicalState;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
  supportedFeatureBits: FeatureBits;
}): Promise<OpenedSuperblockCopies> {
  assertSupportedFeatures({ logicalState, supportedFeatureBits });
  if (logicalState.fallbackCommitHomeRef !== null) {
    throw new TypeError("initial Superblock publication must not contain a fallback Commit");
  }
  const initialResults = await Promise.all(([0, 1] as const).map(async copy => await readSuperblockCopy({
    backend,
    copy,
    diagnostics,
    fileSystemId,
    rootKey,
  })));
  if (initialResults.some(result => result.kind === "invalid")) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "initial Superblock bootstrap encountered a non-repairable invalid copy",
    });
  }
  const existing = selectAuthenticatedCopies({ results: initialResults });
  if (existing.some(copy => !sameLogicalState({ left: copy.logicalState, right: logicalState }))) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "existing Superblock state disagrees with the requested initial state",
    });
  }
  const usedNonces = existing.map(copy => Uint8Array.from(copy.header.nonce));
  const usedPublicationIds = existing.map(copy => copy.plaintext.publicationId);
  let maximumSequence = maximumStructurallyObservedPublicationSequence({ results: initialResults });
  const published = [...existing];
  for (const copy of [0, 1] as const) {
    const initialResult = initialResults[copy];
    if (initialResult === undefined) throw new Error("initial Superblock result index invariant failed");
    switch (initialResult.kind) {
    case "valid":
      continue;
    case "invalid":
      throw new Error("invalid initial Superblock result passed preflight");
    case "missing":
      break;
    default: {
      const exhaustive: never = initialResult;
      throw new Error(`Unhandled initial Superblock result: ${((exhaustive satisfies never) as { readonly kind: string }).kind}`);
    }
    }
    maximumSequence += 1n;
    published.push(await publishSuperblockCopy({
      backend,
      copy,
      diagnostics,
      fileSystemId,
      logicalState,
      publicationSequence: createPublicationSequence({ value: maximumSequence }),
      randomSource,
      rootKey,
      usedNonces,
      usedPublicationIds,
    }));
  }
  const finalResults = published.map(copy => ({ copy, kind: "valid" }) as const);
  const sorted = selectAuthenticatedCopies({ results: finalResults });
  return openedFromValidCopies({
    copies: sorted,
    maximumObservedSequence: createPublicationSequence({
      value: maximumStructurallyObservedPublicationSequence({ results: finalResults }),
    }),
    supportedFeatureBits,
  });
}

export type SuperblockMutationPublicationFailureOutcome =
  | "committed_redundancy_degraded"
  | "not_published"
  | "outcome_resolution_required";

export class SuperblockMutationPublicationError extends Error {
  readonly outcome: SuperblockMutationPublicationFailureOutcome;

  constructor({ cause, outcome }: { cause: unknown; outcome: SuperblockMutationPublicationFailureOutcome }) {
    super(`Superblock mutation publication failed: ${outcome}`, { cause });
    this.name = "SuperblockMutationPublicationError";
    this.outcome = outcome;
  }
}

export class SuperblockPublicationConflictError extends Error {
  readonly code = "publication_base_changed" as const;

  constructor() {
    super("authoritative Superblock changed after mutation preparation");
    this.name = "SuperblockPublicationConflictError";
  }
}

export type SuperblockRelocationPublicationFailureOutcome =
  | "not_published"
  | "outcome_resolution_required"
  | "published_redundancy_degraded";

export class SuperblockRelocationPublicationError extends Error {
  readonly outcome: SuperblockRelocationPublicationFailureOutcome;

  constructor({ cause, outcome }: { cause: unknown; outcome: SuperblockRelocationPublicationFailureOutcome }) {
    super(`Superblock relocation publication failed: ${outcome}`, { cause });
    this.name = "SuperblockRelocationPublicationError";
    this.outcome = outcome;
  }
}

type SuperblockPublicationPhase = "first_authority_verified" | "first_write_started" | "prepared" | "second_copy_converged";

function mutationPublicationFailureOutcome({ phase }: { phase: SuperblockPublicationPhase }): SuperblockMutationPublicationFailureOutcome {
  switch (phase) {
  case "prepared": return "not_published";
  case "first_write_started": return "outcome_resolution_required";
  case "first_authority_verified": return "committed_redundancy_degraded";
  case "second_copy_converged": throw new Error("converged publication cannot fail");
  default: return phase satisfies never;
  }
}

function assertMutationPublicationTransition({ base, firstPublicationSequence, logicalState, secondPublicationSequence }: {
  base: OpenedSuperblockCopies;
  firstPublicationSequence: PublicationSequence;
  logicalState: SuperblockLogicalState;
  secondPublicationSequence: PublicationSequence;
}): void {
  if (firstPublicationSequence !== base.maximumStructurallyObservedPublicationSequence + 1n
    || secondPublicationSequence !== base.maximumStructurallyObservedPublicationSequence + 2n) {
    throw new RangeError("reserved Publication Sequences must be exactly F + 1 and F + 2");
  }
  if (logicalState.activeCommitSequence !== base.logicalState.activeCommitSequence + 1n) {
    throw new RangeError("mutation Commit Sequence must be exactly base + 1");
  }
  if (logicalState.fallbackCommitHomeRef === null
    || !bytesEqual({
      left: encodeHomeRecordReference({ reference: logicalState.fallbackCommitHomeRef }),
      right: encodeHomeRecordReference({ reference: base.logicalState.activeCommitHomeRef }),
    })) {
    throw new TypeError("mutation fallback Commit must be the previous authoritative active Commit");
  }
  if (bytesEqual({ left: logicalState.activeMutationId, right: base.logicalState.activeMutationId })) {
    throw new TypeError("mutation publication requires a fresh Mutation ID");
  }
}

function sameOpenedAuthority({ left, right }: { left: OpenedSuperblockCopies; right: OpenedSuperblockCopies }): boolean {
  return left.selectedCopy === right.selectedCopy
    && left.historicalRootFeatureState === right.historicalRootFeatureState
    && left.selectedPublicationSequence === right.selectedPublicationSequence
    && bytesEqual({ left: left.selectedPublicationId, right: right.selectedPublicationId })
    && left.maximumStructurallyObservedPublicationSequence === right.maximumStructurallyObservedPublicationSequence
    && sameLogicalState({ left: left.logicalState, right: right.logicalState });
}

async function overwritePreparedSuperblockCopy({ backend, diagnostics, fileSystemId, onWriteStarted, prepared, rootKey }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  onWriteStarted: () => void;
  prepared: PreparedSuperblockCopy;
  rootKey: FileSystemRootKey;
}): Promise<AuthenticatedSuperblockCopy> {
  const path = superblockPath({ copy: prepared.copy });
  const existingSize = await backend.getFileSize({ path });
  const created = existingSize === undefined;
  const file = created
    ? await backend.createFileExclusive({ path })
    : await backend.openFileForUpdate({ path });
  await runAndCloseAuthenticatedFile({
    backend,
    file,
    operation: async () => {
      onWriteStarted();
      await backend.writeAt({ bytes: prepared.bytes, file, offset: 0n });
      await backend.truncate({ file, length: BigInt(prepared.bytes.byteLength) });
      await backend.syncFileData({ file });
    },
    operationLabel: "Superblock mutation publication",
  });
  if (created) {
    await backend.syncDirectoryEntries({ parent: parentContainerDirectory({ path }) });
  }
  return await verifyPreparedSuperblockCopy({ backend, diagnostics, fileSystemId, prepared, rootKey });
}

export type MutationSuperblockPublicationResolution =
  | Readonly<{ superblock: OpenedSuperblockCopies; type: "not_published" }>
  | Readonly<{ superblock: OpenedSuperblockCopies; type: "published" }>
  | Readonly<{ superblock: OpenedSuperblockCopies; type: "publication_conflict" }>;

export async function resolveMutationSuperblockPublication({
  backend,
  base,
  diagnostics,
  fileSystemId,
  intendedLogicalState,
  rootKey,
  supportedFeatureBits,
}: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  base: OpenedSuperblockCopies;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  intendedLogicalState: SuperblockLogicalState;
  rootKey: FileSystemRootKey;
  supportedFeatureBits: FeatureBits;
}): Promise<MutationSuperblockPublicationResolution> {
  const current = await openSuperblockCopies({
    backend,
    diagnostics,
    fileSystemId,
    rootKey,
    supportedFeatureBits,
  });
  if (sameLogicalState({ left: current.logicalState, right: intendedLogicalState })) {
    return { superblock: current, type: "published" };
  }
  if (sameOpenedAuthority({ left: base, right: current })) {
    return { superblock: current, type: "not_published" };
  }
  return { superblock: current, type: "publication_conflict" };
}

function sameLogicalStateExceptRelocation({ left, right }: {
  left: SuperblockLogicalState;
  right: SuperblockLogicalState;
}): boolean {
  return sameLogicalState({
    left,
    right: { ...right, relocationIndexRootPhysicalRef: left.relocationIndexRootPhysicalRef },
  });
}

function sameOptionalPhysicalReference({ left, right }: {
  left: PhysicalRecordReference | null;
  right: PhysicalRecordReference | null;
}): boolean {
  return optionalBytesEqual({
    left: encodeOptionalPhysicalRecordReference({ reference: left }),
    right: encodeOptionalPhysicalRecordReference({ reference: right }),
  });
}

function assertRelocationPublicationTransition({ base, firstPublicationSequence, logicalState, secondPublicationSequence }: {
  base: OpenedSuperblockCopies;
  firstPublicationSequence: PublicationSequence;
  logicalState: SuperblockLogicalState;
  secondPublicationSequence: PublicationSequence;
}): void {
  if (firstPublicationSequence !== base.maximumStructurallyObservedPublicationSequence + 1n
    || secondPublicationSequence !== base.maximumStructurallyObservedPublicationSequence + 2n) {
    throw new RangeError("reserved Publication Sequences must be exactly F + 1 and F + 2");
  }
  if (!sameLogicalStateExceptRelocation({ left: base.logicalState, right: logicalState })) {
    throw new TypeError("relocation publication must preserve Commit, Mutation, fallback, unlock, and feature authority");
  }
  if (sameOptionalPhysicalReference({
    left: base.logicalState.relocationIndexRootPhysicalRef,
    right: logicalState.relocationIndexRootPhysicalRef,
  })) {
    throw new TypeError("relocation publication must change the authoritative Relocation Index root");
  }
}

function relocationPublicationFailureOutcome({ phase }: {
  phase: SuperblockPublicationPhase;
}): SuperblockRelocationPublicationFailureOutcome {
  switch (phase) {
  case "prepared": return "not_published";
  case "first_write_started": return "outcome_resolution_required";
  case "first_authority_verified": return "published_redundancy_degraded";
  case "second_copy_converged": throw new Error("converged publication cannot fail");
  default: return phase satisfies never;
  }
}

async function publishSuperblockCopiesWithTransition({
  assertTransition,
  backend,
  base,
  beforeFirstAuthorityWrite,
  createFailureError,
  diagnostics,
  fileSystemId,
  firstPublicationSequence,
  logicalState,
  randomSource,
  rootKey,
  secondPublicationSequence,
  supportedFeatureBits,
}: {
  assertTransition: ({ base, firstPublicationSequence, logicalState, secondPublicationSequence }: {
    base: OpenedSuperblockCopies;
    firstPublicationSequence: PublicationSequence;
    logicalState: SuperblockLogicalState;
    secondPublicationSequence: PublicationSequence;
  }) => void;
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  base: OpenedSuperblockCopies;
  beforeFirstAuthorityWrite?: () => void;
  createFailureError: ({ cause, phase }: { cause: unknown; phase: SuperblockPublicationPhase }) => Error;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  firstPublicationSequence: PublicationSequence;
  logicalState: SuperblockLogicalState;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
  secondPublicationSequence: PublicationSequence;
  supportedFeatureBits: FeatureBits;
}): Promise<OpenedSuperblockCopies> {
  assertSupportedFeatures({ logicalState, supportedFeatureBits });
  assertTransition({ base, firstPublicationSequence, logicalState, secondPublicationSequence });
  const current = await readSuperblockSnapshot({ backend, diagnostics, fileSystemId, rootKey, supportedFeatureBits });
  if (!sameOpenedAuthority({ left: base, right: current.opened })) throw new SuperblockPublicationConflictError();

  const usedNonces = current.copies.map(copy => Uint8Array.from(copy.header.nonce));
  const usedPublicationIds = current.copies.map(copy => copy.plaintext.publicationId);
  const firstCopy = base.selectedCopy === 0 ? 1 : 0;
  const secondCopy = base.selectedCopy;
  const firstPrepared = await prepareSuperblockCopy({
    copy: firstCopy,
    diagnostics,
    fileSystemId,
    logicalState,
    publicationSequence: firstPublicationSequence,
    randomSource,
    rootKey,
    usedNonces,
    usedPublicationIds,
  });
  const secondPrepared = await prepareSuperblockCopy({
    copy: secondCopy,
    diagnostics,
    fileSystemId,
    logicalState,
    publicationSequence: secondPublicationSequence,
    randomSource,
    rootKey,
    usedNonces,
    usedPublicationIds,
  });

  let phase: SuperblockPublicationPhase = "prepared";
  try {
    beforeFirstAuthorityWrite?.();
    await overwritePreparedSuperblockCopy({
      backend,
      diagnostics,
      fileSystemId,
      onWriteStarted: () => {
        phase = "first_write_started";
      },
      prepared: firstPrepared,
      rootKey,
    });
    phase = "first_authority_verified";
    await overwritePreparedSuperblockCopy({
      backend,
      diagnostics,
      fileSystemId,
      onWriteStarted: () => undefined,
      prepared: secondPrepared,
      rootKey,
    });
    const converged = await readSuperblockSnapshot({ backend, diagnostics, fileSystemId, rootKey, supportedFeatureBits });
    if (converged.opened.copyState !== "normal"
      || !sameLogicalState({ left: converged.opened.logicalState, right: logicalState })
      || converged.opened.maximumStructurallyObservedPublicationSequence !== secondPublicationSequence) {
      throw authenticatedStoreError({
        code: "control_plane_corrupt",
        message: "Superblock copies did not converge to the published authority",
      });
    }
    phase = "second_copy_converged";
    return converged.opened;
  } catch (cause: unknown) {
    throw createFailureError({ cause, phase });
  }
}

export async function publishMutationSuperblockCopies({ backend, base, beforeFirstAuthorityWrite, diagnostics, fileSystemId, firstPublicationSequence, logicalState, randomSource, rootKey, secondPublicationSequence, supportedFeatureBits }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  base: OpenedSuperblockCopies;
  beforeFirstAuthorityWrite?: () => void;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  firstPublicationSequence: PublicationSequence;
  logicalState: SuperblockLogicalState;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
  secondPublicationSequence: PublicationSequence;
  supportedFeatureBits: FeatureBits;
}): Promise<OpenedSuperblockCopies> {
  return await publishSuperblockCopiesWithTransition({
    assertTransition: assertMutationPublicationTransition,
    backend,
    base,
    beforeFirstAuthorityWrite,
    createFailureError: ({ cause, phase }) => new SuperblockMutationPublicationError({
      cause,
      outcome: mutationPublicationFailureOutcome({ phase }),
    }),
    diagnostics,
    fileSystemId,
    firstPublicationSequence,
    logicalState,
    randomSource,
    rootKey,
    secondPublicationSequence,
    supportedFeatureBits,
  });
}

export type RelocationSuperblockPublicationResolution =
  | Readonly<{ superblock: OpenedSuperblockCopies; type: "not_published" }>
  | Readonly<{ superblock: OpenedSuperblockCopies; type: "publication_conflict" }>
  | Readonly<{ superblock: OpenedSuperblockCopies; type: "published" }>;

export async function resolveRelocationSuperblockPublication({
  backend,
  base,
  diagnostics,
  fileSystemId,
  intendedLogicalState,
  rootKey,
  supportedFeatureBits,
}: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  base: OpenedSuperblockCopies;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  intendedLogicalState: SuperblockLogicalState;
  rootKey: FileSystemRootKey;
  supportedFeatureBits: FeatureBits;
}): Promise<RelocationSuperblockPublicationResolution> {
  const current = await openSuperblockCopies({ backend, diagnostics, fileSystemId, rootKey, supportedFeatureBits });
  if (sameLogicalState({ left: current.logicalState, right: intendedLogicalState })) {
    return { superblock: current, type: "published" };
  }
  if (sameOpenedAuthority({ left: base, right: current })) {
    return { superblock: current, type: "not_published" };
  }
  return { superblock: current, type: "publication_conflict" };
}

export async function publishRelocationSuperblockCopies({ backend, base, beforeFirstAuthorityWrite, diagnostics, fileSystemId, firstPublicationSequence, logicalState, randomSource, rootKey, secondPublicationSequence, supportedFeatureBits }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  base: OpenedSuperblockCopies;
  beforeFirstAuthorityWrite?: () => void;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  firstPublicationSequence: PublicationSequence;
  logicalState: SuperblockLogicalState;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
  secondPublicationSequence: PublicationSequence;
  supportedFeatureBits: FeatureBits;
}): Promise<OpenedSuperblockCopies> {
  return await publishSuperblockCopiesWithTransition({
    assertTransition: assertRelocationPublicationTransition,
    backend,
    base,
    beforeFirstAuthorityWrite,
    createFailureError: ({ cause, phase }) => new SuperblockRelocationPublicationError({
      cause,
      outcome: relocationPublicationFailureOutcome({ phase }),
    }),
    diagnostics,
    fileSystemId,
    firstPublicationSequence,
    logicalState,
    randomSource,
    rootKey,
    secondPublicationSequence,
    supportedFeatureBits,
  });
}



export type SuperblockUnlockFloorPublicationFailureOutcome =
  | "not_published"
  | "outcome_resolution_required"
  | "published_redundancy_degraded";

export class SuperblockUnlockFloorPublicationError extends Error {
  readonly outcome: SuperblockUnlockFloorPublicationFailureOutcome;

  constructor({ cause, outcome }: { cause: unknown; outcome: SuperblockUnlockFloorPublicationFailureOutcome }) {
    super(`Superblock minimum Unlock Sequence publication failed: ${outcome}`, { cause });
    this.name = "SuperblockUnlockFloorPublicationError";
    this.outcome = outcome;
  }
}

function sameLogicalStateExceptMinimumUnlockSequence({ left, right }: {
  left: SuperblockLogicalState;
  right: SuperblockLogicalState;
}): boolean {
  return sameLogicalState({
    left,
    right: { ...right, minimumUnlockSequence: left.minimumUnlockSequence },
  });
}

function assertUnlockFloorPublicationTransition({ base, firstPublicationSequence, logicalState, secondPublicationSequence }: {
  base: OpenedSuperblockCopies;
  firstPublicationSequence: PublicationSequence;
  logicalState: SuperblockLogicalState;
  secondPublicationSequence: PublicationSequence;
}): void {
  if (firstPublicationSequence !== base.maximumStructurallyObservedPublicationSequence + 1n
    || secondPublicationSequence !== base.maximumStructurallyObservedPublicationSequence + 2n) {
    throw new RangeError("reserved Publication Sequences must be exactly F + 1 and F + 2");
  }
  if (!sameLogicalStateExceptMinimumUnlockSequence({ left: base.logicalState, right: logicalState })) {
    throw new TypeError("credential floor publication must preserve Commit, Mutation, fallback, relocation, and feature authority");
  }
  if (logicalState.minimumUnlockSequence <= base.logicalState.minimumUnlockSequence) {
    throw new RangeError("credential floor publication must strictly increase minimum Unlock Sequence");
  }
}

function unlockFloorPublicationFailureOutcome({ phase }: {
  phase: SuperblockPublicationPhase;
}): SuperblockUnlockFloorPublicationFailureOutcome {
  switch (phase) {
  case "prepared": return "not_published";
  case "first_write_started": return "outcome_resolution_required";
  case "first_authority_verified": return "published_redundancy_degraded";
  case "second_copy_converged": throw new Error("converged publication cannot fail");
  default: return phase satisfies never;
  }
}

export type UnlockFloorSuperblockPublicationResolution =
  | Readonly<{ superblock: OpenedSuperblockCopies; type: "not_published" }>
  | Readonly<{ superblock: OpenedSuperblockCopies; type: "publication_conflict" }>
  | Readonly<{ superblock: OpenedSuperblockCopies; type: "published" }>;

export async function resolveUnlockFloorSuperblockPublication({
  backend,
  base,
  diagnostics,
  fileSystemId,
  intendedLogicalState,
  rootKey,
  supportedFeatureBits,
}: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  base: OpenedSuperblockCopies;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  intendedLogicalState: SuperblockLogicalState;
  rootKey: FileSystemRootKey;
  supportedFeatureBits: FeatureBits;
}): Promise<UnlockFloorSuperblockPublicationResolution> {
  const current = await openSuperblockCopies({ backend, diagnostics, fileSystemId, rootKey, supportedFeatureBits });
  if (sameLogicalState({ left: current.logicalState, right: intendedLogicalState })) {
    return { superblock: current, type: "published" };
  }
  if (sameOpenedAuthority({ left: base, right: current })) {
    return { superblock: current, type: "not_published" };
  }
  return { superblock: current, type: "publication_conflict" };
}

export async function publishUnlockFloorSuperblockCopies({
  backend,
  base,
  beforeFirstAuthorityWrite,
  diagnostics,
  fileSystemId,
  firstPublicationSequence,
  logicalState,
  randomSource,
  rootKey,
  secondPublicationSequence,
  supportedFeatureBits,
}: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  base: OpenedSuperblockCopies;
  beforeFirstAuthorityWrite?: () => void;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  firstPublicationSequence: PublicationSequence;
  logicalState: SuperblockLogicalState;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
  secondPublicationSequence: PublicationSequence;
  supportedFeatureBits: FeatureBits;
}): Promise<OpenedSuperblockCopies> {
  return await publishSuperblockCopiesWithTransition({
    assertTransition: assertUnlockFloorPublicationTransition,
    backend,
    base,
    beforeFirstAuthorityWrite,
    createFailureError: ({ cause, phase }) => new SuperblockUnlockFloorPublicationError({
      cause,
      outcome: unlockFloorPublicationFailureOutcome({ phase }),
    }),
    diagnostics,
    fileSystemId,
    firstPublicationSequence,
    logicalState,
    randomSource,
    rootKey,
    secondPublicationSequence,
    supportedFeatureBits,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
