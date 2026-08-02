import {
  createPublicationSequence,
  createUnlockSequence,
  type CredentialSlotId,
  type CredentialSlotV1,
  type FeatureBits,
  type PublicationSequence,
  type UnlockSequence,
} from "@/00-storage/service/hizofs/00-format";
import type {
  FileSystemRootKey,
  RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSWritableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import type { AuthenticatedHizoFSPhysicalBytes } from "./physical-bytes";
import type { AuthenticatedStoreDiagnosticsPort } from "./runtime-diagnostics-port";
import {
  SuperblockUnlockFloorPublicationError,
  publishUnlockFloorSuperblockCopies,
  resolveUnlockFloorSuperblockPublication,
  type OpenedSuperblockCopies,
  type SuperblockLogicalState,
} from "./superblock-store";
import {
  UnlockEnvelopePublicationError,
  openAuthenticatedUnlockEnvelopeAuthority,
  prepareAddedPassphraseCredentialSlots,
  prepareRemovedPassphraseCredentialSlots,
  prepareReplacedAuthenticatedCredentialSlot,
  prepareReplacedPassphraseCredentialSlots,
  publishUnlockEnvelopeCredentialSet,
  resolveUnlockEnvelopePublication,
  type AuthenticatedUnlockEnvelopeAuthority,
  type UnlockEnvelopePublicationFailureOutcome,
} from "./unlock-envelope-store";

const UINT64_MAXIMUM = (1n << 64n) - 1n;

export type CredentialUpdateFailureStage = "superblock_floor" | "unlock_envelope";

export class CredentialUpdatePublicationError extends Error {
  public readonly credentialAuthority?: AuthenticatedUnlockEnvelopeAuthority;
  public readonly expectedCredentialSlots?: readonly CredentialSlotV1[];
  public readonly expectedLogicalState: SuperblockLogicalState;
  public readonly expectedUnlockSequence?: UnlockSequence;
  public readonly previousCredentialAuthority: AuthenticatedUnlockEnvelopeAuthority;
  public readonly previousSuperblock: OpenedSuperblockCopies;
  public readonly stage: CredentialUpdateFailureStage;
  public readonly stageOutcome: string;

  public constructor({
    cause,
    credentialAuthority,
    expectedCredentialSlots,
    expectedLogicalState,
    expectedUnlockSequence,
    previousCredentialAuthority,
    previousSuperblock,
    stage,
    stageOutcome,
  }: {
    cause: unknown;
    credentialAuthority?: AuthenticatedUnlockEnvelopeAuthority;
    expectedCredentialSlots?: readonly CredentialSlotV1[];
    expectedLogicalState: SuperblockLogicalState;
    expectedUnlockSequence?: UnlockSequence;
    previousCredentialAuthority: AuthenticatedUnlockEnvelopeAuthority;
    previousSuperblock: OpenedSuperblockCopies;
    stage: CredentialUpdateFailureStage;
    stageOutcome: string;
  }) {
    super(`Credential update failed during ${stage}: ${stageOutcome}`, { cause });
    this.name = "CredentialUpdatePublicationError";
    this.credentialAuthority = credentialAuthority;
    this.expectedCredentialSlots = expectedCredentialSlots?.map(slot => ({ ...slot }));
    this.expectedLogicalState = expectedLogicalState;
    this.expectedUnlockSequence = expectedUnlockSequence;
    this.previousCredentialAuthority = previousCredentialAuthority;
    this.previousSuperblock = previousSuperblock;
    this.stage = stage;
    this.stageOutcome = stageOutcome;
  }
}

export type CredentialUpdatePublicationResolution =
  | Readonly<{ credentialAuthority: AuthenticatedUnlockEnvelopeAuthority; superblock: OpenedSuperblockCopies; type: "credential_published_floor_pending" }>
  | Readonly<{ credentialAuthority: AuthenticatedUnlockEnvelopeAuthority; superblock: OpenedSuperblockCopies; type: "not_published" }>
  | Readonly<{ credentialAuthority: AuthenticatedUnlockEnvelopeAuthority; superblock: OpenedSuperblockCopies; type: "publication_conflict" }>
  | Readonly<{ credentialAuthority: AuthenticatedUnlockEnvelopeAuthority; superblock: OpenedSuperblockCopies; type: "published" }>
  | Readonly<{ credentialAuthority: AuthenticatedUnlockEnvelopeAuthority; superblock: OpenedSuperblockCopies; type: "published_redundancy_degraded" }>;

export async function resolveCredentialUpdatePublication({
  backend,
  diagnostics,
  failure,
  rootKey,
  supportedFeatureBits,
}: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  failure: CredentialUpdatePublicationError;
  rootKey: FileSystemRootKey;
  supportedFeatureBits: FeatureBits;
}): Promise<CredentialUpdatePublicationResolution> {
  if (failure.expectedCredentialSlots === undefined || failure.expectedUnlockSequence === undefined) {
    throw new TypeError("credential update failure does not contain a resolvable expected Unlock authority");
  }
  const unlockResolution = await resolveUnlockEnvelopePublication({
    backend,
    diagnostics,
    expectedCredentialSlots: failure.expectedCredentialSlots,
    expectedUnlockSequence: failure.expectedUnlockSequence,
    previousAuthority: failure.previousCredentialAuthority,
    rootKey,
  });
  const floorResolution = await resolveUnlockFloorSuperblockPublication({
    backend,
    diagnostics,
    base: failure.previousSuperblock,
    fileSystemId: failure.previousCredentialAuthority.fileSystemId,
    intendedLogicalState: failure.expectedLogicalState,
    rootKey,
    supportedFeatureBits,
  });
  if (unlockResolution.type === "publication_conflict" || floorResolution.type === "publication_conflict") {
    return { credentialAuthority: unlockResolution.authority, superblock: floorResolution.superblock, type: "publication_conflict" };
  }
  if (unlockResolution.type === "not_published" && floorResolution.type === "not_published") {
    return { credentialAuthority: unlockResolution.authority, superblock: floorResolution.superblock, type: "not_published" };
  }
  if (unlockResolution.type === "published" && floorResolution.type === "not_published") {
    return { credentialAuthority: unlockResolution.authority, superblock: floorResolution.superblock, type: "credential_published_floor_pending" };
  }
  if (unlockResolution.type === "published" && floorResolution.type === "published") {
    const converged = unlockResolution.authority.copyState === "normal"
      && floorResolution.superblock.copyState === "normal";
    return {
      credentialAuthority: unlockResolution.authority,
      superblock: floorResolution.superblock,
      type: converged ? "published" : "published_redundancy_degraded",
    };
  }
  return { credentialAuthority: unlockResolution.authority, superblock: floorResolution.superblock, type: "publication_conflict" };
}

