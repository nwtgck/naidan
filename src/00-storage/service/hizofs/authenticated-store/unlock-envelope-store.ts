import {
  HIZOFS_UNLOCK_ENVELOPE_FILES,
  HIZOFS_V1_FORMAT_CONSTANTS,
  HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD,
  cloneCredentialSlot,
  createUnlockSequence,
  decodePassphraseCredentialParametersV1,
  decodeBase64UrlUnpadded,
  decodeUnlockEnvelope,
  encodeBase64UrlUnpadded,
  encodePassphraseCredentialParametersV1,
  encodeUnlockEnvelope,
  maximumStructurallyObservedUnlockSequence,
  parseFileSystemId,
  reserveNextUnlockEnvelopeSequence,
  selectAuthenticatedUnlockEnvelopeAuthority,
  unlockEnvelopeCredentialSetsSemanticallyEqual,
  unlockEnvelopesSemanticallyEqual,
  unlockEnvelopePublicationFailureOutcome,
  type AuthenticatedUnlockEnvelopeAuthority,
  type AuthenticatedUnlockEnvelopeCopy,
  type CredentialCopyState,
  type CredentialSlotId,
  type CredentialSlotV1,
  type FileSystemId,
  type UnlockEnvelopeV1,
  type UnlockEnvelopePublicationFailureOutcome,
  type UnlockEnvelopePublicationPhase,
  type UnlockSequence,
} from "@/00-storage/service/hizofs/00-format";
import {
  authenticatedWrappedRootKeyBytes,
  createUnlockAuthenticatorTag,
  generateCredentialSalt,
  generateCredentialSlotId,
  generateCredentialWrapNonce,
  generateFileSystemId,
  generateFileSystemRootKey,
  generateUnlockAuthenticatorNonce,
  isHizoFSCryptoAuthenticationError,
  unlockAuthenticatorNonce,
  unlockAuthenticatorTag,
  unwrapFileSystemRootKeyFromCredentialSlot,
  verifyUnlockAuthenticator,
  wrapFileSystemRootKeyForCredentialSlot,
  type FileSystemRootKey,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSWritableBackend, HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import { canonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";
import { authenticatedStoreError } from "./errors";
import {
  measureAuthenticatedCodecOperation,
  measureAuthenticatedCryptoOperation,
  type AuthenticatedStoreDiagnosticsPort,
} from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";
import {
  authenticatedHizoFSPhysicalBytes,
  type AuthenticatedHizoFSPhysicalBytes,
} from "./physical-bytes";
import {
  createAuthenticatedWholeFile,
  overwriteAuthenticatedWholeFile,
  readAuthenticatedWholeFile,
} from "./whole-file";

export type { AuthenticatedUnlockEnvelopeAuthority, CredentialCopyState } from "@/00-storage/service/hizofs/00-format";

export type CreatedInitialUnlockEnvelopeCredentialSet = Readonly<{
  credentialSlotIds: readonly CredentialSlotId[];
  fileSystemId: FileSystemId;
  rootKey: FileSystemRootKey;
  unlockSequence: UnlockSequence;
}>;

export type PreparedInitialUnlockEnvelopeCredentialSet = CreatedInitialUnlockEnvelopeCredentialSet & Readonly<{
  copyBytes: readonly [AuthenticatedHizoFSPhysicalBytes, AuthenticatedHizoFSPhysicalBytes];
}>;

export type CreatedInitialUnlockEnvelopeCopies = Readonly<{
  fileSystemId: FileSystemId;
  rootKey: FileSystemRootKey;
  unlockingSlotId: CredentialSlotId;
  unlockSequence: UnlockSequence;
}>;

export type PreparedInitialUnlockEnvelopeCopies = CreatedInitialUnlockEnvelopeCopies & Readonly<{
  copyBytes: readonly [AuthenticatedHizoFSPhysicalBytes, AuthenticatedHizoFSPhysicalBytes];
}>;

export type RetainedPassphraseCredentialProof = Readonly<{
  passphrase: string;
  sourceSlotId?: CredentialSlotId;
}>;

export type ProvenRetainedPassphraseCredential = Readonly<{
  passphrase: string;
  sourceSlotId: CredentialSlotId;
}>;

export type OpenedUnlockEnvelopeCopies = CreatedInitialUnlockEnvelopeCopies & Readonly<{
  copyState: CredentialCopyState;
}>;


export type { UnlockEnvelopePublicationFailureOutcome } from "@/00-storage/service/hizofs/00-format";

export class UnlockEnvelopePublicationError extends Error {
  public readonly expectedCredentialSlots?: readonly CredentialSlotV1[];
  public readonly expectedUnlockSequence?: UnlockSequence;
  public readonly outcome: UnlockEnvelopePublicationFailureOutcome;

  public constructor({ cause, expectedCredentialSlots, expectedUnlockSequence, outcome }: {
    cause: unknown;
    expectedCredentialSlots?: readonly CredentialSlotV1[];
    expectedUnlockSequence?: UnlockSequence;
    outcome: UnlockEnvelopePublicationFailureOutcome;
  }) {
    super(`Unlock Envelope publication failed: ${outcome}`, { cause });
    this.name = "UnlockEnvelopePublicationError";
    this.expectedCredentialSlots = expectedCredentialSlots?.map(slot => ({ ...slot }));
    this.expectedUnlockSequence = expectedUnlockSequence;
    this.outcome = outcome;
  }
}

type ParsedEnvelopeCopy = AuthenticatedUnlockEnvelopeCopy;

type SlotAttempt = Readonly<{
  envelope: UnlockEnvelopeV1;
  parameters: ReturnType<typeof decodePassphraseCredentialParametersV1>;
  slot: CredentialSlotV1;
}>;

function unlockPath({ copy }: { copy: 0 | 1 }) {
  return canonicalContainerPath({ value: HIZOFS_UNLOCK_ENVELOPE_FILES[copy] });
}

function slotAttemptKey({ envelope, slot }: {
  envelope: UnlockEnvelopeV1;
  slot: CredentialSlotV1;
}): string {
  return [
    envelope.fileSystemId,
    slot.slotId,
    slot.method,
    String(slot.methodVersion),
    slot.methodParameters,
    slot.wrappedFileSystemRootKey,
  ].join("\u0000");
}

function decodeMeasuredUnlockEnvelope({ bytes, diagnostics }: {
  bytes: Uint8Array;
  diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
}): UnlockEnvelopeV1 {
  return measureAuthenticatedCodecOperation({
    diagnostics,
    format: "envelope",
    operation: "decode",
    run: () => decodeUnlockEnvelope({ bytes }),
  });
}

function encodeMeasuredUnlockEnvelope({ diagnostics, envelope, includeAuthenticatorTag }: {
  diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  envelope: UnlockEnvelopeV1;
  includeAuthenticatorTag: boolean | undefined;
}): Uint8Array {
  return measureAuthenticatedCodecOperation({
    diagnostics,
    format: "envelope",
    operation: "encode",
    run: () => encodeUnlockEnvelope({ envelope, includeAuthenticatorTag }),
  });
}

async function verifyEnvelope({ diagnostics, envelope, rootKey }: {
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  envelope: UnlockEnvelopeV1;
  rootKey: FileSystemRootKey;
}): Promise<boolean> {
  try {
    await measureAuthenticatedCryptoOperation({
      diagnostics,
      operation: "decrypt",
      run: async () => await verifyUnlockAuthenticator({
        canonicalUnsignedEnvelopeBytes: encodeMeasuredUnlockEnvelope({
          diagnostics,
          envelope,
          includeAuthenticatorTag: false,
        }),
        copy: envelope.copy,
        fileSystemId: envelope.fileSystemId,
        nonce: unlockAuthenticatorNonce({
          bytes: decodeBase64UrlUnpadded({ maximumDecodedBytes: 12, value: envelope.authenticatorNonce }),
        }),
        rootKey,
        tag: unlockAuthenticatorTag({
          bytes: decodeBase64UrlUnpadded({ maximumDecodedBytes: 16, value: envelope.authenticatorTag }),
        }),
        unlockSequence: createUnlockSequence({ value: BigInt(envelope.sequence) }),
      }),
    });
    return true;
  } catch (cause: unknown) {
    if (isHizoFSCryptoAuthenticationError({ cause })) return false;
    throw cause;
  }
}

async function readStructuralCopies({ backend, diagnostics }: {
  backend: HizoFSReadableBackend;
  diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
}): Promise<readonly ParsedEnvelopeCopy[]> {
  const copies: ParsedEnvelopeCopy[] = [];
  for (const physicalCopy of [0, 1] as const) {
    const bytes = await readAuthenticatedWholeFile({
      backend,
      maximumByteLength: HIZOFS_V1_FORMAT_CONSTANTS.limits.unlockEnvelopeJsonBytes,
      path: unlockPath({ copy: physicalCopy }),
    });
    if (bytes === undefined) continue;
    try {
      const envelope = decodeMeasuredUnlockEnvelope({ bytes, diagnostics });
      if (envelope.copy !== physicalCopy) continue;
      copies.push({ envelope, physicalCopy });
    } catch (_cause: unknown) {
      // A malformed/torn sibling is not itself authority. A surviving authenticated
      // copy may still provide one-copy-loss recovery after the rollback floor check.
    }
  }
  return copies;
}

function buildSlotAttempts({ copies }: {
  copies: readonly ParsedEnvelopeCopy[];
}): readonly SlotAttempt[] {
  const attempts: SlotAttempt[] = [];
  const seen = new Set<string>();
  let totalIterations = 0;
  const ordered = [...copies].sort((left, right) => right.envelope.sequence - left.envelope.sequence);
  for (const { envelope } of ordered) {
    for (const slot of envelope.credentialSlots) {
      if (slot.method !== HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.id
        || slot.methodVersion !== HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.version) continue;
      const key = slotAttemptKey({ envelope, slot });
      if (seen.has(key)) continue;
      seen.add(key);
      const parameters = decodePassphraseCredentialParametersV1({
        bytes: decodeBase64UrlUnpadded({ maximumDecodedBytes: 32, value: slot.methodParameters }),
      });
      totalIterations += parameters.iterations;
      if (totalIterations > HIZOFS_V1_FORMAT_CONSTANTS.limits.credentialUnlockTotalIterations) {
        throw authenticatedStoreError({
          code: "credential_work_limit_exceeded",
          message: "Unlock Envelope candidates exceed the global PBKDF2 work bound",
        });
      }
      attempts.push({ envelope, parameters, slot });
    }
  }
  return attempts;
}

async function tryUnwrap({ attempt, diagnostics, passphrase }: {
  attempt: SlotAttempt;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  passphrase: string;
}): Promise<FileSystemRootKey | undefined> {
  try {
    return await measureAuthenticatedCryptoOperation({
      diagnostics,
      operation: "decrypt",
      run: async () => await unwrapFileSystemRootKeyFromCredentialSlot({
        fileSystemId: attempt.envelope.fileSystemId,
        parameters: attempt.parameters,
        passphrase,
        slotId: attempt.slot.slotId,
        wrappedRootKey: authenticatedWrappedRootKeyBytes({
          bytes: decodeBase64UrlUnpadded({
            maximumDecodedBytes: 48,
            value: attempt.slot.wrappedFileSystemRootKey,
          }),
        }),
      }),
    });
  } catch (cause: unknown) {
    if (isHizoFSCryptoAuthenticationError({ cause })) return undefined;
    throw cause;
  }
}

async function buildEnvelopeCopy({
  copy,
  credentialSlots,
  diagnostics,
  fileSystemId,
  randomSource,
  rootKey,
  unlockSequence,
}: {
  copy: 0 | 1;
  credentialSlots: readonly CredentialSlotV1[];
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
  unlockSequence: UnlockSequence;
}): Promise<AuthenticatedHizoFSPhysicalBytes> {
  const sequence = Number(unlockSequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError("Unlock Sequence cannot be represented as a positive safe JSON integer");
  }
  const nonce = generateUnlockAuthenticatorNonce({ randomSource });
  const unsignedEnvelope: UnlockEnvelopeV1 = {
    authenticatorNonce: encodeBase64UrlUnpadded({ bytes: nonce }),
    authenticatorTag: encodeBase64UrlUnpadded({ bytes: new Uint8Array(16) }),
    copy,
    credentialSlots: credentialSlots.map(slot => ({ ...slot })),
    fileSystemId,
    format: "hizofs-unlock",
    formatVersion: 1,
    sequence,
  };
  const tag = await measureAuthenticatedCryptoOperation({
    diagnostics,
    operation: "encrypt",
    run: async () => await createUnlockAuthenticatorTag({
      canonicalUnsignedEnvelopeBytes: encodeMeasuredUnlockEnvelope({
        diagnostics,
        envelope: unsignedEnvelope,
        includeAuthenticatorTag: false,
      }),
      copy,
      fileSystemId,
      nonce,
      rootKey,
      unlockSequence,
    }),
  });
  return authenticatedHizoFSPhysicalBytes({
    bytes: encodeMeasuredUnlockEnvelope({
      diagnostics,
      envelope: {
        ...unsignedEnvelope,
        authenticatorTag: encodeBase64UrlUnpadded({ bytes: tag }),
      },
      includeAuthenticatorTag: undefined,
    }),
  });
}

function validateInitialCredentialPassphrases({ passphrases }: {
  passphrases: readonly string[];
}): void {
  if (passphrases.length < 1) {
    throw new RangeError("initial credential set must contain at least one passphrase");
  }
  if (passphrases.length > HIZOFS_V1_FORMAT_CONSTANTS.limits.credentialSlots) {
    throw new RangeError("initial credential set exceeds the Credential Slot limit");
  }
  const uniquePassphrases = new Set<string>();
  for (const passphrase of passphrases) {
    if (uniquePassphrases.has(passphrase)) {
      throw new RangeError("initial credential set contains a duplicate passphrase");
    }
    uniquePassphrases.add(passphrase);
  }
}

async function createInitialPassphraseCredentialSlot({
  diagnostics,
  fileSystemId,
  passphrase,
  randomSource,
  rootKey,
  slotId,
}: {
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  passphrase: string;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
  slotId: CredentialSlotId;
}): Promise<CredentialSlotV1> {
  const parameters = {
    iterations: HIZOFS_V1_FORMAT_CONSTANTS.limits.credentialPbkdf2IterationsDefault,
    nonce: generateCredentialWrapNonce({ randomSource }),
    salt: generateCredentialSalt({ randomSource }),
  };
  return {
    method: HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.id,
    methodParameters: encodeBase64UrlUnpadded({
      bytes: encodePassphraseCredentialParametersV1({ parameters }),
    }),
    methodVersion: HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.version,
    slotId,
    type: "credential",
    wrappedFileSystemRootKey: encodeBase64UrlUnpadded({
      bytes: await measureAuthenticatedCryptoOperation({
        diagnostics,
        operation: "encrypt",
        run: async () => await wrapFileSystemRootKeyForCredentialSlot({
          fileSystemId,
          parameters,
          passphrase,
          rootKey,
          slotId,
        }),
      }),
    }),
  };
}

export async function prepareInitialUnlockEnvelopeCredentialSet({
  diagnostics,
  fileSystemId,
  passphrases,
  randomSource,
}: {
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId?: FileSystemId;
  passphrases: readonly string[];
  randomSource?: RandomByteSource;
}): Promise<PreparedInitialUnlockEnvelopeCredentialSet> {
  validateInitialCredentialPassphrases({ passphrases });
  const exactFileSystemId = fileSystemId === undefined
    ? await generateFileSystemId({ isUsed: async () => false, randomSource })
    : parseFileSystemId({ value: fileSystemId });
  const usedSlotIds = new Set<CredentialSlotId>();
  const generatedSlotIds: CredentialSlotId[] = [];
  for (const _passphrase of passphrases) {
    const slotId = await generateCredentialSlotId({
      isUsed: async ({ id }) => usedSlotIds.has(id),
      randomSource,
    });
    usedSlotIds.add(slotId);
    generatedSlotIds.push(slotId);
  }
  const rootKey = generateFileSystemRootKey({ randomSource });
  const unlockSequence = createUnlockSequence({ value: 1n });
  try {
    const credentialSlots: CredentialSlotV1[] = [];
    for (const [index, passphrase] of passphrases.entries()) {
      const slotId = generatedSlotIds[index];
      if (slotId === undefined) throw new Error("initial Credential Slot ID generation invariant failed");
      const slot = await createInitialPassphraseCredentialSlot({
        diagnostics,
        fileSystemId: exactFileSystemId,
        passphrase,
        randomSource,
        rootKey,
        slotId,
      });
      credentialSlots.push(slot);
    }
    const sortedCredentialSlots = sortCredentialSlots({ slots: credentialSlots });
    const copy0 = await buildEnvelopeCopy({
      copy: 0,
      credentialSlots: sortedCredentialSlots,
      diagnostics,
      fileSystemId: exactFileSystemId,
      randomSource,
      rootKey,
      unlockSequence,
    });
    const copy1 = await buildEnvelopeCopy({
      copy: 1,
      credentialSlots: sortedCredentialSlots,
      diagnostics,
      fileSystemId: exactFileSystemId,
      randomSource,
      rootKey,
      unlockSequence,
    });
    return {
      copyBytes: [copy0, copy1],
      credentialSlotIds: sortedCredentialSlots.map(slot => slot.slotId),
      fileSystemId: exactFileSystemId,
      rootKey,
      unlockSequence,
    };
  } catch (cause: unknown) {
    rootKey.destroy();
    throw cause;
  }
}

export async function prepareInitialUnlockEnvelopeCopies({ diagnostics, fileSystemId, passphrase, randomSource }: {
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId?: FileSystemId;
  passphrase: string;
  randomSource?: RandomByteSource;
}): Promise<PreparedInitialUnlockEnvelopeCopies> {
  const prepared = await prepareInitialUnlockEnvelopeCredentialSet({
    diagnostics,
    fileSystemId,
    passphrases: [passphrase],
    randomSource,
  });
  const unlockingSlotId = prepared.credentialSlotIds[0];
  if (unlockingSlotId === undefined) {
    prepared.rootKey.destroy();
    throw new Error("initial credential set did not create an unlocking Slot ID");
  }
  return {
    copyBytes: prepared.copyBytes,
    fileSystemId: prepared.fileSystemId,
    rootKey: prepared.rootKey,
    unlockingSlotId,
    unlockSequence: prepared.unlockSequence,
  };
}

export async function publishInitialUnlockEnvelopeCredentialSet({ backend, diagnostics, prepared }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  prepared: PreparedInitialUnlockEnvelopeCredentialSet;
}): Promise<CreatedInitialUnlockEnvelopeCredentialSet> {
  for (const copy of [0, 1] as const) {
    await createAuthenticatedWholeFile({
      backend,
      bytes: prepared.copyBytes[copy],
      path: unlockPath({ copy }),
    });
    const readBack = await readAuthenticatedWholeFile({
      backend,
      maximumByteLength: HIZOFS_V1_FORMAT_CONSTANTS.limits.unlockEnvelopeJsonBytes,
      path: unlockPath({ copy }),
    });
    if (readBack === undefined
      || !await verifyEnvelope({ diagnostics, envelope: decodeMeasuredUnlockEnvelope({ bytes: readBack, diagnostics }), rootKey: prepared.rootKey })) {
      throw authenticatedStoreError({
        code: "control_plane_corrupt",
        message: `Unlock Envelope copy ${copy} failed authenticated read-back`,
      });
    }
  }
  return {
    credentialSlotIds: [...prepared.credentialSlotIds],
    fileSystemId: prepared.fileSystemId,
    rootKey: prepared.rootKey,
    unlockSequence: prepared.unlockSequence,
  };
}

export async function publishInitialUnlockEnvelopeCopies({ backend, diagnostics, prepared }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  prepared: PreparedInitialUnlockEnvelopeCopies;
}): Promise<CreatedInitialUnlockEnvelopeCopies> {
  const published = await publishInitialUnlockEnvelopeCredentialSet({
    backend,
    diagnostics,
    prepared: {
      copyBytes: prepared.copyBytes,
      credentialSlotIds: [prepared.unlockingSlotId],
      fileSystemId: prepared.fileSystemId,
      rootKey: prepared.rootKey,
      unlockSequence: prepared.unlockSequence,
    },
  });
  return {
    fileSystemId: published.fileSystemId,
    rootKey: published.rootKey,
    unlockingSlotId: prepared.unlockingSlotId,
    unlockSequence: published.unlockSequence,
  };
}

