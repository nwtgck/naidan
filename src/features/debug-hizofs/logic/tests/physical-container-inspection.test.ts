import { describe, expect, it } from 'vitest';
import {
  HIZOFS_SUPERBLOCK_FILES,
  HIZOFS_V1_FORMAT_CONSTANTS,
  createFeatureBits,
  decodeSuperblockHeader,
  encodeSuperblockHeader,
  parseFileSystemId,
} from '@/00-storage/service/hizofs/00-format';
import {
  createEmptyEncryptedContainer,
} from '@/00-storage/service/hizofs/authenticated-store/empty-container-store';
import { createAuthenticatedHizoFSInspectionPort } from "@/00-storage/service/hizofs/authenticated-store/inspection-port";
import {
  authenticatedHizoFSPhysicalBytes,
  type AuthenticatedHizoFSPhysicalBytes,
} from '@/00-storage/service/hizofs/authenticated-store/physical-bytes';
import type { RandomByteSource } from '@/00-storage/service/hizofs/01-crypto';
import { canonicalContainerPath } from '@/00-storage/service/hizofs/physical-store/paths';
import { InMemoryCrashDurabilityBackend } from '@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend';
import {
  inspectHizoFSHomeRecord,
  inspectHizoFSPhysicalContainer,
  inspectHizoFSPhysicalRecord,
} from "@/00-storage/service/hizofs/inspection";

const supportedFeatureBits = createFeatureBits({ value: 0n });

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

async function fixture() {
  const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
  const opened = await createEmptyEncryptedContainer({
    backend,
    passphrase: 'correct horse battery staple',
    randomSource: deterministicRandomSource(),
    supportedFeatureBits,
  });
  opened.rootKey.destroy();
  return backend;
}

function propertyNames({ value }: { value: unknown }): readonly string[] {
  const names = new Set<string>();
  const visited = new WeakSet<object>();
  const visit = (current: unknown): void => {
    if (typeof current !== "object" || current === null || visited.has(current)) return;
    visited.add(current);
    for (const [key, nested] of Object.entries(current)) {
      names.add(key);
      visit(nested);
    }
  };
  visit(value);
  return [...names];
}

async function corruptLastByte({ backend, path }: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  path: string;
}): Promise<void> {
  const canonicalPath = canonicalContainerPath({ value: path });
  const bytes = await backend.readFileBounded({ maximumByteLength: 65_536, path: canonicalPath });
  if (bytes === undefined || bytes.byteLength === 0) throw new Error('fixture file is missing');
  const corrupted = Uint8Array.from(bytes);
  const index = corrupted.byteLength - 1;
  const value = corrupted[index];
  if (value === undefined) throw new Error('fixture final byte is missing');
  corrupted[index] = value ^ 1;
  const file = await backend.openFileForUpdate({ path: canonicalPath });
  try {
    await backend.writeAt({ bytes: authenticatedHizoFSPhysicalBytes({ bytes: corrupted }), file, offset: 0n });
    await backend.syncFileData({ file });
  } finally {
    await backend.closeFile({ file });
  }
}

async function replaceSuperblockFileSystemId({ backend, path }: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  path: string;
}): Promise<string> {
  const canonicalPath = canonicalContainerPath({ value: path });
  const bytes = await backend.readFileBounded({
    maximumByteLength: HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockFile,
    path: canonicalPath,
  });
  if (bytes === undefined) throw new Error("fixture Superblock is missing");
  const headerSize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockHeader;
  const header = decodeSuperblockHeader({ bytes: bytes.subarray(0, headerSize) });
  const firstCharacter = header.fileSystemId.startsWith("A") ? "B" : "A";
  const replacementFileSystemId = parseFileSystemId({
    value: `${firstCharacter}${header.fileSystemId.slice(1)}`,
  });
  const changed = Uint8Array.from(bytes);
  changed.set(encodeSuperblockHeader({ header: { ...header, fileSystemId: replacementFileSystemId } }), 0);
  const file = await backend.openFileForUpdate({ path: canonicalPath });
  try {
    await backend.writeAt({ bytes: authenticatedHizoFSPhysicalBytes({ bytes: changed }), file, offset: 0n });
    await backend.syncFileData({ file });
  } finally {
    await backend.closeFile({ file });
  }
  return replacementFileSystemId;
}