export type PublishedCredentialUpdate = Readonly<{
  credentialAuthority: AuthenticatedUnlockEnvelopeAuthority;
  superblock: OpenedSuperblockCopies;
}>;

function reserveSuperblockFloorSequences({ base }: {
  base: OpenedSuperblockCopies;
}): readonly [PublicationSequence, PublicationSequence] {
  const maximum = base.maximumStructurallyObservedPublicationSequence;
  if (maximum > UINT64_MAXIMUM - 2n) {
    throw new RangeError("Superblock Publication Sequence space cannot reserve F + 1 and F + 2");
  }
  return [
    createPublicationSequence({ value: maximum + 1n }),
    createPublicationSequence({ value: maximum + 2n }),
  ];
}

function assertWritableCredentialUpdateBase({
  credentialAuthority,
  superblock,
}: {
  credentialAuthority: AuthenticatedUnlockEnvelopeAuthority;
  superblock: OpenedSuperblockCopies;
}): void {
  switch (credentialAuthority.copyState) {
  case "normal": break;
  case "credential_redundancy_degraded":
    throw new TypeError("credential update requires converged Unlock Envelope copies");
  default: return credentialAuthority.copyState satisfies never;
  }
  switch (superblock.copyState) {
  case "normal": break;
  case "superblock_redundancy_degraded":
    throw new TypeError("credential update requires converged Superblock copies");
  default: return superblock.copyState satisfies never;
  }
  if (credentialAuthority.minimumUnlockSequence !== superblock.logicalState.minimumUnlockSequence) {
    throw new TypeError("credential authority was not selected with the current Superblock rollback floor");
  }
  if (credentialAuthority.unlockSequence < superblock.logicalState.minimumUnlockSequence) {
    throw new TypeError("selected Unlock Envelope is below the Superblock rollback floor");
  }
}