export async function createInitialUnlockEnvelopeCopies({ backend, diagnostics, passphrase, randomSource }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  passphrase: string;
  randomSource?: RandomByteSource;
}): Promise<CreatedInitialUnlockEnvelopeCopies> {
  const prepared = await prepareInitialUnlockEnvelopeCopies({ diagnostics, passphrase, randomSource });
  try {
    return await publishInitialUnlockEnvelopeCopies({ backend, diagnostics, prepared });
  } catch (cause: unknown) {
    prepared.rootKey.destroy();
    throw cause;
  }
}

export async function openUnlockEnvelopeCopies({ backend, diagnostics, minimumUnlockSequence, passphrase }: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  minimumUnlockSequence: UnlockSequence;
  passphrase: string;
}): Promise<OpenedUnlockEnvelopeCopies> {
  const copies = await readStructuralCopies({ backend, diagnostics });
  if (copies.length === 0) {
    throw authenticatedStoreError({
      code: "incomplete_container",
      message: "no structurally valid Unlock Envelope copy is available",
    });
  }

  const attempts = buildSlotAttempts({ copies });
  for (const attempt of attempts) {
    const rootKey = await tryUnwrap({ attempt, diagnostics, passphrase });
    if (rootKey === undefined) continue;
    try {
      const sameFileSystemCopies = copies.filter(({ envelope }) => envelope.fileSystemId === attempt.envelope.fileSystemId);
      const authenticated: ParsedEnvelopeCopy[] = [];
      for (const candidate of sameFileSystemCopies) {
        if (await verifyEnvelope({ diagnostics, envelope: candidate.envelope, rootKey })) authenticated.push(candidate);
      }
      const selection = selectAuthenticatedUnlockEnvelopeAuthority({
        authenticatedCopies: authenticated,
        minimumUnlockSequence,
        requiredCredentialSlot: attempt.slot,
      });
      switch (selection.type) {
      case "credential_rolled_back":
      case "no_eligible_authority":
        rootKey.destroy();
        continue;
      case "sequence_reuse_conflict":
        throw authenticatedStoreError({
          code: "control_plane_corrupt",
          message: "authenticated same-sequence Unlock Envelope copies disagree semantically",
        });
      case "selected":
        return {
          copyState: selection.copyState,
          fileSystemId: selection.envelope.fileSystemId,
          rootKey,
          unlockingSlotId: attempt.slot.slotId,
          unlockSequence: createUnlockSequence({ value: BigInt(selection.envelope.sequence) }),
        };
      default: return selection satisfies never;
      }
    } catch (cause: unknown) {
      rootKey.destroy();
      throw cause;
    }
  }

  throw authenticatedStoreError({
    code: "credential_rejected",
    message: "passphrase does not unlock the authoritative credential set",
  });
}


