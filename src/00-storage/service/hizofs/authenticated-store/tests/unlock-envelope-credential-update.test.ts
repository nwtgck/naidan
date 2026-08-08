import { describe, expect, it } from "vitest";
import {
  HIZOFS_UNLOCK_ENVELOPE_FILES,
  createUnlockSequence,
  decodeUnlockEnvelope,
  encodeUnlockEnvelope,
} from "@/00-storage/service/hizofs/00-format";
import type { RandomByteSource } from "@/00-storage/service/hizofs/01-crypto";
import {
  UnlockEnvelopePublicationError,
  createInitialUnlockEnvelopeCopies,
  openAuthenticatedUnlockEnvelopeAuthority,
  openUnlockEnvelopeCopies,
  prepareAddedPassphraseCredentialSlots,
  prepareRemovedPassphraseCredentialSlots,
  publishUnlockEnvelopeCredentialSet,
  resolveUnlockEnvelopePublication,
} from "@/00-storage/service/hizofs/authenticated-store/unlock-envelope-store";
import {
  authenticatedHizoFSPhysicalBytes,
  type AuthenticatedHizoFSPhysicalBytes,
} from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
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

async function authority({
  backend,
  fileSystemId,
  rootKey,
}: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  fileSystemId: Parameters<typeof openAuthenticatedUnlockEnvelopeAuthority>[0]["fileSystemId"];
  rootKey: Parameters<typeof openAuthenticatedUnlockEnvelopeAuthority>[0]["rootKey"];
}) {
  return await openAuthenticatedUnlockEnvelopeAuthority({
    backend,
    fileSystemId,
    minimumUnlockSequence: createUnlockSequence({ value: 1n }),
    rootKey,
  });
}

class FailNthOpenForUpdateBackend extends InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes> {
  private readonly failureOrdinal: number;
  private openForUpdateCalls = 0;

  public constructor({ failureOrdinal }: { failureOrdinal: number }) {
    super({});
    this.failureOrdinal = failureOrdinal;
  }

  public override async openFileForUpdate(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["openFileForUpdate"]>[0],
  ): ReturnType<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["openFileForUpdate"]> {
    this.openForUpdateCalls += 1;
    if (this.openForUpdateCalls === this.failureOrdinal) throw new Error("injected second-copy open failure");
    return await super.openFileForUpdate(input);
  }
}

