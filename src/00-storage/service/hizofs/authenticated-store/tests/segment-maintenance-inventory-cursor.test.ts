import { describe, expect, it, vi } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseFileSystemId,
  parseSegmentId,
  segmentIdToLowercaseHex,
  segmentIdToRelativePath,
  segmentIdToShard,
  type SegmentClass,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import {
  TEST_ONLY,
  type AuthenticatedSegmentMaintenanceInventoryBackend,
} from "@/00-storage/service/hizofs/authenticated-store/segment-maintenance-inventory-cursor";
import { parseBoundSegmentMaintenanceSegmentId } from "@/00-storage/service/hizofs/authenticated-store/segment-maintenance-descriptor";
import { generateFileSystemRootKey } from "@/00-storage/service/hizofs/01-crypto";
import { createCandidateFrameOrdinalAuthority } from "@/00-storage/service/hizofs/authenticated-store/candidate-frame-ordinal-authority";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import {
  canonicalContainerDirectory,
  canonicalContainerPath,
} from "@/00-storage/service/hizofs/physical-store/paths";

function segmentId({ seed }: { seed: number }): SegmentId {
  return parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => (seed + index) & 0xff) });
}

function fixture() {
  return {
    backend: new InMemoryCrashDurabilityBackend<Uint8Array>({}),
    diagnostics: undefined,
    fileSystemId: parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" }),
    rootKey: generateFileSystemRootKey({ randomSource: ({ bytes }) => bytes.fill(9) }),
  };
}

async function createDirectory({ backend, value }: {
  backend: InMemoryCrashDurabilityBackend<Uint8Array>;
  value: string;
}): Promise<void> {
  await backend.createDirectoryExclusive({ path: canonicalContainerDirectory({ value }) });
}

async function createSegmentFile({ backend, id, segmentClass }: {
  backend: InMemoryCrashDurabilityBackend<Uint8Array>;
  id: SegmentId;
  segmentClass: SegmentClass;
}): Promise<void> {
  const path = canonicalContainerPath({ value: segmentIdToRelativePath({ id, segmentClass }) });
  const file = await backend.createFileExclusive({ path });
  await backend.closeFile({ file });
}

async function createSegmentTree({ backend, entries }: {
  backend: InMemoryCrashDurabilityBackend<Uint8Array>;
  entries: readonly Readonly<{ id: SegmentId; segmentClass: SegmentClass }>[];
}): Promise<void> {
  await createDirectory({ backend, value: "segments" });
  const classes = new Set(entries.map(entry => entry.segmentClass));
  for (const segmentClass of classes) {
    await createDirectory({ backend, value: `segments/${segmentClass}` });
    const shards = new Set(entries
      .filter(entry => entry.segmentClass === segmentClass)
      .map(entry => segmentIdToShard({ id: entry.id })));
    for (const shard of shards) await createDirectory({ backend, value: `segments/${segmentClass}/${shard}` });
  }
  for (const entry of entries) await createSegmentFile({ backend, ...entry });
}

type TestDescriptorReader = Parameters<
  typeof TEST_ONLY.createAuthenticatedSegmentMaintenanceInventoryCursorWithReader
>[0]["descriptorReader"];

function descriptorReader({ excludedIds = new Set<string>() }: { excludedIds?: ReadonlySet<string> } = {}) {
  const reader: TestDescriptorReader = async ({ directory, entry, segmentClass }) => {
    const id = parseBoundSegmentMaintenanceSegmentId({ directory, entry, segmentClass });
    if (excludedIds.has(segmentIdToLowercaseHex({ id }))) {
      return { reason: "complete_unsealed", type: "excluded" };
    }
    return {
      descriptor: {
        frameCount: 1,
        frameOrdinalAuthority: createCandidateFrameOrdinalAuthority({
          frames: [{
            frameLength: 128,
            physicalOffset: 64n,
            recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
          }],
          segmentId: id,
        }),
        ownership: "sealed",
        segmentId: Uint8Array.from(id) as SegmentId,
        totalFrameBytes: 128,
      },
      type: "eligible",
    };
  };
  return vi.fn(reader);
}