export async function openAuthenticatedUnlockEnvelopeAuthority({
  backend,
  diagnostics,
  fileSystemId,
  minimumUnlockSequence,
  rootKey,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  minimumUnlockSequence: UnlockSequence;
  rootKey: FileSystemRootKey;
}): Promise<AuthenticatedUnlockEnvelopeAuthority> {
  const copies = await readStructuralCopies({ backend, diagnostics });
  if (copies.length === 0) {
    throw authenticatedStoreError({
      code: "incomplete_container",
      message: "no structurally valid Unlock Envelope copy is available",
    });
  }
  const authenticated: ParsedEnvelopeCopy[] = [];
  for (const candidate of copies) {
    if (candidate.envelope.fileSystemId === fileSystemId
      && await verifyEnvelope({ diagnostics, envelope: candidate.envelope, rootKey })) {
      authenticated.push(candidate);
    }
  }
  const selection = selectAuthenticatedUnlockEnvelopeAuthority({
    authenticatedCopies: authenticated,
    minimumUnlockSequence,
    requiredCredentialSlot: undefined,
  });
  switch (selection.type) {
  case "no_eligible_authority":
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "no authenticated Unlock Envelope satisfies the Superblock rollback floor",
    });
  case "sequence_reuse_conflict":
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "authenticated same-sequence Unlock Envelope copies disagree semantically",
    });
  case "credential_rolled_back":
    throw new Error("credential rollback selection requires a credential slot");
  case "selected": {
    const envelope = selection.envelope;
    return {
      copyState: selection.copyState,
      credentialSlots: envelope.credentialSlots,
      envelope,
      fileSystemId,
      maximumStructurallyObservedUnlockSequence: maximumStructurallyObservedUnlockSequence({ copies }),
      minimumUnlockSequence,
      selectedPhysicalCopy: selection.selectedPhysicalCopy,
      unlockSequence: createUnlockSequence({ value: BigInt(envelope.sequence) }),
    };
  }
  default: return selection satisfies never;
  }
}

