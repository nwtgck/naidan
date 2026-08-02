import {
  HIZOFS_SUPERBLOCK_FILES,
  HIZOFS_V1_FORMAT_CONSTANTS,
  assertMutationSuperblockPublicationTransition,
  assertRelocationSuperblockPublicationTransition,
  assertUnlockFloorSuperblockPublicationTransition,
  authenticatedSuperblockCopiesByDescendingSequence,
  createPublicationSequence,
  createSuperblockHeader,
  decodeSuperblockHeader,
  decodeSuperblockPlaintext,
  encodeSuperblockHeader,
  encodeSuperblockPlaintext,
  maximumStructurallyObservedSuperblockPublicationSequence,
  resolveSuperblockPublicationAuthority,
  selectSuperblockAuthority,
  superblockFlagsForLogicalState,
  superblockLogicalStateFrom,
  superblockLogicalStatesSemanticallyEqual,
  superblockMutationPublicationFailureOutcome,
  superblockOpenedAuthoritiesSemanticallyEqual,
  superblockRelocationPublicationFailureOutcome,
  superblockRequiresUnsupportedFeatures,
  superblockUnlockFloorPublicationFailureOutcome,
  type AuthenticatedSuperblockCopy,
  type FeatureBits,
  type FileSystemId,
  type PublicationId,
  type PublicationSequence,
  type SuperblockHeaderV1,
  type SuperblockCopyReadResult,
  type SuperblockLogicalState,
  type SuperblockPlaintextV1,
  type OpenedSuperblockCopies,
  type SuperblockMutationPublicationFailureOutcome,
  type SuperblockPublicationPhase,
  type SuperblockRelocationPublicationFailureOutcome,
  type SuperblockUnlockFloorPublicationFailureOutcome,
} from "@/00-storage/service/hizofs/00-format";
import {
  authenticatedSuperblockBytes,
  decryptAuthenticatedSuperblock,
  encryptSuperblock,
  generatePublicationId,
  generateSuperblockNonce,
  isHizoFSCryptoAuthenticationError,
  plaintextSuperblockBytes,
  superblockNonce,
  type FileSystemRootKey,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
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

export type {
  HistoricalRootFeatureState,
  OpenedSuperblockCopies,
  SuperblockCopyState,
  SuperblockLogicalState,
  SuperblockMutationPublicationFailureOutcome,
  SuperblockRelocationPublicationFailureOutcome,
  SuperblockUnlockFloorPublicationFailureOutcome,
} from "@/00-storage/service/hizofs/00-format";

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

function isExpectedInvalidCopyFailure({ cause }: { cause: unknown }): boolean {
  if (cause instanceof RangeError || cause instanceof TypeError) return true;
  return isHizoFSCryptoAuthenticationError({ cause });
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
    if (isHizoFSCryptoAuthenticationError({ cause })) {
      return { kind: "invalid", structurallyObservedPublicationSequence };
    }
    throw cause;
  }

  try {
    const plaintext = decodeSuperblockPlaintext({ bytes: plaintextBytes, flags: header.flags });
    return {
      copy: {
        header,
        logicalState: superblockLogicalStateFrom({ header, plaintext }),
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

function assertSupportedFeatures({ logicalState, supportedFeatureBits }: {
  logicalState: SuperblockLogicalState;
  supportedFeatureBits: FeatureBits;
}): void {
  if (superblockRequiresUnsupportedFeatures({ logicalState, supportedFeatureBits })) {
    throw authenticatedStoreError({
      code: "unsupported_required_feature",
      message: "selected Superblock requires unsupported feature semantics",
    });
  }
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
  const selection = selectSuperblockAuthority({ results, supportedFeatureBits });
  switch (selection.type) {
  case "no_authenticated_copy":
    throw authenticatedStoreError({
      code: selection.allCopiesMissing ? "incomplete_container" : "control_plane_corrupt",
      message: selection.allCopiesMissing
        ? "no Superblock copy is available"
        : "no authenticated Superblock copy is available",
    });
  case "sequence_reuse_conflict":
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "two authenticated Superblock copies reuse one Publication Sequence",
    });
  case "unsupported_required_feature":
    throw authenticatedStoreError({
      code: "unsupported_required_feature",
      message: "selected Superblock requires unsupported feature semantics",
    });
  case "selected":
    return { copies: selection.copies, opened: selection.opened, results };
  default: return selection satisfies never;
  }
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
  const flags = superblockFlagsForLogicalState({ logicalState });
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
    || !superblockLogicalStatesSemanticallyEqual({ left: readBack.copy.logicalState, right: prepared.logicalState })) {
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
  const existing = authenticatedSuperblockCopiesByDescendingSequence({ results: initialResults });
  if (existing.some(copy => !superblockLogicalStatesSemanticallyEqual({ left: copy.logicalState, right: logicalState }))) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "existing Superblock state disagrees with the requested initial state",
    });
  }
  const usedNonces = existing.map(copy => Uint8Array.from(copy.header.nonce));
  const usedPublicationIds = existing.map(copy => copy.plaintext.publicationId);
  let maximumSequence = maximumStructurallyObservedSuperblockPublicationSequence({ results: initialResults });
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
  const finalSelection = selectSuperblockAuthority({ results: finalResults, supportedFeatureBits });
  switch (finalSelection.type) {
  case "no_authenticated_copy":
  case "sequence_reuse_conflict":
  case "unsupported_required_feature":
    throw new Error(`initial Superblock publication selection failed: ${finalSelection.type}`);
  case "selected": return finalSelection.opened;
  default: return finalSelection satisfies never;
  }
}

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