function unlockFailureStageOutcome({ outcome }: {
  outcome: UnlockEnvelopePublicationFailureOutcome;
}): string {
  switch (outcome) {
  case "not_published": return "not_published";
  case "outcome_resolution_required": return "outcome_resolution_required";
  case "published_redundancy_degraded": return "credential_committed_redundancy_degraded";
  default: return outcome satisfies never;
  }
}

export async function publishCredentialUpdate({
  backend,
  beforeFirstAuthorityWrite,
  credentialAuthority,
  credentialSlots,
  diagnostics,
  randomSource,
  rootKey,
  superblock,
  supportedFeatureBits,
}: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  beforeFirstAuthorityWrite?: () => void;
  credentialAuthority: AuthenticatedUnlockEnvelopeAuthority;
  credentialSlots: readonly CredentialSlotV1[];
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
  superblock: OpenedSuperblockCopies;
  supportedFeatureBits: FeatureBits;
}): Promise<PublishedCredentialUpdate> {
  assertWritableCredentialUpdateBase({ credentialAuthority, superblock });
  const [firstPublicationSequence, secondPublicationSequence] = reserveSuperblockFloorSequences({ base: superblock });

  const intendedLogicalState = {
    ...superblock.logicalState,
    minimumUnlockSequence: createUnlockSequence({ value: credentialAuthority.maximumStructurallyObservedUnlockSequence + 1n }),
  };
  let publishedCredentialAuthority: AuthenticatedUnlockEnvelopeAuthority;
  try {
    publishedCredentialAuthority = await publishUnlockEnvelopeCredentialSet({
      authority: credentialAuthority,
      backend,
      beforeFirstAuthorityWrite,
      credentialSlots,
      diagnostics,
      randomSource,
      rootKey,
    });
  } catch (cause: unknown) {
    if (cause instanceof UnlockEnvelopePublicationError) {
      throw new CredentialUpdatePublicationError({
        cause,
        expectedCredentialSlots: cause.expectedCredentialSlots,
        expectedLogicalState: intendedLogicalState,
        expectedUnlockSequence: cause.expectedUnlockSequence,
        previousCredentialAuthority: credentialAuthority,
        previousSuperblock: superblock,
        stage: "unlock_envelope",
        stageOutcome: unlockFailureStageOutcome({ outcome: cause.outcome }),
      });
    }
    throw cause;
  }

  if (publishedCredentialAuthority.unlockSequence !== intendedLogicalState.minimumUnlockSequence) {
    throw new Error("published Unlock authority did not use the precomputed credential sequence");
  }
  let publishedSuperblock: OpenedSuperblockCopies;
  try {
    publishedSuperblock = await publishUnlockFloorSuperblockCopies({
      backend,
      base: superblock,
      diagnostics,
      fileSystemId: publishedCredentialAuthority.fileSystemId,
      firstPublicationSequence,
      logicalState: intendedLogicalState,
      randomSource,
      rootKey,
      secondPublicationSequence,
      supportedFeatureBits,
    });
  } catch (cause: unknown) {
    if (cause instanceof SuperblockUnlockFloorPublicationError) {
      throw new CredentialUpdatePublicationError({
        cause,
        credentialAuthority: publishedCredentialAuthority,
        expectedCredentialSlots: publishedCredentialAuthority.credentialSlots,
        expectedLogicalState: intendedLogicalState,
        expectedUnlockSequence: publishedCredentialAuthority.unlockSequence,
        previousCredentialAuthority: credentialAuthority,
        previousSuperblock: superblock,
        stage: "superblock_floor",
        stageOutcome: cause.outcome,
      });
    }
    throw cause;
  }

  const finalCredentialAuthority = await openAuthenticatedUnlockEnvelopeAuthority({
    backend,
    diagnostics,
    fileSystemId: publishedCredentialAuthority.fileSystemId,
    minimumUnlockSequence: publishedCredentialAuthority.unlockSequence,
    rootKey,
  });
  if (finalCredentialAuthority.copyState !== "normal"
    || publishedSuperblock.copyState !== "normal"
    || publishedSuperblock.logicalState.minimumUnlockSequence !== publishedCredentialAuthority.unlockSequence) {
    throw new Error("credential update did not converge both mirrored authorities before success");
  }
  return {
    credentialAuthority: finalCredentialAuthority,
    superblock: publishedSuperblock,
  };
}