async function readBackPublishedEnvelope({
  backend,
  diagnostics,
  expected,
  physicalCopy,
  rootKey,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  expected: UnlockEnvelopeV1;
  physicalCopy: 0 | 1;
  rootKey: FileSystemRootKey;
}): Promise<void> {
  const bytes = await readAuthenticatedWholeFile({
    backend,
    maximumByteLength: HIZOFS_V1_FORMAT_CONSTANTS.limits.unlockEnvelopeJsonBytes,
    path: unlockPath({ copy: physicalCopy }),
  });
  if (bytes === undefined) throw new Error(`Unlock Envelope copy ${physicalCopy} disappeared after durable publication`);
  const actual = decodeMeasuredUnlockEnvelope({ bytes, diagnostics });
  if (actual.copy !== physicalCopy
    || !unlockEnvelopesSemanticallyEqual({ left: expected, right: actual })
    || !await verifyEnvelope({ diagnostics, envelope: actual, rootKey })) {
    throw new Error(`Unlock Envelope copy ${physicalCopy} failed authenticated semantic read-back`);
  }
}

export async function publishUnlockEnvelopeCredentialSet({
  authority,
  backend,
  beforeFirstAuthorityWrite,
  credentialSlots,
  diagnostics,
  randomSource,
  rootKey,
}: {
  authority: AuthenticatedUnlockEnvelopeAuthority;
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  beforeFirstAuthorityWrite?: () => void;
  credentialSlots: readonly CredentialSlotV1[];
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
}): Promise<AuthenticatedUnlockEnvelopeAuthority> {
  let expectedUnlockSequence: UnlockSequence | undefined;
  let phase: UnlockEnvelopePublicationPhase = "prepared";
  try {
    const unlockSequence = reserveNextUnlockEnvelopeSequence({
      maximumStructurallyObservedUnlockSequence: authority.maximumStructurallyObservedUnlockSequence,
      minimumUnlockSequence: authority.minimumUnlockSequence,
      unlockSequence: authority.unlockSequence,
    });
    expectedUnlockSequence = unlockSequence;
    const copy0 = await buildEnvelopeCopy({
      copy: 0,
      credentialSlots,
      diagnostics,
      fileSystemId: authority.fileSystemId,
      randomSource,
      rootKey,
      unlockSequence,
    });
    const copy1 = await buildEnvelopeCopy({
      copy: 1,
      credentialSlots,
      diagnostics,
      fileSystemId: authority.fileSystemId,
      randomSource,
      rootKey,
      unlockSequence,
    });
    const copyBytes = [copy0, copy1] as const;
    const expected = copyBytes.map(bytes => decodeMeasuredUnlockEnvelope({
      bytes,
      diagnostics,
    })) as [UnlockEnvelopeV1, UnlockEnvelopeV1];
    const firstCopy = authority.selectedPhysicalCopy === 0 ? 1 : 0;
    const secondCopy = authority.selectedPhysicalCopy;

    beforeFirstAuthorityWrite?.();
    phase = "first_write_started";
    await overwriteAuthenticatedWholeFile({ backend, bytes: copyBytes[firstCopy], path: unlockPath({ copy: firstCopy }) });
    await readBackPublishedEnvelope({ backend, diagnostics, expected: expected[firstCopy], physicalCopy: firstCopy, rootKey });
    phase = "first_authority_verified";

    await overwriteAuthenticatedWholeFile({ backend, bytes: copyBytes[secondCopy], path: unlockPath({ copy: secondCopy }) });
    await readBackPublishedEnvelope({ backend, diagnostics, expected: expected[secondCopy], physicalCopy: secondCopy, rootKey });
    phase = "second_copy_converged";

    const published = await openAuthenticatedUnlockEnvelopeAuthority({
      backend,
      diagnostics,
      fileSystemId: authority.fileSystemId,
      minimumUnlockSequence: unlockSequence,
      rootKey,
    });
    if (published.copyState !== "normal"
      || published.unlockSequence !== unlockSequence
      || !unlockEnvelopeCredentialSetsSemanticallyEqual({ left: credentialSlots, right: published.credentialSlots })) {
      throw new Error("published Unlock Envelope copies did not converge to the intended credential generation");
    }
    return published;
  } catch (cause: unknown) {
    switch (phase) {
    case "prepared":
    case "first_write_started":
    case "first_authority_verified":
      throw new UnlockEnvelopePublicationError({
        cause,
        expectedCredentialSlots: expectedUnlockSequence === undefined ? undefined : credentialSlots,
        expectedUnlockSequence,
        outcome: unlockEnvelopePublicationFailureOutcome({ phase }),
      });
    case "second_copy_converged": throw cause;
    default: return phase satisfies never;
    }
  }
}

