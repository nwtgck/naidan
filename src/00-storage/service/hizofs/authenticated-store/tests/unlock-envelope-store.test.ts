import { describe, expect, it } from "vitest";
import {
  createUnlockSequence,
  decodeBase64UrlUnpadded,
  decodeUnlockEnvelope,
  encodeBase64UrlUnpadded,
  encodeUnlockEnvelope,
  HIZOFS_UNLOCK_ENVELOPE_FILES,
  parseCredentialSlotId,
} from "@/00-storage/service/hizofs/00-format";
import type { RandomByteSource } from "@/00-storage/service/hizofs/01-crypto";
import type {
  AuthenticatedCodecDiagnosticsObservation,
  AuthenticatedCryptoDiagnosticsObservation,
  AuthenticatedStoreDiagnosticsPort,
} from "@/00-storage/service/hizofs/authenticated-store/runtime-diagnostics-port";
import { canonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import {
  createInitialUnlockEnvelopeCopies,
  openAuthenticatedUnlockEnvelopeAuthority,
  openUnlockEnvelopeCopies,
  prepareInitialUnlockEnvelopeCredentialSet,
  proveRetainedPassphraseCredentialSlots,
  publishInitialUnlockEnvelopeCredentialSet,
} from "@/00-storage/service/hizofs/authenticated-store/unlock-envelope-store";
import {
  authenticatedHizoFSPhysicalBytes,
  type AuthenticatedHizoFSPhysicalBytes,
} from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

async function readEnvelope({ backend, copy }: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  copy: 0 | 1;
}) {
  const bytes = await backend.readFileBounded({
    maximumByteLength: 65_536,
    path: canonicalContainerPath({ value: HIZOFS_UNLOCK_ENVELOPE_FILES[copy] }),
  });
  if (bytes === undefined) throw new Error("expected Unlock Envelope copy");
  return decodeUnlockEnvelope({ bytes });
}

