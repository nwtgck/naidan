import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createPhysicalRecordReference,
  createRecordFrameHeader,
  createUInt64,
  encodeRecordFrameHeader,
  parseSegmentId,
  type HomeRecordReference,
  type PhysicalRecordReference,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import {
  CompactionCopyCursor,
  CompactionCopyCursorError,
} from "@/00-storage/service/hizofs/maintenance/compaction-copy-cursor";
import { createMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";

const KINDS = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;

function segmentId({ seed }: { seed: number }): SegmentId {
  return parseSegmentId({ bytes: new Uint8Array(16).fill(seed) });
}

function homeReference({ kind = KINDS.inode_table_page, offset = 64n, seed = 1 }: {
  kind?: number;
  offset?: bigint;
  seed?: number;
} = {}): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: kind,
    segmentId: segmentId({ seed }),
  } });
}

function physicalReference({ home, offset = 64n, seed }: {
  home: HomeRecordReference;
  offset?: bigint;
  seed: number;
}): PhysicalRecordReference {
  return createPhysicalRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: home.frameLength,
    recordKind: home.recordKind,
    segmentId: segmentId({ seed }),
  } });
}

function frameBytes({ home, fill }: { fill: number; home: HomeRecordReference }): Uint8Array {
  const header = createRecordFrameHeader({
    flags: 0,
    homeOffset: home.byteOffset,
    homeSegmentId: home.segmentId,
    nonce: new Uint8Array(12).fill(fill),
    plaintextLength: 16,
    recordKind: home.recordKind,
  });
  const bytes = new Uint8Array(header.frameLength);
  bytes.set(encodeRecordFrameHeader({ header }));
  bytes.fill(fill, HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordFrameHeader);
  return bytes;
}

function clock(): () => number {
  let value = 0;
  return () => value++;
}