export type UnlockEnvelopePublicationResolution =
  | Readonly<{ authority: AuthenticatedUnlockEnvelopeAuthority; type: "not_published" }>
  | Readonly<{ authority: AuthenticatedUnlockEnvelopeAuthority; type: "publication_conflict" }>
  | Readonly<{ authority: AuthenticatedUnlockEnvelopeAuthority; type: "published" }>;

export async function resolveUnlockEnvelopePublication({
  backend,
  diagnostics,
  expectedCredentialSlots,
  expectedUnlockSequence,
  previousAuthority,
  rootKey,
}: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  expectedCredentialSlots: readonly CredentialSlotV1[];
  expectedUnlockSequence: UnlockSequence;
  previousAuthority: AuthenticatedUnlockEnvelopeAuthority;
  rootKey: FileSystemRootKey;
}): Promise<UnlockEnvelopePublicationResolution> {
  const current = await openAuthenticatedUnlockEnvelopeAuthority({
    backend,
    diagnostics,
    fileSystemId: previousAuthority.fileSystemId,
    minimumUnlockSequence: previousAuthority.minimumUnlockSequence,
    rootKey,
  });
  if (current.unlockSequence === expectedUnlockSequence
    && unlockEnvelopeCredentialSetsSemanticallyEqual({ left: current.credentialSlots, right: expectedCredentialSlots })) {
    return { authority: current, type: "published" };
  }
  if (current.unlockSequence === previousAuthority.unlockSequence
    && unlockEnvelopeCredentialSetsSemanticallyEqual({ left: current.credentialSlots, right: previousAuthority.credentialSlots })) {
    return { authority: current, type: "not_published" };
  }
  return { authority: current, type: "publication_conflict" };
}