describe('HizoFS physical container inspection', () => {
  it('reports physical control copies, the root shortcut, and authenticated segments', async () => {
    const inspection = await inspectHizoFSPhysicalContainer({
      physical: createAuthenticatedHizoFSInspectionPort({ backend: await fixture() }),
      passphrase: 'correct horse battery staple',
      supportedFeatureBits,
    });

    expect(inspection.unlockSelection).toMatchObject({ redundancy: 'normal', state: 'selected' });
    expect(inspection.unlockEnvelopeCopies).toHaveLength(2);
    expect(inspection.unlockEnvelopeCopies.every(copy => copy.state === 'proof_valid')).toBe(true);
    expect(inspection.superblockSelection).toMatchObject({ redundancy: 'normal', state: 'selected' });
    expect(inspection.superblockCopies).toHaveLength(2);
    expect(inspection.superblockCopies.every(copy => copy.state === 'proof_valid')).toBe(true);
    expect(inspection.rootDirectoryShortcut).toMatchObject({
      mode: 'active',
      rootDirectoryInodeNumber: '1',
      state: 'available',
    });
    expect(inspection.segments).toEqual(expect.arrayContaining([
      expect.objectContaining({ segmentClass: 'metadata', state: 'unsealed_complete' }),
    ]));
    expect(inspection.segments.flatMap(segment => segment.frames).length).toBeGreaterThanOrEqual(2);
    expect(inspection.unlockEnvelopeCopies.every(copy => copy.envelope !== undefined)).toBe(true);
    expect(inspection.unlockEnvelopeCopies[0]?.envelope?.authenticatorTag).toBeTypeOf("string");
    expect(inspection.unlockEnvelopeCopies[0]?.envelope?.credentialSlots[0]?.wrappedFileSystemRootKey).toBeTypeOf("string");
    expect(inspection.superblockCopies.every(copy => copy.header !== undefined && copy.plaintext !== undefined)).toBe(true);
    expect(inspection.superblockCopies[0]?.header?.nonce).toBeInstanceOf(Uint8Array);
    expect(propertyNames({ value: inspection })).not.toContain("passphrase");
    expect(propertyNames({ value: inspection })).not.toContain("rootKey");
  });

  it("retains a decoded Superblock header when later structural validation rejects the copy", async () => {
    const backend = await fixture();
    const replacementFileSystemId = await replaceSuperblockFileSystemId({
      backend,
      path: HIZOFS_SUPERBLOCK_FILES[0],
    });
    const inspection = await inspectHizoFSPhysicalContainer({
      physical: createAuthenticatedHizoFSInspectionPort({ backend }),
      passphrase: "correct horse battery staple",
      supportedFeatureBits,
    });
    const rejectedCopy = inspection.superblockCopies.find(copy => copy.copy === 0);
    expect(rejectedCopy).toMatchObject({
      activeCommitSequence: expect.any(String),
      publicationSequence: expect.any(String),
      selected: false,
      state: "structurally_invalid",
    });
    expect(rejectedCopy?.header?.fileSystemId).toBe(replacementFileSystemId);
    expect(rejectedCopy?.plaintext).toBeUndefined();
    expect(rejectedCopy?.reason).toContain("does not match the unlocked container");
  });

  it('preserves a proof-invalid sibling while selecting the surviving Superblock', async () => {
    const backend = await fixture();
    await corruptLastByte({ backend, path: HIZOFS_SUPERBLOCK_FILES[0] });
    const inspection = await inspectHizoFSPhysicalContainer({
      physical: createAuthenticatedHizoFSInspectionPort({ backend }),
      passphrase: 'correct horse battery staple',
      supportedFeatureBits,
    });
    expect(inspection.superblockSelection).toMatchObject({ redundancy: 'degraded', state: 'selected' });
    expect(inspection.superblockCopies).toContainEqual(expect.objectContaining({
      copy: 0,
      reason: 'Superblock authentication failed',
      selected: false,
      state: 'proof_invalid',
    }));
    expect(inspection.superblockCopies).toContainEqual(expect.objectContaining({
      copy: 1,
      selected: true,
      state: 'proof_valid',
    }));
  });

  it('reports structurally visible Unlock Envelopes without decrypting data for a wrong passphrase', async () => {
    const inspection = await inspectHizoFSPhysicalContainer({
      physical: createAuthenticatedHizoFSInspectionPort({ backend: await fixture() }),
      passphrase: 'wrong passphrase',
      supportedFeatureBits,
    });
    expect(inspection.unlockSelection).toMatchObject({ code: 'credential_rejected', state: 'rejected' });
    expect(inspection.unlockEnvelopeCopies.every(copy => copy.state === 'proof_unresolved')).toBe(true);
    expect(inspection.superblockCopies).toEqual([]);
    expect(inspection.segments).toEqual([]);
    expect(inspection.rootDirectoryShortcut).toBeUndefined();
  });

  it('authenticates a selected physical frame and returns only a bounded plaintext preview', async () => {
    const backend = await fixture();
    const basePhysical = createAuthenticatedHizoFSInspectionPort({ backend });
    let decryptedPlaintext: Uint8Array | undefined;
    const physical = {
      ...basePhysical,
      readPhysicalRecord: async (args: Parameters<typeof basePhysical.readPhysicalRecord>[0]) => {
        const result = await basePhysical.readPhysicalRecord(args);
        decryptedPlaintext = result.plaintext;
        return result;
      },
    };
    const container = await inspectHizoFSPhysicalContainer({
      passphrase: 'correct horse battery staple',
      physical,
      supportedFeatureBits,
    });
    const segment = container.segments.find(candidate => candidate.frames.length > 0);
    const frame = segment?.frames[0];
    if (segment?.physicalSegmentId === undefined || frame === undefined) {
      throw new Error('fixture authenticated frame is missing');
    }
    const record = await inspectHizoFSPhysicalRecord({
      maximumPreviewBytes: 8,
      passphrase: 'correct horse battery staple',
      physical,
      request: {
        frameLength: frame.frameLength,
        homeOffset: frame.homeOffset,
        homeSegmentId: frame.homeSegmentId,
        pageIsRoot: true,
        physicalOffset: frame.physicalOffset,
        physicalSegmentId: segment.physicalSegmentId,
        recordKind: frame.recordKind,
      },
      supportedFeatureBits,
    });
    expect(record.recordKindName).toBe('inode_table_page');
    expect(record.plaintextByteLength).toBeGreaterThan(8);
    expect(record.plaintextPreviewByteLength).toBe(8);
    expect(record.plaintextPreviewTruncated).toBe(true);
    expect(record.plaintextPreviewBase64Url.length).toBeGreaterThan(0);
    expect(record.payload).toMatchObject({
      family: 'inode_table',
      isRoot: true,
      pageType: 'leaf',
      state: 'decoded',
    });
    expect(decryptedPlaintext).toBeDefined();
    expect(decryptedPlaintext?.every(value => value === 0)).toBe(true);
  });

  it('requires explicit page role context without guessing it from valid bytes', async () => {
    const backend = await fixture();
    const physical = createAuthenticatedHizoFSInspectionPort({ backend });
    const container = await inspectHizoFSPhysicalContainer({
      passphrase: 'correct horse battery staple',
      physical,
    });
    const frame = container.segments.flatMap(segment => segment.frames)
      .find(candidate => candidate.recordKind === HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page);
    const segment = container.segments.find(candidate => candidate.frames.includes(frame!));
    expect(frame).toBeDefined();
    expect(segment?.physicalSegmentId).toBeDefined();
    const request = {
      frameLength: frame!.frameLength,
      homeOffset: frame!.homeOffset,
      homeSegmentId: frame!.homeSegmentId,
      physicalOffset: frame!.physicalOffset,
      physicalSegmentId: segment!.physicalSegmentId!,
      recordKind: frame!.recordKind,
    };

    const withoutRole = await inspectHizoFSPhysicalRecord({
      passphrase: 'correct horse battery staple',
      physical,
      request,
    });
    expect(withoutRole.payload).toEqual({ family: 'inode_table', state: 'page_role_required' });

    const explicitNonRoot = await inspectHizoFSPhysicalRecord({
      passphrase: 'correct horse battery staple',
      physical,
      request: { ...request, pageIsRoot: false },
    });
    expect(explicitNonRoot.payload).toMatchObject({ isRoot: false, state: 'decoded' });
  });

  it('resolves a Home Reference through the authoritative relocation root', async () => {
    const physical = createAuthenticatedHizoFSInspectionPort({ backend: await fixture() });
    const container = await inspectHizoFSPhysicalContainer({
      passphrase: 'correct horse battery staple',
      physical,
    });
    expect(container.rootDirectoryShortcut?.state).toBe('available');
    const shortcut = container.rootDirectoryShortcut;
    if (shortcut?.state !== 'available') throw new Error('root shortcut is unavailable');

    const record = await inspectHizoFSHomeRecord({
      passphrase: 'correct horse battery staple',
      physical,
      request: {
        frameLength: shortcut.activeCommit.frameLength,
        homeOffset: shortcut.activeCommit.byteOffset,
        homeSegmentId: shortcut.activeCommit.segmentId,
        recordKind: shortcut.activeCommit.recordKind,
      },
    });
    expect(record.payload).toMatchObject({
      commitSequence: shortcut.commitSequence,
      kind: 'file_system_commit',
      rootDirectoryInodeNumber: shortcut.rootDirectoryInodeNumber,
      state: 'decoded',
    });
  });

  it('rejects an unbounded total frame inventory before mapping frame DTOs', async () => {
    await expect(inspectHizoFSPhysicalContainer({
      maximumFrames: 1,
      passphrase: 'correct horse battery staple',
      physical: createAuthenticatedHizoFSInspectionPort({ backend: await fixture() }),
    })).rejects.toThrow('physical frame count exceeds the Inspector bound');
  });

  it('rejects an unbounded physical segment inventory before accumulating it', async () => {
    await expect(inspectHizoFSPhysicalContainer({
      physical: createAuthenticatedHizoFSInspectionPort({ backend: await fixture() }),
      maximumSegments: 0,
      passphrase: 'correct horse battery staple',
      supportedFeatureBits,
    })).rejects.toThrow('maximumSegments must be a positive safe integer');
  });
});
