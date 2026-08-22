import { describe, expect, it, vi } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createPhysicalRecordReference,
  createRecordFrameHeader,
  createUInt64,
  decodeFileSystemCommitPayload,
  encodeRecordFrameHeader,
  encodeRelocationIndexPage,
  parseFileSystemId,
  parseSegmentId,
  segmentIdToRelativePath,
  type PhysicalRecordReference,
  type RelocationIndexPage,
} from "@/00-storage/service/hizofs/00-format";
import { createInitialBootstrapSegment } from "@/00-storage/service/hizofs/authenticated-store/bootstrap-segment-store";
import {
  authenticatedHizoFSPhysicalBytes,
  type AuthenticatedHizoFSPhysicalBytes,
} from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import {
  AuthenticatedRelocationPageRecordCache,
  lookupRelocationMapping,
  validateRelocationIndexTree,
  resolveAuthenticatedHomeRecord,
} from "@/00-storage/service/hizofs/authenticated-store/relocation-index-reader";
import {
  encryptRecord,
  generateFileSystemRootKey,
  generateRecordNonce,
  plaintextRecordBytes,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import { canonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";

const KINDS = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;


function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

function segmentId({ seed }: { seed: number }) {
  return parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => seed + index) });
}

function physicalRef({ kind, offset = 64n, seed, frameLength = 96 }: {
  frameLength?: number;
  kind: number;
  offset?: bigint;
  seed: number;
}): PhysicalRecordReference {
  return createPhysicalRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength,
    recordKind: kind,
    segmentId: segmentId({ seed }),
  } });
}

const homeReference = createHomeRecordReference({ fields: {
  byteOffset: createUInt64({ value: 160n }),
  frameLength: 96,
  recordKind: KINDS.file_system_commit,
  segmentId: segmentId({ seed: 1 }),
} });
const mappedReference = physicalRef({ kind: KINDS.file_system_commit, offset: 256n, seed: 2 });
const rootReference = physicalRef({ kind: KINDS.relocation_index_page, seed: 10 });

function pageReader({ pages }: { pages: ReadonlyMap<PhysicalRecordReference, RelocationIndexPage> }) {
  return async ({ physicalReference }: { physicalReference: PhysicalRecordReference }) => {
    const page = pages.get(physicalReference);
    if (page === undefined) throw new Error("unexpected page reference");
    return page;
  };
}


describe("Authenticated Relocation page record cache", () => {
  it("single-flights one identity and returns detached plaintext while retaining one bounded owner", async () => {
    const cache = new AuthenticatedRelocationPageRecordCache({
      policy: { maximumBytes: 256, maximumEntries: 2 },
    });
    const retained = new Uint8Array([1, 2, 3, 4]);
    const load = vi.fn(async () => retained);

    const [first, second] = await Promise.all([
      cache.read({ frameLength: 32, identity: "root|page", load }),
      cache.read({ frameLength: 32, identity: "root|page", load }),
    ]);

    expect(load).toHaveBeenCalledTimes(1);
    expect([...first]).toEqual([1, 2, 3, 4]);
    expect([...second]).toEqual([1, 2, 3, 4]);
    first[0] = 9;
    const third = await cache.read({ frameLength: 32, identity: "root|page", load });
    expect([...third]).toEqual([1, 2, 3, 4]);
    expect(load).toHaveBeenCalledTimes(1);

    cache.dispose();
    expect([...retained]).toEqual([0, 0, 0, 0]);
    await expect(cache.read({ frameLength: 32, identity: "root|page", load })).rejects.toThrow("disposed");
  });

  it("evicts and zeroizes the least-recently-used retained page within both bounds", async () => {
    const cache = new AuthenticatedRelocationPageRecordCache({
      policy: { maximumBytes: 8, maximumEntries: 2 },
    });
    const firstOwned = new Uint8Array([1, 1, 1, 1]);
    const secondOwned = new Uint8Array([2, 2, 2, 2]);
    const thirdOwned = new Uint8Array([3, 3, 3, 3]);

    await cache.read({ frameLength: 4, identity: "root|first", load: async () => firstOwned });
    await cache.read({ frameLength: 4, identity: "root|second", load: async () => secondOwned });
    await cache.read({ frameLength: 4, identity: "root|third", load: async () => thirdOwned });

    expect([...firstOwned]).toEqual([0, 0, 0, 0]);
    expect([...secondOwned]).toEqual([2, 2, 2, 2]);
    expect([...thirdOwned]).toEqual([3, 3, 3, 3]);
    cache.dispose();
    expect([...secondOwned]).toEqual([0, 0, 0, 0]);
    expect([...thirdOwned]).toEqual([0, 0, 0, 0]);
  });
});