async function matchingPassphraseSlotIds({ authority, diagnostics, passphrase }: {
  authority: AuthenticatedUnlockEnvelopeAuthority;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  passphrase: string;
}): Promise<readonly CredentialSlotId[]> {
  const attempts = buildSlotAttempts({
    copies: [{ envelope: authority.envelope, physicalCopy: authority.selectedPhysicalCopy }],
  });
  const matches: CredentialSlotId[] = [];
  for (const attempt of attempts) {
    const candidateRootKey = await tryUnwrap({ attempt, diagnostics, passphrase });
    if (candidateRootKey === undefined) continue;
    try {
      if (await verifyEnvelope({ diagnostics, envelope: authority.envelope, rootKey: candidateRootKey })) {
        matches.push(attempt.slot.slotId);
      }
    } finally {
      candidateRootKey.destroy();
    }
  }
  return matches;
}

function sortCredentialSlots({ slots }: {
  slots: readonly CredentialSlotV1[];
}): readonly CredentialSlotV1[] {
  return [...slots].sort((left, right) => left.slotId < right.slotId ? -1 : left.slotId > right.slotId ? 1 : 0);
}

async function createFreshPassphraseCredentialSlot({
  authority,
  diagnostics,
  passphrase,
  randomSource,
  rootKey,
}: {
  authority: AuthenticatedUnlockEnvelopeAuthority;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  passphrase: string;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
}): Promise<CredentialSlotV1> {
  const usedSlotIds = new Set(authority.credentialSlots.map(slot => slot.slotId));
  const slotId = await generateCredentialSlotId({
    isUsed: async ({ id }) => usedSlotIds.has(id),
    randomSource,
  });
  const parameters = {
    iterations: HIZOFS_V1_FORMAT_CONSTANTS.limits.credentialPbkdf2IterationsDefault,
    nonce: generateCredentialWrapNonce({ randomSource }),
    salt: generateCredentialSalt({ randomSource }),
  };
  const slot: CredentialSlotV1 = {
    method: HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.id,
    methodParameters: encodeBase64UrlUnpadded({
      bytes: encodePassphraseCredentialParametersV1({ parameters }),
    }),
    methodVersion: HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.version,
    slotId,
    type: "credential",
    wrappedFileSystemRootKey: encodeBase64UrlUnpadded({
      bytes: await measureAuthenticatedCryptoOperation({
        diagnostics,
        operation: "encrypt",
        run: async () => await wrapFileSystemRootKeyForCredentialSlot({
          fileSystemId: authority.fileSystemId,
          parameters,
          passphrase,
          rootKey,
          slotId,
        }),
      }),
    }),
  };
  const selfTestRootKey = await tryUnwrap({
    attempt: { envelope: authority.envelope, parameters, slot },
    diagnostics,
    passphrase,
  });
  if (selfTestRootKey === undefined) throw new Error("fresh Credential Slot failed its unwrap self-test");
  try {
    if (!await verifyEnvelope({ diagnostics, envelope: authority.envelope, rootKey: selfTestRootKey })) {
      throw new Error("fresh Credential Slot did not recover the current File System Root Key");
    }
  } finally {
    selfTestRootKey.destroy();
  }
  return slot;
}