describe("HizoFS Unlock Envelope store", () => {
  it("publishes two independently authenticated copies and reopens the same root key", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const codecOperations: AuthenticatedCodecDiagnosticsObservation[] = [];
    const cryptoOperations: AuthenticatedCryptoDiagnosticsObservation[] = [];
    const diagnostics: AuthenticatedStoreDiagnosticsPort = {
      recordCodecOperation: observation => codecOperations.push(observation),
      recordCryptoOperation: observation => cryptoOperations.push(observation),
      recordPublicationOperation: () => {},
      recordPersistedRecord: () => {},
    };
    const created = await createInitialUnlockEnvelopeCopies({
      backend,
      diagnostics,
      passphrase: "correct horse battery staple",
      randomSource: deterministicRandomSource(),
    });

    const copy0 = await readEnvelope({ backend, copy: 0 });
    const copy1 = await readEnvelope({ backend, copy: 1 });
    expect(copy0).toMatchObject({ copy: 0, fileSystemId: created.fileSystemId, sequence: 1 });
    expect(copy1).toMatchObject({ copy: 1, fileSystemId: created.fileSystemId, sequence: 1 });
    expect(copy0.credentialSlots).toEqual(copy1.credentialSlots);
    expect(copy0.authenticatorNonce).not.toBe(copy1.authenticatorNonce);
    expect(copy0.authenticatorTag).not.toBe(copy1.authenticatorTag);
    expect(backend.openHandleCount()).toBe(0);

    const opened = await openUnlockEnvelopeCopies({
      backend,
      diagnostics,
      minimumUnlockSequence: createUnlockSequence({ value: 1n }),
      passphrase: "correct horse battery staple",
    });
    expect(opened.copyState).toBe("normal");
    expect(opened.fileSystemId).toBe(created.fileSystemId);
    expect(opened.unlockSequence).toBe(1n);
    expect(opened.unlockingSlotId).toBe(created.unlockingSlotId);
    expect(opened.rootKey.isDestroyed()).toBe(false);
    expect(codecOperations.filter(({ operation }) => operation === "encode")).toHaveLength(8);
    expect(codecOperations.filter(({ operation }) => operation === "decode")).toHaveLength(4);
    expect(codecOperations.every(({ durationMs, format }) => (
      format === "envelope" && Number.isFinite(durationMs) && durationMs >= 0
    ))).toBe(true);
    expect(cryptoOperations.filter(({ operation }) => operation === "encrypt")).toHaveLength(3);
    expect(cryptoOperations.filter(({ operation }) => operation === "decrypt")).toHaveLength(5);
    expect(cryptoOperations.every(({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0)).toBe(true);
    opened.rootKey.destroy();
    created.rootKey.destroy();
    expect(backend.openHandleCount()).toBe(0);
  });

  it("rejects a wrong passphrase without leaking a root-key capability", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const created = await createInitialUnlockEnvelopeCopies({
      backend,
      passphrase: "right",
      randomSource: deterministicRandomSource(),
    });
    created.rootKey.destroy();

    await expect(openUnlockEnvelopeCopies({
      backend,
      minimumUnlockSequence: createUnlockSequence({ value: 1n }),
      passphrase: "wrong",
    })).rejects.toMatchObject({
      code: "credential_rejected",
    });
    expect(backend.openHandleCount()).toBe(0);
  });

  it("skips an unauthenticated tampered slot and opens the valid sibling", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const created = await createInitialUnlockEnvelopeCopies({
      backend,
      passphrase: "passphrase",
      randomSource: deterministicRandomSource(),
    });
    created.rootKey.destroy();
    const envelope = await readEnvelope({ backend, copy: 0 });
    const firstSlot = envelope.credentialSlots[0];
    if (firstSlot === undefined) throw new Error("expected initial credential slot");
    const tamperedParameters = decodeBase64UrlUnpadded({
      maximumDecodedBytes: 32,
      value: firstSlot.methodParameters,
    });
    const firstParameterByte = tamperedParameters[0];
    if (firstParameterByte === undefined) throw new Error("expected credential method parameters");
    tamperedParameters[0] = firstParameterByte ^ 0x01;
    const malformed = encodeUnlockEnvelope({
      envelope: {
        ...envelope,
        credentialSlots: [{
          ...firstSlot,
          methodParameters: encodeBase64UrlUnpadded({ bytes: tamperedParameters }),
        }],
      },
    });
    const path = canonicalContainerPath({ value: HIZOFS_UNLOCK_ENVELOPE_FILES[0] });
    const file = await backend.openFileForUpdate({ path });
    try {
      await backend.writeAt({
        bytes: authenticatedHizoFSPhysicalBytes({ bytes: malformed }),
        file,
        offset: 0n,
      });
      await backend.truncate({ file, length: BigInt(malformed.byteLength) });
      await backend.syncFileData({ file });
    } finally {
      await backend.closeFile({ file });
    }

    const opened = await openUnlockEnvelopeCopies({
      backend,
      minimumUnlockSequence: createUnlockSequence({ value: 1n }),
      passphrase: "passphrase",
    });
    expect(opened.copyState).toBe("credential_redundancy_degraded");
    opened.rootKey.destroy();
  });

  it("opens as credential-redundancy-degraded when one copy is missing", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const created = await createInitialUnlockEnvelopeCopies({
      backend,
      passphrase: "passphrase",
      randomSource: deterministicRandomSource(),
    });
    created.rootKey.destroy();
    await backend.removeFile({ path: canonicalContainerPath({ value: HIZOFS_UNLOCK_ENVELOPE_FILES[1] }) });

    const opened = await openUnlockEnvelopeCopies({
      backend,
      minimumUnlockSequence: createUnlockSequence({ value: 1n }),
      passphrase: "passphrase",
    });
    expect(opened.copyState).toBe("credential_redundancy_degraded");
    opened.rootKey.destroy();
  });

  it("fails closed when both copies are unavailable", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    await expect(openUnlockEnvelopeCopies({
      backend,
      minimumUnlockSequence: createUnlockSequence({ value: 1n }),
      passphrase: "passphrase",
    })).rejects.toMatchObject({
      code: "incomplete_container",
    });
  });

  it("publishes one complete initial credential set and proves retained source slots", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const passphrases = ["primary passphrase", "recovery passphrase", "automation passphrase"] as const;
    const prepared = await prepareInitialUnlockEnvelopeCredentialSet({
      passphrases,
      randomSource: deterministicRandomSource(),
    });
    const created = await publishInitialUnlockEnvelopeCredentialSet({ backend, prepared });
    expect(created.credentialSlotIds).toHaveLength(passphrases.length);

    const authority = await openAuthenticatedUnlockEnvelopeAuthority({
      backend,
      fileSystemId: created.fileSystemId,
      minimumUnlockSequence: created.unlockSequence,
      rootKey: created.rootKey,
    });
    expect(authority.credentialSlots.map(slot => slot.slotId)).toEqual(created.credentialSlotIds);

    const proven = await proveRetainedPassphraseCredentialSlots({
      authority,
      retainedCredentials: [
        { passphrase: passphrases[2] },
        { passphrase: passphrases[0] },
      ],
    });
    expect(proven.map(({ passphrase }) => passphrase)).toEqual([passphrases[2], passphrases[0]]);
    expect(new Set(proven.map(({ sourceSlotId }) => sourceSlotId)).size).toBe(2);

    for (const passphrase of passphrases) {
      const opened = await openUnlockEnvelopeCopies({
        backend,
        minimumUnlockSequence: createUnlockSequence({ value: 1n }),
        passphrase,
      });
      expect(opened.fileSystemId).toBe(created.fileSystemId);
      opened.rootKey.destroy();
    }
    created.rootKey.destroy();
    expect(backend.openHandleCount()).toBe(0);
  });

  it("rejects incomplete, duplicate, unknown, and unproven retained credential sets", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    await expect(prepareInitialUnlockEnvelopeCredentialSet({
      passphrases: [],
      randomSource: deterministicRandomSource(),
    })).rejects.toThrow("at least one passphrase");
    await expect(prepareInitialUnlockEnvelopeCredentialSet({
      passphrases: ["same", "same"],
      randomSource: deterministicRandomSource(),
    })).rejects.toThrow("duplicate passphrase");

    const prepared = await prepareInitialUnlockEnvelopeCredentialSet({
      passphrases: ["primary", "recovery"],
      randomSource: deterministicRandomSource(),
    });
    const created = await publishInitialUnlockEnvelopeCredentialSet({ backend, prepared });
    const authority = await openAuthenticatedUnlockEnvelopeAuthority({
      backend,
      fileSystemId: created.fileSystemId,
      minimumUnlockSequence: created.unlockSequence,
      rootKey: created.rootKey,
    });

    await expect(proveRetainedPassphraseCredentialSlots({
      authority,
      retainedCredentials: [],
    })).rejects.toThrow("at least one proof");
    await expect(proveRetainedPassphraseCredentialSlots({
      authority,
      retainedCredentials: [{ passphrase: "primary" }, { passphrase: "primary" }],
    })).rejects.toThrow("duplicate passphrase");
    await expect(proveRetainedPassphraseCredentialSlots({
      authority,
      retainedCredentials: [{ passphrase: "wrong" }],
    })).rejects.toMatchObject({ code: "credential_rejected" });
    await expect(proveRetainedPassphraseCredentialSlots({
      authority,
      retainedCredentials: [{
        passphrase: "primary",
        sourceSlotId: parseCredentialSlotId({ value: "Abcdefghij_klmnopq-12" }),
      }],
    })).rejects.toMatchObject({ code: "credential_rejected" });

    created.rootKey.destroy();
    expect(backend.openHandleCount()).toBe(0);
  });

});