describe("Unlock Envelope credential publication", () => {
  it("adds a self-tested passphrase slot and converges both copies before returning", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const created = await createInitialUnlockEnvelopeCopies({
      backend,
      passphrase: "old passphrase",
      randomSource: deterministicRandomSource(),
    });
    const base = await authority({ backend, fileSystemId: created.fileSystemId, rootKey: created.rootKey });
    const slots = await prepareAddedPassphraseCredentialSlots({
      authority: base,
      passphrase: "new passphrase",
      randomSource: deterministicRandomSource({ seed: 41 }),
      rootKey: created.rootKey,
    });
    const published = await publishUnlockEnvelopeCredentialSet({
      authority: base,
      backend,
      credentialSlots: slots,
      randomSource: deterministicRandomSource({ seed: 81 }),
      rootKey: created.rootKey,
    });

    expect(published.copyState).toBe("normal");
    expect(published.unlockSequence).toBe(2n);
    expect(published.credentialSlots).toHaveLength(2);
    const openedWithNewPassphrase = await openUnlockEnvelopeCopies({
      backend,
      minimumUnlockSequence: createUnlockSequence({ value: 2n }),
      passphrase: "new passphrase",
    });
    expect(openedWithNewPassphrase.unlockSequence).toBe(2n);
    openedWithNewPassphrase.rootKey.destroy();
    created.rootKey.destroy();
  });

  it("rejects duplicate passphrase registration", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const created = await createInitialUnlockEnvelopeCopies({
      backend,
      passphrase: "same passphrase",
      randomSource: deterministicRandomSource(),
    });
    const base = await authority({ backend, fileSystemId: created.fileSystemId, rootKey: created.rootKey });
    await expect(prepareAddedPassphraseCredentialSlots({
      authority: base,
      passphrase: "same passphrase",
      rootKey: created.rootKey,
    })).rejects.toMatchObject({ code: "credential_rejected" });
    created.rootKey.destroy();
  });

  it("requires a retained passphrase proof before removing the current unlocking slot", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const created = await createInitialUnlockEnvelopeCopies({
      backend,
      passphrase: "old passphrase",
      randomSource: deterministicRandomSource(),
    });
    const base = await authority({ backend, fileSystemId: created.fileSystemId, rootKey: created.rootKey });
    const added = await prepareAddedPassphraseCredentialSlots({
      authority: base,
      passphrase: "retained passphrase",
      randomSource: deterministicRandomSource({ seed: 41 }),
      rootKey: created.rootKey,
    });
    const withTwoSlots = await publishUnlockEnvelopeCredentialSet({
      authority: base,
      backend,
      credentialSlots: added,
      randomSource: deterministicRandomSource({ seed: 81 }),
      rootKey: created.rootKey,
    });

    await expect(prepareRemovedPassphraseCredentialSlots({
      authority: withTwoSlots,
      passphrase: "old passphrase",
      unlockingSlotId: created.unlockingSlotId,
    })).rejects.toMatchObject({ code: "credential_rejected" });

    const retained = await prepareRemovedPassphraseCredentialSlots({
      authority: withTwoSlots,
      passphrase: "old passphrase",
      retainedPassphrase: "retained passphrase",
      unlockingSlotId: created.unlockingSlotId,
    });
    expect(retained).toHaveLength(1);
    expect(retained[0]?.slotId).not.toBe(created.unlockingSlotId);
    const published = await publishUnlockEnvelopeCredentialSet({
      authority: withTwoSlots,
      backend,
      credentialSlots: retained,
      randomSource: deterministicRandomSource({ seed: 121 }),
      rootKey: created.rootKey,
    });
    expect(published.unlockSequence).toBe(3n);
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
    created.rootKey.destroy();
  });

  it("keeps the new authority after the first authenticated copy commits and the second copy fails", async () => {
    const backend = new FailNthOpenForUpdateBackend({ failureOrdinal: 2 });
    const created = await createInitialUnlockEnvelopeCopies({
      backend,
      passphrase: "old passphrase",
      randomSource: deterministicRandomSource(),
    });
    const base = await authority({ backend, fileSystemId: created.fileSystemId, rootKey: created.rootKey });
    const slots = await prepareAddedPassphraseCredentialSlots({
      authority: base,
      passphrase: "new passphrase",
      randomSource: deterministicRandomSource({ seed: 41 }),
      rootKey: created.rootKey,
    });
    const failure = await publishUnlockEnvelopeCredentialSet({
      authority: base,
      backend,
      credentialSlots: slots,
      randomSource: deterministicRandomSource({ seed: 81 }),
      rootKey: created.rootKey,
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(UnlockEnvelopePublicationError);
    expect(failure).toMatchObject({ outcome: "published_redundancy_degraded" });

    const resolution = await resolveUnlockEnvelopePublication({
      backend,
      expectedCredentialSlots: slots,
      expectedUnlockSequence: createUnlockSequence({ value: 2n }),
      previousAuthority: base,
      rootKey: created.rootKey,
    });
    expect(resolution.type).toBe("published");
    expect(resolution.authority.copyState).toBe("credential_redundancy_degraded");
    created.rootKey.destroy();
  });

  it("does not reuse a higher structurally observed torn sequence", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const created = await createInitialUnlockEnvelopeCopies({
      backend,
      passphrase: "old passphrase",
      randomSource: deterministicRandomSource(),
    });
    const path = canonicalContainerPath({ value: HIZOFS_UNLOCK_ENVELOPE_FILES[1] });
    const currentBytes = await backend.readFileBounded({ maximumByteLength: 65_536, path });
    if (currentBytes === undefined) throw new Error("expected Unlock Envelope copy");
    const current = decodeUnlockEnvelope({ bytes: currentBytes });
    const torn = encodeUnlockEnvelope({ envelope: { ...current, sequence: 9 } });
    const file = await backend.openFileForUpdate({ path });
    await backend.writeAt({ bytes: authenticatedHizoFSPhysicalBytes({ bytes: torn }), file, offset: 0n });
    await backend.truncate({ file, length: BigInt(torn.byteLength) });
    await backend.syncFileData({ file });
    await backend.closeFile({ file });

    const base = await authority({ backend, fileSystemId: created.fileSystemId, rootKey: created.rootKey });
    expect(base.unlockSequence).toBe(1n);
    expect(base.maximumStructurallyObservedUnlockSequence).toBe(9n);
    const slots = await prepareAddedPassphraseCredentialSlots({
      authority: base,
      passphrase: "new passphrase",
      randomSource: deterministicRandomSource({ seed: 41 }),
      rootKey: created.rootKey,
    });
    const published = await publishUnlockEnvelopeCredentialSet({
      authority: base,
      backend,
      credentialSlots: slots,
      randomSource: deterministicRandomSource({ seed: 81 }),
      rootKey: created.rootKey,
    });
    expect(published.unlockSequence).toBe(10n);
    created.rootKey.destroy();
  });
});