function selectProvenCredentialSlotId({ matchingSlotIds, targetSlotId }: {
  matchingSlotIds: readonly CredentialSlotId[];
  targetSlotId?: CredentialSlotId;
}): CredentialSlotId {
  if (matchingSlotIds.length === 0) {
    throw authenticatedStoreError({
      code: "credential_rejected",
      message: "passphrase does not match an authoritative Credential Slot",
    });
  }
  if (targetSlotId === undefined) {
    if (matchingSlotIds.length !== 1) {
      throw new RangeError("passphrase matches multiple Credential Slots; an explicit Slot ID is required");
    }
    const onlyMatch = matchingSlotIds[0];
    if (onlyMatch === undefined) throw new Error("matching Credential Slot selection invariant failed");
    return onlyMatch;
  }
  if (!matchingSlotIds.includes(targetSlotId)) {
    throw authenticatedStoreError({
      code: "credential_rejected",
      message: "selected Credential Slot is not proven by the supplied passphrase",
    });
  }
  return targetSlotId;
}

export async function proveRetainedPassphraseCredentialSlots({
  authority,
  diagnostics,
  retainedCredentials,
}: {
  authority: AuthenticatedUnlockEnvelopeAuthority;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  retainedCredentials: readonly RetainedPassphraseCredentialProof[];
}): Promise<readonly ProvenRetainedPassphraseCredential[]> {
  if (retainedCredentials.length < 1) {
    throw new RangeError("retained credential set must contain at least one proof");
  }
  if (retainedCredentials.length > HIZOFS_V1_FORMAT_CONSTANTS.limits.credentialSlots) {
    throw new RangeError("retained credential set exceeds the Credential Slot limit");
  }
  const seenPassphrases = new Set<string>();
  const seenSlotIds = new Set<CredentialSlotId>();
  const proven: ProvenRetainedPassphraseCredential[] = [];
  for (const retainedCredential of retainedCredentials) {
    const { passphrase, sourceSlotId, ...unhandledRetainedCredential } = retainedCredential;
    unhandledRetainedCredential satisfies Record<PropertyKey, never>;
    if (seenPassphrases.has(passphrase)) {
      throw new RangeError("retained credential set contains a duplicate passphrase");
    }
    seenPassphrases.add(passphrase);
    const selectedSlotId = selectProvenCredentialSlotId({
      matchingSlotIds: await matchingPassphraseSlotIds({ authority, diagnostics, passphrase }),
      targetSlotId: sourceSlotId,
    });
    if (seenSlotIds.has(selectedSlotId)) {
      throw new RangeError("retained credential set proves the same source Credential Slot more than once");
    }
    seenSlotIds.add(selectedSlotId);
    proven.push({ passphrase, sourceSlotId: selectedSlotId });
  }
  return proven;
}


