import { describe, expect, it } from "vitest";
import {
  HIZOFS_SUPERBLOCK_FILES,
  HIZOFS_UNLOCK_ENVELOPE_FILES,
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFeatureBits,
  createHomeRecordReference,
  createPublicationSequence,
  createUInt64,
  createUnlockSequence,
  parseMutationId,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";
import type { SuperblockLogicalState } from "@/00-storage/service/hizofs/authenticated-store/superblock-store";
import type { RandomByteSource } from "@/00-storage/service/hizofs/01-crypto";
import type {
  AuthenticatedCryptoDiagnosticsObservation,
  AuthenticatedStoreDiagnosticsPort,
} from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";
import {
  CredentialUpdatePublicationError,
  addCredentialPassphrase,
  publishCredentialUpdate,
  removeCredentialPassphrase,
  resolveCredentialUpdatePublication,
  replaceCredentialPassphrase,
  replaceUnlockingCredentialPassphrase,
} from "@/00-storage/service/hizofs/authenticated-store/credential-update-coordinator";
import {
  createInitialSuperblockCopies,
  openSuperblockCopies,
} from "@/00-storage/service/hizofs/authenticated-store/superblock-store";
import {
  createInitialUnlockEnvelopeCopies,
  openAuthenticatedUnlockEnvelopeAuthority,
  openUnlockEnvelopeCopies,
  prepareAddedPassphraseCredentialSlots,
} from "@/00-storage/service/hizofs/authenticated-store/unlock-envelope-store";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import type { CanonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";
import { canonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";

function deterministicRandomSource({ seed = 1 }: { seed?: number } = {}): RandomByteSource {
  let next = seed;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

function initialLogicalState(): SuperblockLogicalState {
  return {
    activeCommitHomeRef: createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 64n }),
      frameLength: 96,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(7) }),
    } }),
    activeCommitSequence: createCommitSequence({ value: 1n }),
    activeMutationId: parseMutationId({ bytes: new Uint8Array(16).fill(3) }),
    fallbackCommitHomeRef: null,
    minimumUnlockSequence: createUnlockSequence({ value: 1n }),
    relocationIndexRootPhysicalRef: null,
    requiredFeatureBits: createFeatureBits({ value: 0n }),
  };
}

class ObservedUpdateBackend extends InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes> {
  private readonly openedPathsValue: CanonicalContainerPath[] = [];
  private pathToFail: CanonicalContainerPath | undefined;

  public failNextOpenForUpdate({ path }: { path: CanonicalContainerPath }): void {
    this.pathToFail = path;
  }

  public openedPaths(): readonly CanonicalContainerPath[] {
    return [...this.openedPathsValue];
  }

  public resetOpenedPaths(): void {
    this.openedPathsValue.length = 0;
  }

  public override async openFileForUpdate(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["openFileForUpdate"]>[0],
  ): ReturnType<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["openFileForUpdate"]> {
    this.openedPathsValue.push(input.path);
    if (this.pathToFail === input.path) {
      this.pathToFail = undefined;
      throw new Error("injected selected-path open failure");
    }
    return await super.openFileForUpdate(input);
  }
}

async function initializedState({ backend }: {
  backend: ObservedUpdateBackend;
}) {
  const created = await createInitialUnlockEnvelopeCopies({
    backend,
    passphrase: "old passphrase",
    randomSource: deterministicRandomSource(),
  });
  const supportedFeatureBits = createFeatureBits({ value: 0n });
  const superblock = await createInitialSuperblockCopies({
    backend,
    fileSystemId: created.fileSystemId,
    logicalState: initialLogicalState(),
    randomSource: deterministicRandomSource({ seed: 51 }),
    rootKey: created.rootKey,
    supportedFeatureBits,
  });
  const credentialAuthority = await openAuthenticatedUnlockEnvelopeAuthority({
    backend,
    fileSystemId: created.fileSystemId,
    minimumUnlockSequence: superblock.logicalState.minimumUnlockSequence,
    rootKey: created.rootKey,
  });
  return { created, credentialAuthority, superblock, supportedFeatureBits };
}