async function readAll({ cursor, maximumEntries }: {
  cursor: ReturnType<typeof TEST_ONLY.createAuthenticatedSegmentMaintenanceInventoryCursorWithReader>;
  maximumEntries: number;
}) {
  const descriptors = [];
  const exclusions = [];
  const pages = [];
  while (true) {
    const page = await cursor.read({ maximumEntries });
    pages.push(page);
    descriptors.push(...page.descriptors);
    exclusions.push(...page.exclusions);
    if (page.done) return { descriptors, exclusions, pages };
  }
}

describe("authenticated Segment maintenance inventory cursor", () => {
  it("traverses canonical class and shard directories through bounded resumable pages", async () => {
    const value = fixture();
    const metadataId = segmentId({ seed: 1 });
    const dataId = segmentId({ seed: 40 });
    const excludedId = segmentId({ seed: 80 });
    await createSegmentTree({
      backend: value.backend,
      entries: [
        { id: metadataId, segmentClass: "metadata" },
        { id: dataId, segmentClass: "data" },
        { id: excludedId, segmentClass: "metadata" },
      ],
    });
    const readDescriptor = descriptorReader({
      excludedIds: new Set([segmentIdToLowercaseHex({ id: excludedId })]),
    });
    const cursor = TEST_ONLY.createAuthenticatedSegmentMaintenanceInventoryCursorWithReader({
      ...value,
      descriptorReader: readDescriptor,
    });

    const result = await readAll({ cursor, maximumEntries: 2 });

    expect(result.pages.every(page => page.scannedEntries <= 2)).toBe(true);
    expect(result.pages.at(-1)?.done).toBe(true);
    expect(result.descriptors.map(entry => ({
      id: segmentIdToLowercaseHex({ id: entry.descriptor.segmentId }),
      segmentClass: entry.segmentClass,
    })).sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: segmentIdToLowercaseHex({ id: metadataId }), segmentClass: "metadata" },
      { id: segmentIdToLowercaseHex({ id: dataId }), segmentClass: "data" },
    ].sort((left, right) => left.id.localeCompare(right.id)));
    expect(result.exclusions).toEqual([{
      reason: "complete_unsealed",
      segmentClass: "metadata",
      segmentId: excludedId,
    }]);
    expect(readDescriptor).toHaveBeenCalledTimes(3);
    expect(await cursor.read({ maximumEntries: 1 })).toEqual({
      descriptors: [],
      done: true,
      exclusions: [],
      scannedEntries: 0,
    });
    await cursor.close();
  });

  it("rejects unknown root entries and noncanonical shard names instead of treating them as candidates", async () => {
    const unknownRoot = fixture();
    await createDirectory({ backend: unknownRoot.backend, value: "segments" });
    await createDirectory({ backend: unknownRoot.backend, value: "segments/unknown" });
    await expect(readAll({
      cursor: TEST_ONLY.createAuthenticatedSegmentMaintenanceInventoryCursorWithReader({
        ...unknownRoot,
        descriptorReader: descriptorReader(),
      }),
      maximumEntries: 8,
    })).rejects.toMatchObject({ code: "invalid_inventory_entry" });

    const invalidShard = fixture();
    await createDirectory({ backend: invalidShard.backend, value: "segments" });
    await createDirectory({ backend: invalidShard.backend, value: "segments/metadata" });
    await createDirectory({ backend: invalidShard.backend, value: "segments/metadata/AF" });
    await expect(readAll({
      cursor: TEST_ONLY.createAuthenticatedSegmentMaintenanceInventoryCursorWithReader({
        ...invalidShard,
        descriptorReader: descriptorReader(),
      }),
      maximumEntries: 8,
    })).rejects.toThrow("two lowercase hexadecimal digits");
  });

  it("rejects one Segment ID appearing in both classes before authenticated classification", async () => {
    const value = fixture();
    const duplicateId = segmentId({ seed: 120 });
    await createSegmentTree({
      backend: value.backend,
      entries: [
        { id: duplicateId, segmentClass: "data" },
        { id: duplicateId, segmentClass: "metadata" },
      ],
    });
    const readDescriptor = descriptorReader();
    await expect(readAll({
      cursor: TEST_ONLY.createAuthenticatedSegmentMaintenanceInventoryCursorWithReader({
        ...value,
        descriptorReader: readDescriptor,
      }),
      maximumEntries: 8,
    })).rejects.toMatchObject({
      code: "duplicate_segment_identity",
      name: "AuthenticatedSegmentMaintenanceInventoryError",
    });
    expect(readDescriptor).not.toHaveBeenCalled();
  });

  it("preserves authenticated classification and cursor-cleanup failures in operation order", async () => {
    const value = fixture();
    const id = segmentId({ seed: 200 });
    const relativePath = segmentIdToRelativePath({ id, segmentClass: "metadata" });
    const [, className, shardName, fileName] = relativePath.split("/");
    if (className === undefined || shardName === undefined || fileName === undefined) {
      throw new Error("canonical Segment path fixture is incomplete");
    }
    const primaryFailure = new Error("authenticated classification failed");
    const cleanupFailure = new Error("shard cursor close failed");
    const rootClose = vi.fn(async () => undefined);
    const classClose = vi.fn(async () => undefined);
    const shardClose = vi.fn(async () => {
      throw cleanupFailure;
    });
    const onePageCursor = ({ close, entry }: {
      close: () => Promise<void>;
      entry: { byteLength?: bigint; kind: "directory" | "file"; name: string };
    }) => ({
      close,
      read: vi.fn(async () => ({
        done: true,
        entries: [entry.kind === "directory"
          ? { kind: "directory" as const, name: entry.name }
          : { byteLength: entry.byteLength ?? 0n, kind: "file" as const, name: entry.name }],
      })),
    });
    const rootCursor = onePageCursor({ close: rootClose, entry: { kind: "directory", name: className } });
    const classCursor = onePageCursor({ close: classClose, entry: { kind: "directory", name: shardName } });
    const shardCursor = onePageCursor({
      close: shardClose,
      entry: { byteLength: 1n, kind: "file", name: fileName },
    });
    const backend: AuthenticatedSegmentMaintenanceInventoryBackend = {
      getFileSize: async () => undefined,
      list: async () => [],
      openDirectoryCursor: async ({ directory }) => {
        if (directory === "segments") return rootCursor;
        if (directory === `segments/${className}`) return classCursor;
        if (directory === `segments/${className}/${shardName}`) return shardCursor;
        throw new Error(`unexpected directory: ${directory}`);
      },
      readExact: async () => new Uint8Array(),
      readFileBounded: async () => undefined,
    };
    const cursor = TEST_ONLY.createAuthenticatedSegmentMaintenanceInventoryCursorWithReader({
      backend,
      descriptorReader: async () => {
        throw primaryFailure;
      },
      diagnostics: undefined,
      fileSystemId: value.fileSystemId,
      rootKey: value.rootKey,
    });

    await expect(cursor.read({ maximumEntries: 8 })).rejects.toMatchObject({
      errors: [primaryFailure, cleanupFailure],
      name: "AggregateError",
    });
    expect(shardClose).toHaveBeenCalledOnce();
    expect(classClose).toHaveBeenCalledOnce();
    expect(rootClose).toHaveBeenCalledOnce();
    await expect(cursor.read({ maximumEntries: 1 })).rejects.toThrow("cursor is closed");
  });

  it("closes a partially traversed cursor and rejects later reads", async () => {
    const value = fixture();
    await createSegmentTree({
      backend: value.backend,
      entries: [{ id: segmentId({ seed: 160 }), segmentClass: "metadata" }],
    });
    const cursor = TEST_ONLY.createAuthenticatedSegmentMaintenanceInventoryCursorWithReader({
      ...value,
      descriptorReader: descriptorReader(),
    });
    expect((await cursor.read({ maximumEntries: 1 })).done).toBe(false);
    await cursor.close();
    await cursor.close();
    await expect(cursor.read({ maximumEntries: 1 })).rejects.toThrow("cursor is closed");
  });

  it("rejects invalid page bounds before opening physical cursors", async () => {
    const value = fixture();
    const cursor = TEST_ONLY.createAuthenticatedSegmentMaintenanceInventoryCursorWithReader({
      ...value,
      descriptorReader: descriptorReader(),
    });
    await expect(cursor.read({ maximumEntries: 0 })).rejects.toThrow("positive safe integer");
    await cursor.close();
  });
});
