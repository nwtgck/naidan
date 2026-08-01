import { describe, expect, it } from "vitest";
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
  lookupRelocationMapping,
  resolveAuthenticatedHomeRecord,
} from "@/00-storage/service/hizofs/authenticated-store/relocation-index-reader";
import {
  encryptRecord,
  generateFileSystemRootKey,
  generateRecordNonce,
  plaintextRecordBytes,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/crypto";
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

    const resolved = await resolveAuthenticatedHomeRecord({
      backend,
      fileSystemId,
      homeReference: created.activeCommitHomeRef,
      relocationIndexRootPhysicalRef: rootPhysicalReference,
      rootKey,
    });
    expect(resolved.physicalReference).toEqual(mappedCommitReference);
    expect(decodeFileSystemCommitPayload({ bytes: resolved.plaintext }).commitSequence).toBe(1n);
    expect(backend.openHandleCount()).toBe(0);
    rootKey.destroy();
  });

});
