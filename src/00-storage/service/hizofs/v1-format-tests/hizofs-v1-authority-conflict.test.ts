import {
  HIZOFS_SUPERBLOCK_FILES,
  HIZOFS_UNLOCK_ENVELOPE_FILES,
  HIZOFS_V1_FORMAT_CONSTANTS,
  createFeatureBits,
  createSuperblockHeader,
  createUnlockSequence,
  decodeSuperblockHeader,
  decodeSuperblockPlaintext,
  decodeUnlockEnvelope,
  encodeBase64UrlUnpadded,
  encodeSuperblockHeader,
  encodeSuperblockPlaintext,
  encodeUnlockEnvelope,
  parseMutationId,
  type UnlockEnvelopeV1,
} from "@/00-storage/service/hizofs/00-format";
import {
  authenticatedSuperblockBytes,
  createUnlockAuthenticatorTag,
  decryptAuthenticatedSuperblock,
  encryptSuperblock,
  plaintextSuperblockBytes,
  superblockNonce,
  unlockAuthenticatorNonce,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import { openSuperblockCopies } from "@/00-storage/service/hizofs/authenticated-store/superblock-store";
import {
  openAuthenticatedUnlockEnvelopeAuthority,
  openUnlockEnvelopeCopies,
  prepareAddedPassphraseCredentialSlots,
} from "@/00-storage/service/hizofs/authenticated-store/unlock-envelope-store";
import { authenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import { canonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";
import representativeFixtureJson from "./fixtures/representative-filesystem-v1.json";
import { expectedObservableState } from "./model/reference-filesystem-model";
import { historicalRepresentativeFilesystemScenario } from "./scenarios/representative-filesystem";
import {
  observeObservableState,
  openFreshReadOnlySession,
  openFreshReadOnlySessionWithFeatureBits,
} from "./support/hizofs-test-environment";
import { restoreFrozenPortableContainer, validateFrozenPortableContainerFixture } from "./support/portable-container";
import { expect, it } from "vitest";

function deterministicConflictRandomSource(): RandomByteSource {
  let next = 173;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

async function overwritePersistedFile({ backend, bytes, path }: {
  backend: Awaited<ReturnType<typeof restoreFrozenPortableContainer>>;
  bytes: Uint8Array;
  path: ReturnType<typeof canonicalContainerPath>;
}): Promise<void> {
  const handle = await backend.openFileForUpdate({ path });
  if (handle === undefined) throw new Error(`expected persisted file update handle: ${path}`);
  try {
    await backend.writeAt({
      bytes: authenticatedHizoFSPhysicalBytes({ bytes }),
      file: handle,
      offset: 0n,
    });
    await backend.truncate({ file: handle, length: BigInt(bytes.byteLength) });
    await backend.syncFileData({ file: handle });
  } finally {
    await backend.closeFile({ file: handle });
  }
}

it("fails closed when two authenticated Superblock copies reuse one Publication Sequence", async () => {
  const fixture = validateFrozenPortableContainerFixture({ fixture: representativeFixtureJson });
  const backend = await restoreFrozenPortableContainer({ fixture });
  const unlocked = await openUnlockEnvelopeCopies({
    backend,
    minimumUnlockSequence: createUnlockSequence({ value: 1n }),
    passphrase: fixture.passphrase,
  });

  try {
    const headerSize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockHeader;
    const copies = await Promise.all(HIZOFS_SUPERBLOCK_FILES.map(async (file, physicalCopy) => {
      const path = canonicalContainerPath({ value: file });
      const bytes = await backend.readFileBounded({
        maximumByteLength: HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockFile,
        path,
      });
      if (bytes === undefined) throw new Error(`expected frozen Superblock copy: ${file}`);
      const exactHeader = bytes.subarray(0, headerSize);
      const header = decodeSuperblockHeader({ bytes: exactHeader });
      if (header.copy !== physicalCopy) throw new Error(`Superblock copy identity mismatch: ${file}`);
      const plaintextBytes = await decryptAuthenticatedSuperblock({
        ciphertext: authenticatedSuperblockBytes({ bytes: bytes.subarray(headerSize) }),
        copy: header.copy,
        exactHeader,
        fileSystemId: unlocked.fileSystemId,
        nonce: superblockNonce({ bytes: header.nonce }),
        publicationSequence: header.publicationSequence,
        rootKey: unlocked.rootKey,
      });
      return { header, path, plaintext: decodeSuperblockPlaintext({ bytes: plaintextBytes, flags: header.flags }) };
    }));

    const [first, second] = copies;
    if (first === undefined || second === undefined) throw new Error("expected both frozen Superblock copies");
    const target = first.header.publicationSequence < second.header.publicationSequence ? first : second;
    const sibling = target === first ? second : first;
    if (target.header.publicationSequence === sibling.header.publicationSequence) {
      throw new Error("fixture unexpectedly already reuses a Publication Sequence");
    }

    const conflictingHeader = createSuperblockHeader({
      activeCommitSequence: target.header.activeCommitSequence,
      copy: target.header.copy,
      fileSystemId: target.header.fileSystemId,
      flags: target.header.flags,
      nonce: Uint8Array.from({ length: HIZOFS_V1_FORMAT_CONSTANTS.crypto.nonceBytes }, (_, index) => 0x80 + index),
      publicationSequence: sibling.header.publicationSequence,
    });
    const conflictingPlaintext = {
      ...target.plaintext,
      activeMutationId: parseMutationId({ bytes: new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.limits.binaryRandomIdBytes).fill(0xa5) }),
    };
    const exactHeader = encodeSuperblockHeader({ header: conflictingHeader });
    const ciphertext = await encryptSuperblock({
      copy: conflictingHeader.copy,
      exactHeader,
      fileSystemId: unlocked.fileSystemId,
      nonce: superblockNonce({ bytes: conflictingHeader.nonce }),
      plaintext: plaintextSuperblockBytes({
        bytes: encodeSuperblockPlaintext({ flags: conflictingHeader.flags, plaintext: conflictingPlaintext }),
      }),
      publicationSequence: conflictingHeader.publicationSequence,
      rootKey: unlocked.rootKey,
    });
    const replacement = new Uint8Array(exactHeader.byteLength + ciphertext.byteLength);
    replacement.set(exactHeader, 0);
    replacement.set(ciphertext, exactHeader.byteLength);
    await overwritePersistedFile({ backend, bytes: replacement, path: target.path });

    const afterHeaders = await Promise.all(HIZOFS_SUPERBLOCK_FILES.map(async file => {
      const bytes = await backend.readFileBounded({
        maximumByteLength: HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockFile,
        path: canonicalContainerPath({ value: file }),
      });
      if (bytes === undefined) throw new Error(`expected Superblock after conflict injection: ${file}`);
      return decodeSuperblockHeader({ bytes: bytes.subarray(0, headerSize) });
    }));
    expect(afterHeaders.map(header => header.publicationSequence)).toEqual([
      sibling.header.publicationSequence,
      sibling.header.publicationSequence,
    ]);
    await expect(openSuperblockCopies({
      backend,
      fileSystemId: unlocked.fileSystemId,
      rootKey: unlocked.rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).rejects.toMatchObject({ code: "control_plane_corrupt" });
  } finally {
    unlocked.rootKey.destroy();
  }

  await expect(openFreshReadOnlySession({
    backend,
    expectedFileSystemId: fixture.fileSystemId,
    passphrase: fixture.passphrase,
  })).rejects.toMatchObject({ code: "control_plane_corrupt" });
});

it("does not roll back to an older supported Superblock when the newest authenticated authority requires an unsupported feature", async () => {
  const fixture = validateFrozenPortableContainerFixture({ fixture: representativeFixtureJson });
  const backend = await restoreFrozenPortableContainer({ fixture });
  const unlocked = await openUnlockEnvelopeCopies({
    backend,
    minimumUnlockSequence: createUnlockSequence({ value: 1n }),
    passphrase: fixture.passphrase,
  });

  try {
    const headerSize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockHeader;
    const copies = await Promise.all(HIZOFS_SUPERBLOCK_FILES.map(async (file, physicalCopy) => {
      const path = canonicalContainerPath({ value: file });
      const bytes = await backend.readFileBounded({
        maximumByteLength: HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockFile,
        path,
      });
      if (bytes === undefined) throw new Error(`expected frozen Superblock copy: ${file}`);
      const exactHeader = bytes.subarray(0, headerSize);
      const header = decodeSuperblockHeader({ bytes: exactHeader });
      if (header.copy !== physicalCopy) throw new Error(`Superblock copy identity mismatch: ${file}`);
      const plaintextBytes = await decryptAuthenticatedSuperblock({
        ciphertext: authenticatedSuperblockBytes({ bytes: bytes.subarray(headerSize) }),
        copy: header.copy,
        exactHeader,
        fileSystemId: unlocked.fileSystemId,
        nonce: superblockNonce({ bytes: header.nonce }),
        publicationSequence: header.publicationSequence,
        rootKey: unlocked.rootKey,
      });
      return { header, path, plaintext: decodeSuperblockPlaintext({ bytes: plaintextBytes, flags: header.flags }) };
    }));

    const [first, second] = copies;
    if (first === undefined || second === undefined) throw new Error("expected both frozen Superblock copies");
    const newest = first.header.publicationSequence > second.header.publicationSequence ? first : second;
    const older = newest === first ? second : first;
    expect(newest.header.publicationSequence).toBeGreaterThan(older.header.publicationSequence);

    const replacementHeader = createSuperblockHeader({
      activeCommitSequence: newest.header.activeCommitSequence,
      copy: newest.header.copy,
      fileSystemId: newest.header.fileSystemId,
      flags: newest.header.flags,
      nonce: Uint8Array.from(
        { length: HIZOFS_V1_FORMAT_CONSTANTS.crypto.nonceBytes },
        (_, index) => 0x60 + index,
      ),
      publicationSequence: newest.header.publicationSequence,
    });
    const exactHeader = encodeSuperblockHeader({ header: replacementHeader });
    const ciphertext = await encryptSuperblock({
      copy: replacementHeader.copy,
      exactHeader,
      fileSystemId: unlocked.fileSystemId,
      nonce: superblockNonce({ bytes: replacementHeader.nonce }),
      plaintext: plaintextSuperblockBytes({
        bytes: encodeSuperblockPlaintext({
          flags: replacementHeader.flags,
          plaintext: { ...newest.plaintext, requiredFeatureBits: createFeatureBits({ value: 1n }) },
        }),
      }),
      publicationSequence: replacementHeader.publicationSequence,
      rootKey: unlocked.rootKey,
    });
    const replacement = new Uint8Array(exactHeader.byteLength + ciphertext.byteLength);
    replacement.set(exactHeader, 0);
    replacement.set(ciphertext, exactHeader.byteLength);
    await overwritePersistedFile({ backend, bytes: replacement, path: newest.path });
  } finally {
    unlocked.rootKey.destroy();
  }

  await expect(openFreshReadOnlySession({
    backend,
    expectedFileSystemId: fixture.fileSystemId,
    passphrase: fixture.passphrase,
  })).rejects.toMatchObject({ code: "unsupported_required_feature" });

  const supported = await openFreshReadOnlySessionWithFeatureBits({
    backend,
    expectedFileSystemId: fixture.fileSystemId,
    passphrase: fixture.passphrase,
    supportedFeatureBits: createFeatureBits({ value: 1n }),
  });
  try {
    expect(await observeObservableState({ session: supported })).toEqual(
      expectedObservableState({ scenario: historicalRepresentativeFilesystemScenario }),
    );
  } finally {
    await supported.close();
  }
});

it("fails closed when authenticated Superblocks advance the credential rollback floor beyond every Unlock Envelope", async () => {
  const fixture = validateFrozenPortableContainerFixture({ fixture: representativeFixtureJson });
  const backend = await restoreFrozenPortableContainer({ fixture });
  const unlocked = await openUnlockEnvelopeCopies({
    backend,
    minimumUnlockSequence: createUnlockSequence({ value: 1n }),
    passphrase: fixture.passphrase,
  });
  const advancedFloor = createUnlockSequence({ value: unlocked.unlockSequence + 1n });

  try {
    const headerSize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockHeader;
    for (const [physicalCopy, file] of HIZOFS_SUPERBLOCK_FILES.entries()) {
      const path = canonicalContainerPath({ value: file });
      const bytes = await backend.readFileBounded({
        maximumByteLength: HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockFile,
        path,
      });
      if (bytes === undefined) throw new Error(`expected frozen Superblock copy: ${file}`);
      const currentHeaderBytes = bytes.subarray(0, headerSize);
      const currentHeader = decodeSuperblockHeader({ bytes: currentHeaderBytes });
      const plaintextBytes = await decryptAuthenticatedSuperblock({
        ciphertext: authenticatedSuperblockBytes({ bytes: bytes.subarray(headerSize) }),
        copy: currentHeader.copy,
        exactHeader: currentHeaderBytes,
        fileSystemId: unlocked.fileSystemId,
        nonce: superblockNonce({ bytes: currentHeader.nonce }),
        publicationSequence: currentHeader.publicationSequence,
        rootKey: unlocked.rootKey,
      });
      const plaintext = decodeSuperblockPlaintext({ bytes: plaintextBytes, flags: currentHeader.flags });
      const replacementHeader = createSuperblockHeader({
        activeCommitSequence: currentHeader.activeCommitSequence,
        copy: currentHeader.copy,
        fileSystemId: currentHeader.fileSystemId,
        flags: currentHeader.flags,
        nonce: Uint8Array.from(
          { length: HIZOFS_V1_FORMAT_CONSTANTS.crypto.nonceBytes },
          (_, index) => 0x30 + physicalCopy * 0x10 + index,
        ),
        publicationSequence: currentHeader.publicationSequence,
      });
      const exactHeader = encodeSuperblockHeader({ header: replacementHeader });
      const ciphertext = await encryptSuperblock({
        copy: replacementHeader.copy,
        exactHeader,
        fileSystemId: unlocked.fileSystemId,
        nonce: superblockNonce({ bytes: replacementHeader.nonce }),
        plaintext: plaintextSuperblockBytes({
          bytes: encodeSuperblockPlaintext({
            flags: replacementHeader.flags,
            plaintext: { ...plaintext, minimumUnlockSequence: advancedFloor },
          }),
        }),
        publicationSequence: replacementHeader.publicationSequence,
        rootKey: unlocked.rootKey,
      });
      const replacement = new Uint8Array(exactHeader.byteLength + ciphertext.byteLength);
      replacement.set(exactHeader, 0);
      replacement.set(ciphertext, exactHeader.byteLength);
      await overwritePersistedFile({ backend, bytes: replacement, path });
    }

    await expect(openAuthenticatedUnlockEnvelopeAuthority({
      backend,
      fileSystemId: unlocked.fileSystemId,
      minimumUnlockSequence: advancedFloor,
      rootKey: unlocked.rootKey,
    })).rejects.toMatchObject({ code: "control_plane_corrupt" });
  } finally {
    unlocked.rootKey.destroy();
  }

  await expect(openFreshReadOnlySession({
    backend,
    expectedFileSystemId: fixture.fileSystemId,
    passphrase: fixture.passphrase,
  })).rejects.toMatchObject({ code: "control_plane_corrupt" });
});

it("fails closed when authenticated Unlock Envelope copies reuse one Unlock Sequence with different credential sets", async () => {
  const fixture = validateFrozenPortableContainerFixture({ fixture: representativeFixtureJson });
  const backend = await restoreFrozenPortableContainer({ fixture });
  const minimumUnlockSequence = createUnlockSequence({ value: 1n });
  const unlocked = await openUnlockEnvelopeCopies({
    backend,
    minimumUnlockSequence,
    passphrase: fixture.passphrase,
  });

  try {
    const authority = await openAuthenticatedUnlockEnvelopeAuthority({
      backend,
      fileSystemId: unlocked.fileSystemId,
      minimumUnlockSequence,
      rootKey: unlocked.rootKey,
    });
    const conflictingCredentialSlots = await prepareAddedPassphraseCredentialSlots({
      authority,
      passphrase: "hizofs-v1-format-tests-conflicting-passphrase",
      randomSource: deterministicConflictRandomSource(),
      rootKey: unlocked.rootKey,
    });

    const copies = await Promise.all(HIZOFS_UNLOCK_ENVELOPE_FILES.map(async (file, physicalCopy) => {
      const path = canonicalContainerPath({ value: file });
      const bytes = await backend.readFileBounded({
        maximumByteLength: HIZOFS_V1_FORMAT_CONSTANTS.limits.unlockEnvelopeJsonBytes,
        path,
      });
      if (bytes === undefined) throw new Error(`expected frozen Unlock Envelope copy: ${file}`);
      const envelope = decodeUnlockEnvelope({ bytes });
      if (envelope.copy !== physicalCopy) throw new Error(`Unlock Envelope copy identity mismatch: ${file}`);
      return { envelope, path };
    }));
    const [target, sibling] = copies;
    if (target === undefined || sibling === undefined) throw new Error("expected both frozen Unlock Envelope copies");

    const nonceBytes = Uint8Array.from({ length: HIZOFS_V1_FORMAT_CONSTANTS.crypto.nonceBytes }, (_, index) => 0x60 + index);
    const unsignedEnvelope = {
      ...target.envelope,
      authenticatorNonce: encodeBase64UrlUnpadded({ bytes: nonceBytes }),
      authenticatorTag: encodeBase64UrlUnpadded({ bytes: new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.crypto.tagBytes) }),
      credentialSlots: conflictingCredentialSlots,
      sequence: sibling.envelope.sequence,
    } satisfies UnlockEnvelopeV1;
    const canonicalUnsignedEnvelopeBytes = encodeUnlockEnvelope({ envelope: unsignedEnvelope, includeAuthenticatorTag: false });
    const tag = await createUnlockAuthenticatorTag({
      canonicalUnsignedEnvelopeBytes,
      copy: unsignedEnvelope.copy,
      fileSystemId: unlocked.fileSystemId,
      nonce: unlockAuthenticatorNonce({ bytes: nonceBytes }),
      rootKey: unlocked.rootKey,
      unlockSequence: createUnlockSequence({ value: BigInt(unsignedEnvelope.sequence) }),
    });
    const conflictingEnvelope = {
      ...unsignedEnvelope,
      authenticatorTag: encodeBase64UrlUnpadded({ bytes: tag }),
    } satisfies UnlockEnvelopeV1;
    await overwritePersistedFile({
      backend,
      bytes: encodeUnlockEnvelope({ envelope: conflictingEnvelope }),
      path: target.path,
    });

    await expect(openUnlockEnvelopeCopies({
      backend,
      minimumUnlockSequence,
      passphrase: fixture.passphrase,
    })).rejects.toMatchObject({ code: "control_plane_corrupt" });
  } finally {
    unlocked.rootKey.destroy();
  }

  await expect(openFreshReadOnlySession({
    backend,
    expectedFileSystemId: fixture.fileSystemId,
    passphrase: fixture.passphrase,
  })).rejects.toMatchObject({ code: "control_plane_corrupt" });
});

it("does not roll back to an older Unlock Envelope when the newest authenticated authority removed the unlocking credential", async () => {
  const fixture = validateFrozenPortableContainerFixture({ fixture: representativeFixtureJson });
  const backend = await restoreFrozenPortableContainer({ fixture });
  const minimumUnlockSequence = createUnlockSequence({ value: 1n });
  const unlocked = await openUnlockEnvelopeCopies({
    backend,
    minimumUnlockSequence,
    passphrase: fixture.passphrase,
  });

  try {
    const authority = await openAuthenticatedUnlockEnvelopeAuthority({
      backend,
      fileSystemId: unlocked.fileSystemId,
      minimumUnlockSequence,
      rootKey: unlocked.rootKey,
    });
    const withAddedCredential = await prepareAddedPassphraseCredentialSlots({
      authority,
      passphrase: "hizofs-v1-format-tests-new-authoritative-passphrase",
      randomSource: deterministicConflictRandomSource(),
      rootKey: unlocked.rootKey,
    });
    const replacementCredential = withAddedCredential.find(candidate =>
      !authority.credentialSlots.some(existing => existing.slotId === candidate.slotId),
    );
    if (replacementCredential === undefined) throw new Error("expected one newly added credential slot");

    const copies = await Promise.all(HIZOFS_UNLOCK_ENVELOPE_FILES.map(async (file, physicalCopy) => {
      const path = canonicalContainerPath({ value: file });
      const bytes = await backend.readFileBounded({
        maximumByteLength: HIZOFS_V1_FORMAT_CONSTANTS.limits.unlockEnvelopeJsonBytes,
        path,
      });
      if (bytes === undefined) throw new Error(`expected frozen Unlock Envelope copy: ${file}`);
      const envelope = decodeUnlockEnvelope({ bytes });
      if (envelope.copy !== physicalCopy) throw new Error(`Unlock Envelope copy identity mismatch: ${file}`);
      return { envelope, path };
    }));
    const [first, second] = copies;
    if (first === undefined || second === undefined) throw new Error("expected both frozen Unlock Envelope copies");
    const target = first.envelope.sequence <= second.envelope.sequence ? first : second;
    const newestSequence = Math.max(first.envelope.sequence, second.envelope.sequence) + 1;
    const nonceBytes = Uint8Array.from(
      { length: HIZOFS_V1_FORMAT_CONSTANTS.crypto.nonceBytes },
      (_, index) => 0x20 + index,
    );
    const unsignedEnvelope = {
      ...target.envelope,
      authenticatorNonce: encodeBase64UrlUnpadded({ bytes: nonceBytes }),
      authenticatorTag: encodeBase64UrlUnpadded({
        bytes: new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.crypto.tagBytes),
      }),
      credentialSlots: [replacementCredential],
      sequence: newestSequence,
    } satisfies UnlockEnvelopeV1;
    const canonicalUnsignedEnvelopeBytes = encodeUnlockEnvelope({
      envelope: unsignedEnvelope,
      includeAuthenticatorTag: false,
    });
    const tag = await createUnlockAuthenticatorTag({
      canonicalUnsignedEnvelopeBytes,
      copy: unsignedEnvelope.copy,
      fileSystemId: unlocked.fileSystemId,
      nonce: unlockAuthenticatorNonce({ bytes: nonceBytes }),
      rootKey: unlocked.rootKey,
      unlockSequence: createUnlockSequence({ value: BigInt(unsignedEnvelope.sequence) }),
    });
    const newestEnvelope = {
      ...unsignedEnvelope,
      authenticatorTag: encodeBase64UrlUnpadded({ bytes: tag }),
    } satisfies UnlockEnvelopeV1;
    await overwritePersistedFile({
      backend,
      bytes: encodeUnlockEnvelope({ envelope: newestEnvelope }),
      path: target.path,
    });
  } finally {
    unlocked.rootKey.destroy();
  }

  await expect(openFreshReadOnlySession({
    backend,
    expectedFileSystemId: fixture.fileSystemId,
    passphrase: fixture.passphrase,
  })).rejects.toMatchObject({ code: "credential_rejected" });
});
