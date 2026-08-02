import { describe, expect, it, vi } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createRecordFrameHeader,
  createUInt64,
  parseFileSystemId,
  parseSegmentId,
  segmentIdToRelativePath,
  type SegmentClass,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import {
  AuthenticatedSegmentMaintenanceDescriptorError,
  TEST_ONLY,
} from "@/00-storage/service/hizofs/authenticated-store/segment-maintenance-descriptor";
import type { AuthenticatedSegmentIndex } from "@/00-storage/service/hizofs/authenticated-store/segment-footer-store";
import { generateFileSystemRootKey } from "@/00-storage/service/hizofs/01-crypto";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import {
  canonicalContainerDirectory,
  canonicalContainerPath,
  containerEntryName,
  parentContainerDirectory,
} from "@/00-storage/service/hizofs/physical-store/paths";

function segmentId({ seed }: { seed: number }): SegmentId {
  return parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => (seed + index) & 0xff) });
}

function frame({ id, plaintextLength }: { id: SegmentId; plaintextLength: number }) {
  return Object.freeze({
    header: createRecordFrameHeader({
      flags: 0,
      homeOffset: createUInt64({ value: 64n }),
      homeSegmentId: id,
      nonce: new Uint8Array(12).fill(7),
      plaintextLength,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    }),
    physicalOffset: 64n,
  });
}

function boundEntry({ id, segmentClass }: { id: SegmentId; segmentClass: SegmentClass }) {
  const path = canonicalContainerPath({ value: segmentIdToRelativePath({ id, segmentClass }) });
  return {
    directory: parentContainerDirectory({ path }),
    entry: { byteLength: 512n, kind: "file" as const, name: containerEntryName({ path }) },
  };
}

function fixture({ id = segmentId({ seed: 1 }), segmentClass = "metadata" as const } = {}) {
  return {
    backend: new InMemoryCrashDurabilityBackend<Uint8Array>({}),
    diagnostics: undefined,
    fileSystemId: parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" }),
    id,
    rootKey: generateFileSystemRootKey({ randomSource: ({ bytes }) => bytes.fill(9) }),
    segmentClass,
    ...boundEntry({ id, segmentClass }),
  };
}

function index({ id, state, lengths = [16, 48] }: {
  id: SegmentId;
  lengths?: readonly number[];
  state: AuthenticatedSegmentIndex["state"];
}): AuthenticatedSegmentIndex {
  return {
    footer: undefined,
    frames: lengths.map((plaintextLength, ordinal) => ({
      ...frame({ id, plaintextLength }),
      physicalOffset: 64n + BigInt(ordinal * 128),
    })),
    state,
  };
}

describe("authenticated Segment maintenance descriptor", () => {
  it("creates a detached descriptor only from an authenticated eligible Segment summary", async () => {
    const value = fixture();
    const authenticated = index({ id: value.id, state: "sealed" });
    const readSegmentIndex = vi.fn(async () => authenticated);

    const result = await TEST_ONLY.readAuthenticatedSegmentMaintenanceDescriptorWithReader({
      ...value,
      readSegmentIndex,
    });

    expect(result).toMatchObject({
      descriptor: {
        frameCount: 2,
        ownership: "sealed",
        segmentId: value.id,
        totalFrameBytes: authenticated.frames.reduce((total, entry) => total + entry.header.frameLength, 0),
      },
      type: "eligible",
    });
    expect(readSegmentIndex).toHaveBeenCalledOnce();
    if (result.type !== "eligible") throw new Error("eligible descriptor invariant failed");
    expect([...result.descriptor.frameOrdinalAuthority.copyPhysicalOffsets()]).toEqual([64, 192]);
    expect([...result.descriptor.frameOrdinalAuthority.copyFrameLengths()])
      .toEqual(authenticated.frames.map(frame => frame.header.frameLength));
    expect([...result.descriptor.frameOrdinalAuthority.copyRecordKinds()])
      .toEqual(authenticated.frames.map(frame => frame.header.recordKind));
    expect(result.descriptor.segmentId).not.toBe(value.id);
  });

  it.each(["abandoned_unsealed", "footer_unusable"] as const)("accepts authenticated %s ownership", async state => {
    const value = fixture();
    await expect(TEST_ONLY.readAuthenticatedSegmentMaintenanceDescriptorWithReader({
      ...value,
      readSegmentIndex: async () => index({ id: value.id, state }),
    })).resolves.toMatchObject({ descriptor: { ownership: state }, type: "eligible" });
  });

  it("excludes complete unsealed and empty artifacts from automatic maintenance candidates", async () => {
    const value = fixture();
    await expect(TEST_ONLY.readAuthenticatedSegmentMaintenanceDescriptorWithReader({
      ...value,
      readSegmentIndex: async () => index({ id: value.id, state: "complete_unsealed" }),
    })).resolves.toEqual({ reason: "complete_unsealed", type: "excluded" });
    await expect(TEST_ONLY.readAuthenticatedSegmentMaintenanceDescriptorWithReader({
      ...value,
      readSegmentIndex: async () => index({ id: value.id, lengths: [], state: "abandoned_unsealed" }),
    })).resolves.toEqual({ reason: "empty_artifact", type: "excluded" });
  });

  it("rejects a filename bound to the wrong class or shard before reading authenticated bytes", async () => {
    const value = fixture();
    const dataPath = canonicalContainerPath({ value: segmentIdToRelativePath({ id: value.id, segmentClass: "data" }) });
    const readSegmentIndex = vi.fn(async () => index({ id: value.id, state: "sealed" }));
    await expect(TEST_ONLY.readAuthenticatedSegmentMaintenanceDescriptorWithReader({
      ...value,
      directory: parentContainerDirectory({ path: dataPath }),
      readSegmentIndex,
    })).rejects.toMatchObject({ code: "invalid_segment_path" });
    expect(readSegmentIndex).not.toHaveBeenCalled();
  });

  it("rejects non-file shard entries and malformed filenames before authentication", async () => {
    const value = fixture();
    const readSegmentIndex = vi.fn(async () => index({ id: value.id, state: "sealed" }));
    await expect(TEST_ONLY.readAuthenticatedSegmentMaintenanceDescriptorWithReader({
      ...value,
      entry: { kind: "directory", name: value.entry.name },
      readSegmentIndex,
    })).rejects.toBeInstanceOf(AuthenticatedSegmentMaintenanceDescriptorError);
    await expect(TEST_ONLY.readAuthenticatedSegmentMaintenanceDescriptorWithReader({
      ...value,
      entry: { byteLength: 1n, kind: "file", name: "not-a-segment.enc" },
      readSegmentIndex,
    })).rejects.toMatchObject({ code: "invalid_segment_path" });
    expect(readSegmentIndex).not.toHaveBeenCalled();
  });

  it("propagates authenticated read failures without reclassifying corrupt bytes as eligible", async () => {
    const value = fixture();
    const failure = new Error("authentication failed");
    await expect(TEST_ONLY.readAuthenticatedSegmentMaintenanceDescriptorWithReader({
      ...value,
      readSegmentIndex: async () => {
        throw failure;
      },
    })).rejects.toBe(failure);
  });

  it("requires a canonical shard directory rather than trusting an entry name", async () => {
    const value = fixture();
    await expect(TEST_ONLY.readAuthenticatedSegmentMaintenanceDescriptorWithReader({
      ...value,
      directory: canonicalContainerDirectory({ value: "segments/metadata/00" }),
      readSegmentIndex: async () => index({ id: value.id, state: "sealed" }),
    })).rejects.toMatchObject({ code: "invalid_segment_path" });
  });
});