describe("credential update coordinator", () => {
  it("converges both Unlock Envelope copies before advancing both Superblock floors", async () => {
    const backend = new ObservedUpdateBackend({});
    const cryptoOperations: AuthenticatedCryptoDiagnosticsObservation[] = [];
    const diagnostics: AuthenticatedStoreDiagnosticsPort = {
      recordCodecOperation: () => {},
      recordCryptoOperation: observation => cryptoOperations.push(observation),
      recordPublicationOperation: () => {},
      recordPersistedRecord: () => {},
    };
    const state = await initializedState({ backend });
    const slots = await prepareAddedPassphraseCredentialSlots({
      authority: state.credentialAuthority,
      diagnostics,
      passphrase: "new passphrase",
      randomSource: deterministicRandomSource({ seed: 101 }),
      rootKey: state.created.rootKey,
    });
    backend.resetOpenedPaths();

    const published = await publishCredentialUpdate({
      backend,
      credentialAuthority: state.credentialAuthority,
      credentialSlots: slots,
      diagnostics,
      randomSource: deterministicRandomSource({ seed: 151 }),
      rootKey: state.created.rootKey,
      superblock: state.superblock,
      supportedFeatureBits: state.supportedFeatureBits,
    });

    expect(published.credentialAuthority).toMatchObject({ copyState: "normal", unlockSequence: 2n });
    expect(published.superblock).toMatchObject({
      copyState: "normal",
      logicalState: { minimumUnlockSequence: 2n },
    });
    expect(cryptoOperations.some(({ operation }) => operation === "encrypt")).toBe(true);
    expect(cryptoOperations.some(({ operation }) => operation === "decrypt")).toBe(true);
    expect(cryptoOperations.every(({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0)).toBe(true);
    expect(backend.openedPaths()).toEqual([
      canonicalContainerPath({ value: HIZOFS_UNLOCK_ENVELOPE_FILES[1] }),
      canonicalContainerPath({ value: HIZOFS_UNLOCK_ENVELOPE_FILES[0] }),
      canonicalContainerPath({ value: HIZOFS_SUPERBLOCK_FILES[0] }),
      canonicalContainerPath({ value: HIZOFS_SUPERBLOCK_FILES[1] }),
    ]);
    const reopened = await openUnlockEnvelopeCopies({
      backend,
      minimumUnlockSequence: createUnlockSequence({ value: 2n }),
      passphrase: "new passphrase",
    });
    reopened.rootKey.destroy();
    state.created.rootKey.destroy();
  });

  it("resolves an Unlock commit with a pending Superblock floor after response loss", async () => {
    const backend = new ObservedUpdateBackend({});
    const state = await initializedState({ backend });
    const slots = await prepareAddedPassphraseCredentialSlots({
      authority: state.credentialAuthority,
      passphrase: "new passphrase",
      randomSource: deterministicRandomSource({ seed: 101 }),
      rootKey: state.created.rootKey,
    });
    backend.failNextOpenForUpdate({
      path: canonicalContainerPath({ value: HIZOFS_UNLOCK_ENVELOPE_FILES[0] }),
    });

    const failure = await publishCredentialUpdate({
      backend,
      credentialAuthority: state.credentialAuthority,
      credentialSlots: slots,
      randomSource: deterministicRandomSource({ seed: 151 }),
      rootKey: state.created.rootKey,
      superblock: state.superblock,
      supportedFeatureBits: state.supportedFeatureBits,
    }).catch((cause: unknown) => cause);

    if (!(failure instanceof CredentialUpdatePublicationError)) throw failure;
    expect(failure).toMatchObject({
      expectedUnlockSequence: 2n,
      stage: "unlock_envelope",
      stageOutcome: "credential_committed_redundancy_degraded",
    });
    const resolution = await resolveCredentialUpdatePublication({
      backend,
      failure: failure as CredentialUpdatePublicationError,
      rootKey: state.created.rootKey,
      supportedFeatureBits: state.supportedFeatureBits,
    });
    expect(resolution).toMatchObject({
      credentialAuthority: { copyState: "credential_redundancy_degraded", unlockSequence: 2n },
      superblock: { logicalState: { minimumUnlockSequence: 1n } },
      type: "credential_published_floor_pending",
    });
    state.created.rootKey.destroy();
  });

  it("reports a committed credential set when the second Superblock floor copy fails", async () => {
    const backend = new ObservedUpdateBackend({});
    const state = await initializedState({ backend });
    const slots = await prepareAddedPassphraseCredentialSlots({
      authority: state.credentialAuthority,
      passphrase: "new passphrase",
      randomSource: deterministicRandomSource({ seed: 101 }),
      rootKey: state.created.rootKey,
    });
    backend.failNextOpenForUpdate({
      path: canonicalContainerPath({ value: HIZOFS_SUPERBLOCK_FILES[1] }),
    });

    const failure = await publishCredentialUpdate({
      backend,
      credentialAuthority: state.credentialAuthority,
      credentialSlots: slots,
      randomSource: deterministicRandomSource({ seed: 151 }),
      rootKey: state.created.rootKey,
      superblock: state.superblock,
      supportedFeatureBits: state.supportedFeatureBits,
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(CredentialUpdatePublicationError);
    expect(failure).toMatchObject({
      credentialAuthority: { copyState: "normal", unlockSequence: 2n },
      stage: "superblock_floor",
      stageOutcome: "published_redundancy_degraded",
    });
    const reopenedSuperblock = await openSuperblockCopies({
      backend,
      fileSystemId: state.created.fileSystemId,
      rootKey: state.created.rootKey,
      supportedFeatureBits: state.supportedFeatureBits,
    });
    expect(reopenedSuperblock).toMatchObject({
      copyState: "superblock_redundancy_degraded",
      logicalState: { minimumUnlockSequence: 2n },
    });
    const resolution = await resolveCredentialUpdatePublication({
      backend,
      failure: failure as CredentialUpdatePublicationError,
      rootKey: state.created.rootKey,
      supportedFeatureBits: state.supportedFeatureBits,
    });
    expect(resolution).toMatchObject({
      credentialAuthority: { copyState: "normal", unlockSequence: 2n },
      superblock: { copyState: "superblock_redundancy_degraded" },
      type: "published_redundancy_degraded",
    });
    state.created.rootKey.destroy();
  });

  it("preflights F + 1 and F + 2 before changing the credential authority", async () => {
    const backend = new ObservedUpdateBackend({});
    const state = await initializedState({ backend });
    const slots = await prepareAddedPassphraseCredentialSlots({
      authority: state.credentialAuthority,
      passphrase: "new passphrase",
      randomSource: deterministicRandomSource({ seed: 101 }),
      rootKey: state.created.rootKey,
    });
    backend.resetOpenedPaths();
    const exhausted = {
      ...state.superblock,
      maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: (1n << 64n) - 1n }),
    };

    await expect(publishCredentialUpdate({
      backend,
      credentialAuthority: state.credentialAuthority,
      credentialSlots: slots,
      rootKey: state.created.rootKey,
      superblock: exhausted,
      supportedFeatureBits: state.supportedFeatureBits,
    })).rejects.toThrow("cannot reserve F + 1 and F + 2");
    expect(backend.openedPaths()).toEqual([]);
    const unchanged = await openAuthenticatedUnlockEnvelopeAuthority({
      backend,
      fileSystemId: state.created.fileSystemId,
      minimumUnlockSequence: createUnlockSequence({ value: 1n }),
      rootKey: state.created.rootKey,
    });
    expect(unchanged.unlockSequence).toBe(1n);
    state.created.rootKey.destroy();
  });

  it("replaces the authenticated unlocking slot without retaining the previous passphrase", async () => {
    const backend = new ObservedUpdateBackend({});
    const state = await initializedState({ backend });
    const previousSlotId = state.created.unlockingSlotId;

    const published = await replaceUnlockingCredentialPassphrase({
      backend,
      credentialAuthority: state.credentialAuthority,
      randomSource: deterministicRandomSource({ seed: 101 }),
      replacementPassphrase: "replacement passphrase",
      rootKey: state.created.rootKey,
      superblock: state.superblock,
      supportedFeatureBits: state.supportedFeatureBits,
      unlockingSlotId: previousSlotId,
    });

    expect(published.unlockingSlotId).not.toBe(previousSlotId);
    await expect(openUnlockEnvelopeCopies({
      backend,
      minimumUnlockSequence: published.superblock.logicalState.minimumUnlockSequence,
      passphrase: "old passphrase",
    })).rejects.toMatchObject({ code: "credential_rejected" });
    const reopened = await openUnlockEnvelopeCopies({
      backend,
      minimumUnlockSequence: published.superblock.logicalState.minimumUnlockSequence,
      passphrase: "replacement passphrase",
    });
    expect(reopened.unlockingSlotId).toBe(published.unlockingSlotId);
    reopened.rootKey.destroy();
    state.created.rootKey.destroy();
  });

  it("atomically replaces the current slot with a fresh self-tested slot", async () => {
    const backend = new ObservedUpdateBackend({});
    const state = await initializedState({ backend });
    const previousSlotId = state.credentialAuthority.credentialSlots[0]?.slotId;
    if (previousSlotId === undefined) throw new Error("expected initial Credential Slot");

    const published = await replaceCredentialPassphrase({
      backend,
      credentialAuthority: state.credentialAuthority,
      currentPassphrase: "old passphrase",
      randomSource: deterministicRandomSource({ seed: 101 }),
      replacementPassphrase: "old passphrase",
      rootKey: state.created.rootKey,
      superblock: state.superblock,
      supportedFeatureBits: state.supportedFeatureBits,
    });

    expect(published.credentialAuthority.credentialSlots).toHaveLength(1);
    expect(published.credentialAuthority.credentialSlots[0]?.slotId).not.toBe(previousSlotId);
    expect(published.superblock.logicalState.minimumUnlockSequence).toBe(2n);
    const reopened = await openUnlockEnvelopeCopies({
      backend,
      minimumUnlockSequence: createUnlockSequence({ value: 2n }),
      passphrase: "old passphrase",
    });
    expect(reopened.unlockingSlotId).not.toBe(previousSlotId);
    reopened.rootKey.destroy();
    state.created.rootKey.destroy();
  });

  it("removes the unlocking slot only after proving a retained passphrase", async () => {
    const backend = new ObservedUpdateBackend({});
    const state = await initializedState({ backend });
    const added = await addCredentialPassphrase({
      backend,
      credentialAuthority: state.credentialAuthority,
      passphrase: "retained passphrase",
      randomSource: deterministicRandomSource({ seed: 101 }),
      rootKey: state.created.rootKey,
      superblock: state.superblock,
      supportedFeatureBits: state.supportedFeatureBits,
    });

    const removed = await removeCredentialPassphrase({
      backend,
      credentialAuthority: added.credentialAuthority,
      passphrase: "old passphrase",
      randomSource: deterministicRandomSource({ seed: 151 }),
      retainedPassphrase: "retained passphrase",
      rootKey: state.created.rootKey,
      superblock: added.superblock,
      supportedFeatureBits: state.supportedFeatureBits,
      unlockingSlotId: state.created.unlockingSlotId,
    });

    expect(removed.credentialAuthority).toMatchObject({ unlockSequence: 3n });
    expect(removed.superblock.logicalState.minimumUnlockSequence).toBe(3n);
    await expect(openUnlockEnvelopeCopies({
      backend,
      minimumUnlockSequence: createUnlockSequence({ value: 1n }),
      passphrase: "old passphrase",
    })).rejects.toMatchObject({ code: "credential_rejected" });
    const reopened = await openUnlockEnvelopeCopies({
      backend,
      minimumUnlockSequence: createUnlockSequence({ value: 3n }),
      passphrase: "retained passphrase",
    });
    reopened.rootKey.destroy();
    state.created.rootKey.destroy();
  });

});