describe("compaction copy cursor", () => {
  it("copies ordinary frames byte-for-byte and returns detached relocation mappings", async () => {
    const home = homeReference();
    const source = physicalReference({ home, seed: 2 });
    const destination = physicalReference({ home, offset: 160n, seed: 3 });
    const sourceBytes = frameBytes({ fill: 7, home });
    let appended: Uint8Array | undefined;
    const cursor = new CompactionCopyCursor({
      entries: [{ homeReference: home, sourcePhysicalReference: source }],
      policy: createMaintenancePolicy(),
    });

    const result = await cursor.runSlice({
      appendExactFrame: async ({ bytes }) => {
        appended = Uint8Array.from(bytes);
        return destination;
      },
      hasForegroundWaiter: () => false,
      now: clock(),
      readExactFrame: async () => Uint8Array.from(sourceBytes),
      signal: undefined,
    });

    expect(result).toMatchObject({ phase: "completed" });
    if (result.phase !== "completed") throw new Error("expected completed copy");
    expect(appended).toEqual(sourceBytes);
    expect(result.mappings).toEqual([{ destinationPhysicalReference: destination, homeReference: home }]);
    sourceBytes.fill(0);
    expect(appended?.some(byte => byte !== 0)).toBe(true);
    expect(result.mappings[0]?.destinationPhysicalReference.segmentId).not.toBe(destination.segmentId);
  });

  it("yields before exceeding the per-slice byte budget and resumes without recopying", async () => {
    const firstHome = homeReference({ offset: 64n, seed: 1 });
    const secondHome = homeReference({ offset: 160n, seed: 2 });
    const reads: bigint[] = [];
    const cursor = new CompactionCopyCursor({
      entries: [
        { homeReference: firstHome, sourcePhysicalReference: physicalReference({ home: firstHome, seed: 11 }) },
        { homeReference: secondHome, sourcePhysicalReference: physicalReference({ home: secondHome, seed: 12 }) },
      ],
      policy: createMaintenancePolicy({ maxCompactionBytesPerSlice: 96 }),
    });
    const run = () => cursor.runSlice({
      appendExactFrame: async ({ homeReference }) => physicalReference({ home: homeReference, offset: 256n, seed: Number(homeReference.byteOffset / 8n) }),
      hasForegroundWaiter: () => false,
      now: clock(),
      readExactFrame: async ({ physicalReference: source }) => {
        reads.push(source.byteOffset);
        return frameBytes({ fill: Number(source.byteOffset / 8n), home: source.recordKind === firstHome.recordKind && source.frameLength === firstHome.frameLength
          ? (source.segmentId[0] === 11 ? firstHome : secondHome)
          : firstHome });
      },
      signal: undefined,
    });

    await expect(run()).resolves.toEqual({ phase: "copying", reason: "slice_byte_limit" });
    const completed = await run();
    expect(completed.phase).toBe("completed");
    expect(reads).toHaveLength(2);
  });

  it("yields to foreground work before starting another frame", async () => {
    const home = homeReference();
    const cursor = new CompactionCopyCursor({
      entries: [{ homeReference: home, sourcePhysicalReference: physicalReference({ home, seed: 2 }) }],
      policy: createMaintenancePolicy(),
    });
    await expect(cursor.runSlice({
      appendExactFrame: async () => physicalReference({ home, seed: 3 }),
      hasForegroundWaiter: () => true,
      now: clock(),
      readExactFrame: async () => frameBytes({ fill: 1, home }),
      signal: undefined,
    })).resolves.toEqual({ phase: "copying", reason: "foreground_waiter" });
  });

  it("fails closed when bytes, authenticated identity, or append result are inconsistent", async () => {
    const home = homeReference();
    const source = physicalReference({ home, seed: 2 });
    const wrongHome = homeReference({ offset: 160n, seed: 9 });
    const cursor = new CompactionCopyCursor({
      entries: [{ homeReference: home, sourcePhysicalReference: source }],
      policy: createMaintenancePolicy(),
    });
    const result = await cursor.runSlice({
      appendExactFrame: async () => physicalReference({ home, seed: 3 }),
      hasForegroundWaiter: () => false,
      now: clock(),
      readExactFrame: async () => frameBytes({ fill: 1, home: wrongHome }),
      signal: undefined,
    });
    expect(result).toMatchObject({ phase: "aborted", reason: "copy_failed" });
  });

  it("detects an adapter that mutates the supplied exact frame bytes", async () => {
    const home = homeReference();
    const cursor = new CompactionCopyCursor({
      entries: [{ homeReference: home, sourcePhysicalReference: physicalReference({ home, seed: 2 }) }],
      policy: createMaintenancePolicy(),
    });
    const result = await cursor.runSlice({
      appendExactFrame: async ({ bytes }) => {
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
        return physicalReference({ home, seed: 3 });
      },
      hasForegroundWaiter: () => false,
      now: clock(),
      readExactFrame: async () => frameBytes({ fill: 1, home }),
      signal: undefined,
    });
    expect(result).toMatchObject({ phase: "aborted", reason: "copy_failed" });
  });

  it("rejects relocation pages, duplicate Home identities, and frames larger than the slice budget", () => {
    const ordinary = homeReference();
    expect(() => new CompactionCopyCursor({
      entries: [
        { homeReference: ordinary, sourcePhysicalReference: physicalReference({ home: ordinary, seed: 2 }) },
        { homeReference: ordinary, sourcePhysicalReference: physicalReference({ home: ordinary, seed: 3 }) },
      ],
      policy: createMaintenancePolicy(),
    })).toThrowError(CompactionCopyCursorError);
    const relocation = homeReference({ kind: KINDS.relocation_index_page });
    expect(() => new CompactionCopyCursor({
      entries: [{ homeReference: relocation, sourcePhysicalReference: physicalReference({ home: relocation, seed: 2 }) }],
      policy: createMaintenancePolicy(),
    })).toThrowError(CompactionCopyCursorError);
    expect(() => new CompactionCopyCursor({
      entries: [{ homeReference: ordinary, sourcePhysicalReference: physicalReference({ home: ordinary, seed: 2 }) }],
      policy: createMaintenancePolicy({ maxCompactionBytesPerSlice: 95 }),
    })).toThrowError(CompactionCopyCursorError);
  });
});