export class SuperblockRelocationPublicationError extends Error {
  readonly outcome: SuperblockRelocationPublicationFailureOutcome;

  constructor({ cause, outcome }: { cause: unknown; outcome: SuperblockRelocationPublicationFailureOutcome }) {
    super(`Superblock relocation publication failed: ${outcome}`, { cause });
    this.name = "SuperblockRelocationPublicationError";
    this.outcome = outcome;
  }
}

type SuperblockCopyPresence = "missing" | "present";

function superblockCopyPresence({ result }: {
  result: SuperblockCopyReadResult;
}): SuperblockCopyPresence {
  switch (result.kind) {
  case "missing": return "missing";
  case "invalid":
  case "valid": return "present";
  default: return result satisfies never;
  }
}

async function overwritePreparedSuperblockCopy({ backend, diagnostics, expectedPresence, fileSystemId, onWriteStarted, prepared, rootKey }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  expectedPresence: SuperblockCopyPresence;
  fileSystemId: FileSystemId;
  onWriteStarted: () => void;
  prepared: PreparedSuperblockCopy;
  rootKey: FileSystemRootKey;
}): Promise<AuthenticatedSuperblockCopy> {
  const path = superblockPath({ copy: prepared.copy });
  const created = expectedPresence === "missing";
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
  return {
    superblock: current,
    type: resolveSuperblockPublicationAuthority({ base, current, intendedLogicalState }),
  };
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
  if (!superblockOpenedAuthoritiesSemanticallyEqual({ left: base, right: current.opened })) {
    throw new SuperblockPublicationConflictError();
  }

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
      expectedPresence: superblockCopyPresence({ result: current.results[firstPrepared.copy] }),
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
      expectedPresence: superblockCopyPresence({ result: current.results[secondPrepared.copy] }),
      fileSystemId,
      onWriteStarted: () => undefined,
      prepared: secondPrepared,
      rootKey,
    });
    const converged = await readSuperblockSnapshot({ backend, diagnostics, fileSystemId, rootKey, supportedFeatureBits });
    if (converged.opened.copyState !== "normal"
      || !superblockLogicalStatesSemanticallyEqual({ left: converged.opened.logicalState, right: logicalState })
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
    assertTransition: assertMutationSuperblockPublicationTransition,
    backend,
    base,
    beforeFirstAuthorityWrite,
    createFailureError: ({ cause, phase }) => new SuperblockMutationPublicationError({
      cause,
      outcome: superblockMutationPublicationFailureOutcome({ phase }),
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
  return {
    superblock: current,
    type: resolveSuperblockPublicationAuthority({ base, current, intendedLogicalState }),
  };
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
    assertTransition: assertRelocationSuperblockPublicationTransition,
    backend,
    base,
    beforeFirstAuthorityWrite,
    createFailureError: ({ cause, phase }) => new SuperblockRelocationPublicationError({
      cause,
      outcome: superblockRelocationPublicationFailureOutcome({ phase }),
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



export class SuperblockUnlockFloorPublicationError extends Error {
  readonly outcome: SuperblockUnlockFloorPublicationFailureOutcome;

  constructor({ cause, outcome }: { cause: unknown; outcome: SuperblockUnlockFloorPublicationFailureOutcome }) {
    super(`Superblock minimum Unlock Sequence publication failed: ${outcome}`, { cause });
    this.name = "SuperblockUnlockFloorPublicationError";
    this.outcome = outcome;
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
  return {
    superblock: current,
    type: resolveSuperblockPublicationAuthority({ base, current, intendedLogicalState }),
  };
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
    assertTransition: assertUnlockFloorSuperblockPublicationTransition,
    backend,
    base,
    beforeFirstAuthorityWrite,
    createFailureError: ({ cause, phase }) => new SuperblockUnlockFloorPublicationError({
      cause,
      outcome: superblockUnlockFloorPublicationFailureOutcome({ phase }),
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