type CredentialOperationContext = Readonly<{
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  beforeFirstAuthorityWrite?: () => void;
  credentialAuthority: AuthenticatedUnlockEnvelopeAuthority;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
  superblock: OpenedSuperblockCopies;
  supportedFeatureBits: FeatureBits;
}>;

export async function addCredentialPassphrase({
  backend,
  beforeFirstAuthorityWrite,
  credentialAuthority,
  diagnostics,
  passphrase,
  randomSource,
  rootKey,
  superblock,
  supportedFeatureBits,
}: CredentialOperationContext & Readonly<{
  passphrase: string;
}>): Promise<PublishedCredentialUpdate> {
  const credentialSlots = await prepareAddedPassphraseCredentialSlots({
    authority: credentialAuthority,
    diagnostics,
    passphrase,
    randomSource,
    rootKey,
  });
  return await publishCredentialUpdate({
    backend,
    beforeFirstAuthorityWrite,
    credentialAuthority,
    credentialSlots,
    diagnostics,
    randomSource,
    rootKey,
    superblock,
    supportedFeatureBits,
  });
}

export async function removeCredentialPassphrase({
  backend,
  beforeFirstAuthorityWrite,
  credentialAuthority,
  diagnostics,
  passphrase,
  randomSource,
  retainedPassphrase,
  rootKey,
  superblock,
  supportedFeatureBits,
  targetSlotId,
  unlockingSlotId,
}: CredentialOperationContext & Readonly<{
  passphrase: string;
  retainedPassphrase?: string;
  targetSlotId?: CredentialSlotId;
  unlockingSlotId: CredentialSlotId;
}>): Promise<PublishedCredentialUpdate> {
  const credentialSlots = await prepareRemovedPassphraseCredentialSlots({
    authority: credentialAuthority,
    diagnostics,
    passphrase,
    retainedPassphrase,
    targetSlotId,
    unlockingSlotId,
  });
  return await publishCredentialUpdate({
    backend,
    beforeFirstAuthorityWrite,
    credentialAuthority,
    credentialSlots,
    diagnostics,
    randomSource,
    rootKey,
    superblock,
    supportedFeatureBits,
  });
}

export type PublishedUnlockingCredentialReplacement = PublishedCredentialUpdate & Readonly<{
  unlockingSlotId: CredentialSlotId;
}>;

export async function replaceUnlockingCredentialPassphrase({
  backend,
  beforeFirstAuthorityWrite,
  credentialAuthority,
  diagnostics,
  randomSource,
  replacementPassphrase,
  rootKey,
  superblock,
  supportedFeatureBits,
  unlockingSlotId,
}: CredentialOperationContext & Readonly<{
  replacementPassphrase: string;
  unlockingSlotId: CredentialSlotId;
}>): Promise<PublishedUnlockingCredentialReplacement> {
  const prepared = await prepareReplacedAuthenticatedCredentialSlot({
    authority: credentialAuthority,
    diagnostics,
    randomSource,
    replacementPassphrase,
    rootKey,
    targetSlotId: unlockingSlotId,
  });
  const published = await publishCredentialUpdate({
    backend,
    beforeFirstAuthorityWrite,
    credentialAuthority,
    credentialSlots: prepared.credentialSlots,
    diagnostics,
    randomSource,
    rootKey,
    superblock,
    supportedFeatureBits,
  });
  return {
    ...published,
    unlockingSlotId: prepared.replacementSlotId,
  };
}

export async function replaceCredentialPassphrase({
  backend,
  beforeFirstAuthorityWrite,
  credentialAuthority,
  currentPassphrase,
  diagnostics,
  randomSource,
  replacementPassphrase,
  rootKey,
  superblock,
  supportedFeatureBits,
  targetSlotId,
}: CredentialOperationContext & Readonly<{
  currentPassphrase: string;
  replacementPassphrase: string;
  targetSlotId?: CredentialSlotId;
}>): Promise<PublishedCredentialUpdate> {
  const credentialSlots = await prepareReplacedPassphraseCredentialSlots({
    authority: credentialAuthority,
    currentPassphrase,
    diagnostics,
    randomSource,
    replacementPassphrase,
    rootKey,
    targetSlotId,
  });
  return await publishCredentialUpdate({
    backend,
    beforeFirstAuthorityWrite,
    credentialAuthority,
    credentialSlots,
    diagnostics,
    randomSource,
    rootKey,
    superblock,
    supportedFeatureBits,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