export async function prepareAddedPassphraseCredentialSlots({
  authority,
  diagnostics,
  passphrase,
  randomSource,
  rootKey,
}: {
  authority: AuthenticatedUnlockEnvelopeAuthority;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  passphrase: string;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
}): Promise<readonly CredentialSlotV1[]> {
  if (authority.credentialSlots.length >= HIZOFS_V1_FORMAT_CONSTANTS.limits.credentialSlots) {
    throw new RangeError("Credential Slot limit has been reached");
  }
  if ((await matchingPassphraseSlotIds({ authority, diagnostics, passphrase })).length > 0) {
    throw authenticatedStoreError({
      code: "credential_rejected",
      message: "passphrase already matches an authoritative Credential Slot",
    });
  }
  const slot = await createFreshPassphraseCredentialSlot({ authority, diagnostics, passphrase, randomSource, rootKey });
  return sortCredentialSlots({
    slots: [...authority.credentialSlots.map(current => cloneCredentialSlot({ slot: current })), slot],
  });
}

export async function prepareRemovedPassphraseCredentialSlots({
  authority,
  diagnostics,
  passphrase,
  retainedPassphrase,
  targetSlotId,
  unlockingSlotId,
}: {
  authority: AuthenticatedUnlockEnvelopeAuthority;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  passphrase: string;
  retainedPassphrase?: string;
  targetSlotId?: CredentialSlotId;
  unlockingSlotId: CredentialSlotId;
}): Promise<readonly CredentialSlotV1[]> {
  if (authority.credentialSlots.length <= 1) throw new RangeError("the final Credential Slot cannot be removed");
  if (!authority.credentialSlots.some(slot => slot.slotId === unlockingSlotId)) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "runtime unlocking Slot ID is absent from the authoritative credential set",
    });
  }
  const selectedSlotId = selectProvenCredentialSlotId({
    matchingSlotIds: await matchingPassphraseSlotIds({ authority, diagnostics, passphrase }),
    targetSlotId,
  });
  const retained = authority.credentialSlots
    .filter(slot => slot.slotId !== selectedSlotId)
    .map(slot => cloneCredentialSlot({ slot }));
  if (selectedSlotId === unlockingSlotId) {
    if (retainedPassphrase === undefined) {
      throw authenticatedStoreError({
        code: "credential_rejected",
        message: "removing the current unlocking slot requires a retained passphrase proof",
      });
    }
    const retainedMatches = await matchingPassphraseSlotIds({ authority, diagnostics, passphrase: retainedPassphrase });
    if (!retainedMatches.some(slotId => retained.some(slot => slot.slotId === slotId))) {
      throw authenticatedStoreError({
        code: "credential_rejected",
        message: "retained passphrase does not prove a remaining Credential Slot",
      });
    }
  }
  return retained;
}

export async function prepareReplacedAuthenticatedCredentialSlot({
  authority,
  diagnostics,
  randomSource,
  replacementPassphrase,
  rootKey,
  targetSlotId,
}: {
  authority: AuthenticatedUnlockEnvelopeAuthority;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  randomSource?: RandomByteSource;
  replacementPassphrase: string;
  rootKey: FileSystemRootKey;
  targetSlotId: CredentialSlotId;
}): Promise<Readonly<{
  credentialSlots: readonly CredentialSlotV1[];
  replacementSlotId: CredentialSlotId;
}>> {
  if (!authority.credentialSlots.some(slot => slot.slotId === targetSlotId)) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "authenticated unlocking Slot ID is absent from the authoritative credential set",
    });
  }
  const replacementMatches = await matchingPassphraseSlotIds({ authority, diagnostics, passphrase: replacementPassphrase });
  if (replacementMatches.some(slotId => slotId !== targetSlotId)) {
    throw authenticatedStoreError({
      code: "credential_rejected",
      message: "replacement passphrase already matches a retained Credential Slot",
    });
  }
  const replacement = await createFreshPassphraseCredentialSlot({
    authority,
    diagnostics,
    passphrase: replacementPassphrase,
    randomSource,
    rootKey,
  });
  return {
    credentialSlots: sortCredentialSlots({
      slots: [
        ...authority.credentialSlots
          .filter(slot => slot.slotId !== targetSlotId)
          .map(slot => cloneCredentialSlot({ slot })),
        replacement,
      ],
    }),
    replacementSlotId: replacement.slotId,
  };
}

export async function prepareReplacedPassphraseCredentialSlots({
  authority,
  currentPassphrase,
  diagnostics,
  randomSource,
  replacementPassphrase,
  rootKey,
  targetSlotId,
}: {
  authority: AuthenticatedUnlockEnvelopeAuthority;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  currentPassphrase: string;
  randomSource?: RandomByteSource;
  replacementPassphrase: string;
  rootKey: FileSystemRootKey;
  targetSlotId?: CredentialSlotId;
}): Promise<readonly CredentialSlotV1[]> {
  const selectedSlotId = selectProvenCredentialSlotId({
    matchingSlotIds: await matchingPassphraseSlotIds({ authority, diagnostics, passphrase: currentPassphrase }),
    targetSlotId,
  });
  const replacementMatches = await matchingPassphraseSlotIds({ authority, diagnostics, passphrase: replacementPassphrase });
  if (replacementMatches.some(slotId => slotId !== selectedSlotId)) {
    throw authenticatedStoreError({
      code: "credential_rejected",
      message: "replacement passphrase already matches a retained Credential Slot",
    });
  }
  const replacement = await createFreshPassphraseCredentialSlot({
    authority,
    diagnostics,
    passphrase: replacementPassphrase,
    randomSource,
    rootKey,
  });
  return sortCredentialSlots({
    slots: [
      ...authority.credentialSlots
        .filter(slot => slot.slotId !== selectedSlotId)
        .map(slot => cloneCredentialSlot({ slot })),
      replacement,
    ],
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