describe("Relocation Index lookup", () => {
  it("returns one chain-free physical mapping from a leaf root", async () => {
    const page: RelocationIndexPage = {
      entries: [{
        currentPhysicalRecordRef: mappedReference,
        homeOffset: homeReference.byteOffset,
        homeSegmentId: homeReference.segmentId,
      }],
      level: 0,
      type: "leaf",
    };
    await expect(lookupRelocationMapping({
      homeReference,
      readPage: pageReader({ pages: new Map([[rootReference, page]]) }),
      rootPhysicalReference: rootReference,
    })).resolves.toBe(mappedReference);
  });

  it("returns absent when the Home key is not mapped", async () => {
    const page: RelocationIndexPage = {
      entries: [{
        currentPhysicalRecordRef: mappedReference,
        homeOffset: createUInt64({ value: 64n }),
        homeSegmentId: homeReference.segmentId,
      }],
      level: 0,
      type: "leaf",
    };
    await expect(lookupRelocationMapping({
      homeReference,
      readPage: pageReader({ pages: new Map([[rootReference, page]]) }),
      rootPhysicalReference: rootReference,
    })).resolves.toBeNull();
  });

  it("validates branch levels and exact subtree upper bounds", async () => {
    const childReference = physicalRef({ kind: KINDS.relocation_index_page, seed: 11 });
    const child: RelocationIndexPage = {
      entries: [{
        currentPhysicalRecordRef: mappedReference,
        homeOffset: homeReference.byteOffset,
        homeSegmentId: homeReference.segmentId,
      }],
      level: 0,
      type: "leaf",
    };
    const root: RelocationIndexPage = {
      entries: [{
        childPagePhysicalRef: childReference,
        upperBound: { homeOffset: homeReference.byteOffset, homeSegmentId: homeReference.segmentId },
      }],
      level: 1,
      type: "branch",
    };
    await expect(lookupRelocationMapping({
      homeReference,
      readPage: pageReader({ pages: new Map<PhysicalRecordReference, RelocationIndexPage>([
        [rootReference, root],
        [childReference, child],
      ]) }),
      rootPhysicalReference: rootReference,
    })).resolves.toBe(mappedReference);

    const wrongBoundRoot: RelocationIndexPage = {
      ...root,
      entries: [{
        childPagePhysicalRef: childReference,
        upperBound: { homeOffset: createUInt64({ value: 168n }), homeSegmentId: homeReference.segmentId },
      }],
    };
    await expect(lookupRelocationMapping({
      homeReference,
      readPage: pageReader({ pages: new Map<PhysicalRecordReference, RelocationIndexPage>([
        [rootReference, wrongBoundRoot],
        [childReference, child],
      ]) }),
      rootPhysicalReference: rootReference,
    })).rejects.toThrow("upper bound");
  });

  it("rejects an overlapping key range in an unrelated sibling subtree", async () => {
    const childAReference = physicalRef({ kind: KINDS.relocation_index_page, seed: 11 });
    const childBReference = physicalRef({ kind: KINDS.relocation_index_page, seed: 12 });
    const keySegmentId = segmentId({ seed: 20 });
    const childA: RelocationIndexPage = {
      entries: [{
        currentPhysicalRecordRef: physicalRef({ kind: KINDS.file_system_commit, seed: 30 }),
        homeOffset: createUInt64({ value: 100n }),
        homeSegmentId: keySegmentId,
      }],
      level: 0,
      type: "leaf",
    };
    const childB: RelocationIndexPage = {
      entries: [
        {
          currentPhysicalRecordRef: physicalRef({ kind: KINDS.file_system_commit, seed: 31 }),
          homeOffset: createUInt64({ value: 90n }),
          homeSegmentId: keySegmentId,
        },
        {
          currentPhysicalRecordRef: physicalRef({ kind: KINDS.file_system_commit, seed: 32 }),
          homeOffset: createUInt64({ value: 200n }),
          homeSegmentId: keySegmentId,
        },
      ],
      level: 0,
      type: "leaf",
    };
    const root: RelocationIndexPage = {
      entries: [
        {
          childPagePhysicalRef: childAReference,
          upperBound: { homeOffset: createUInt64({ value: 100n }), homeSegmentId: keySegmentId },
        },
        {
          childPagePhysicalRef: childBReference,
          upperBound: { homeOffset: createUInt64({ value: 200n }), homeSegmentId: keySegmentId },
        },
      ],
      level: 1,
      type: "branch",
    };

    await expect(validateRelocationIndexTree({
      readPage: pageReader({ pages: new Map<PhysicalRecordReference, RelocationIndexPage>([
        [rootReference, root],
        [childAReference, childA],
        [childBReference, childB],
      ]) }),
      rootPhysicalReference: rootReference,
    })).rejects.toThrow("overlapping sibling ranges");
  });

  it("accepts an empty leaf root as a canonical empty mapping", async () => {
    await expect(validateRelocationIndexTree({
      readPage: pageReader({ pages: new Map([[rootReference, { entries: [], level: 0, type: "leaf" }]]) }),
      rootPhysicalReference: rootReference,
    })).resolves.toBeUndefined();
  });

  it("rejects a mapping that changes record kind or frame length", async () => {
    const page: RelocationIndexPage = {
      entries: [{
        currentPhysicalRecordRef: physicalRef({ kind: KINDS.inode_table_page, offset: 256n, seed: 2 }),
        homeOffset: homeReference.byteOffset,
        homeSegmentId: homeReference.segmentId,
      }],
      level: 0,
      type: "leaf",
    };
    await expect(lookupRelocationMapping({
      homeReference,
      readPage: pageReader({ pages: new Map([[rootReference, page]]) }),
      rootPhysicalReference: rootReference,
    })).rejects.toThrow("kind or frame length");
  });

  it("resolves a byte-copied ordinary frame through an authenticated physical-only leaf", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    const path = canonicalContainerPath({ value: segmentIdToRelativePath({
      id: created.activeCommitHomeRef.segmentId,
      segmentClass: "metadata",
    }) });
    const originalSize = await backend.getFileSize({ path });
    if (originalSize === undefined) throw new Error("bootstrap segment disappeared");
    const copiedFrame = await backend.readExact({
      length: created.activeCommitHomeRef.frameLength,
      offset: created.activeCommitHomeRef.byteOffset,
      path,
    });
    const mappedCommitReference = createPhysicalRecordReference({ fields: {
      byteOffset: createUInt64({ value: originalSize }),
      frameLength: created.activeCommitHomeRef.frameLength,
      recordKind: created.activeCommitHomeRef.recordKind,
      segmentId: created.activeCommitHomeRef.segmentId,
    } });
    const pageOffset = originalSize + BigInt(copiedFrame.byteLength);
    const pagePlaintext = encodeRelocationIndexPage({
      isRoot: true,
      page: {
        entries: [{
          currentPhysicalRecordRef: mappedCommitReference,
          homeOffset: created.activeCommitHomeRef.byteOffset,
          homeSegmentId: created.activeCommitHomeRef.segmentId,
        }],
        level: 0,
        type: "leaf",
      },
    });
    const nonce = generateRecordNonce({ randomSource });
    const pageHeader = createRecordFrameHeader({
      flags: HIZOFS_V1_FORMAT_CONSTANTS.flags.recordPhysicalOnly,
      homeOffset: createUInt64({ value: pageOffset }),
      homeSegmentId: created.activeCommitHomeRef.segmentId,
      nonce,
      plaintextLength: pagePlaintext.byteLength,
      recordKind: KINDS.relocation_index_page,
    });
    const pageHeaderBytes = encodeRecordFrameHeader({ header: pageHeader });
    const pageCiphertext = await encryptRecord({
      completeFrameHeader: pageHeaderBytes,
      fileSystemId,
      homeSegmentId: created.activeCommitHomeRef.segmentId,
      nonce,
      plaintext: plaintextRecordBytes({ bytes: pagePlaintext }),
      rootKey,
    });
    const pageFrame = new Uint8Array(pageHeader.frameLength);
    pageFrame.set(pageHeaderBytes);
    pageFrame.set(pageCiphertext, pageHeaderBytes.byteLength);
    const rootPhysicalReference = createPhysicalRecordReference({ fields: {
      byteOffset: pageHeader.homeOffset,
      frameLength: pageHeader.frameLength,
      recordKind: pageHeader.recordKind,
      segmentId: created.activeCommitHomeRef.segmentId,
    } });

    const file = await backend.openFileForUpdate({ path });
    try {
      await backend.writeAt({
        bytes: authenticatedHizoFSPhysicalBytes({ bytes: copiedFrame }),
        file,
        offset: originalSize,
      });
      await backend.writeAt({
        bytes: authenticatedHizoFSPhysicalBytes({ bytes: pageFrame }),
        file,
        offset: pageOffset,
      });
      await backend.syncFileData({ file });
    } finally {
      await backend.closeFile({ file });
    }

    const originalCiphertextOffset = created.activeCommitHomeRef.byteOffset
      + BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordFrameHeader);
    const corruptByte = await backend.readExact({ length: 1, offset: originalCiphertextOffset, path });
    corruptByte[0] = (corruptByte[0] ?? 0) ^ 0xff;
    const corruptingFile = await backend.openFileForUpdate({ path });
    try {
      await backend.writeAt({
        bytes: authenticatedHizoFSPhysicalBytes({ bytes: corruptByte }),
        file: corruptingFile,
        offset: originalCiphertextOffset,
      });
      await backend.syncFileData({ file: corruptingFile });
    } finally {
      await backend.closeFile({ file: corruptingFile });
    }

    const relocationPageRecordCache = new AuthenticatedRelocationPageRecordCache({
      policy: {
        maximumBytes: 2 * HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataPlaintextBytes,
        maximumEntries: 2,
      },
    });
    const readExact = vi.spyOn(backend, "readExact");
    const resolveMappedCommit = async () => await resolveAuthenticatedHomeRecord({
      backend,
      fileSystemId,
      homeReference: created.activeCommitHomeRef,
      relocationIndexRootPhysicalRef: rootPhysicalReference,
      relocationPageRecordCache,
      rootKey,
    });
    const firstResolved = await resolveMappedCommit();
    const secondResolved = await resolveMappedCommit();
    try {
      expect(firstResolved.physicalReference).toEqual(mappedCommitReference);
      expect(secondResolved.physicalReference).toEqual(mappedCommitReference);
      expect(decodeFileSystemCommitPayload({ bytes: firstResolved.plaintext }).commitSequence).toBe(1n);
      expect(decodeFileSystemCommitPayload({ bytes: secondResolved.plaintext }).commitSequence).toBe(1n);
      const relocationPagePhysicalReads = readExact.mock.calls.filter(([request]) => (
        request.offset === rootPhysicalReference.byteOffset
        && request.length === rootPhysicalReference.frameLength
      ));
      expect(relocationPagePhysicalReads).toHaveLength(1);
      expect(backend.openHandleCount()).toBe(0);
    } finally {
      firstResolved.plaintext.fill(0);
      secondResolved.plaintext.fill(0);
      relocationPageRecordCache.dispose();
      rootKey.destroy();
    }
  });

});
