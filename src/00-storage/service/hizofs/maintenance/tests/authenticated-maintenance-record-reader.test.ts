import { describe, expect, it, vi } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createPhysicalRecordReference,
  createUInt64,
  encodeRelocationIndexPage,
  parseSegmentId,
  type HomeRecordReference,
  type PhysicalRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import { createCandidateFrameOrdinalAuthority } from "@/00-storage/service/hizofs/authenticated-store/candidate-frame-ordinal-authority";
import type { AuthenticatedMaintenanceRecordPort } from "@/00-storage/service/hizofs/authenticated-store/maintenance-record-read-port";
import type { AuthenticatedRecordRead } from "@/00-storage/service/hizofs/authenticated-store/record-reader";
import { createMaintenanceRecordReaderFromAuthenticatedPort } from "@/00-storage/service/hizofs/maintenance/authenticated-maintenance-record-reader";
import { CandidateSegmentBatch } from "@/00-storage/service/hizofs/maintenance/candidate-segment-batch";
import { GarbageCollectionMarkCursor } from "@/00-storage/service/hizofs/maintenance/garbage-collection-mark-cursor";
import { createMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";
import {
  createLogicalMaintenanceTraversalItem,
  createPhysicalRelocationMaintenanceTraversalItem,
} from "@/00-storage/service/hizofs/maintenance/maintenance-traversal-item";

const KINDS = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;

function segmentId({ seed }: { seed: number }) {
  return parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => (seed + index) & 0xff) });
}

function homeReference({ kind, seed = 1 }: { kind: number; seed?: number }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: 64n }),
    frameLength: 96,
    recordKind: kind,
    segmentId: segmentId({ seed }),
  } });
}

function physicalReference({ kind, seed = 1 }: { kind: number; seed?: number }): PhysicalRecordReference {
  return createPhysicalRecordReference({ fields: {
    byteOffset: createUInt64({ value: 64n }),
    frameLength: 96,
    recordKind: kind,
    segmentId: segmentId({ seed }),
  } });
}

function authenticatedRead({ physicalReference, plaintext }: {
  physicalReference: PhysicalRecordReference;
  plaintext: Uint8Array;
}): AuthenticatedRecordRead {
  return Object.freeze({
    header: {} as AuthenticatedRecordRead["header"],
    physicalReference,
    plaintext,
  });
}

function port({ logical, physical }: {
  logical?: AuthenticatedRecordRead;
  physical?: AuthenticatedRecordRead;
}): AuthenticatedMaintenanceRecordPort {
  const wrap = (record: AuthenticatedRecordRead) => Object.freeze({
    physicalBytesRead: record.physicalReference.frameLength,
    record,
  });
  return {
    readLogicalRecord: vi.fn(async () => {
      if (logical === undefined) throw new Error("unexpected logical read");
      return wrap(logical);
    }),
    readPhysicalRecord: vi.fn(async () => {
      if (physical === undefined) throw new Error("unexpected physical read");
      return wrap(physical);
    }),
  };
}

describe("authenticated maintenance record reader", () => {
  it("returns the current authenticated physical mapping for a logical record", async () => {
    const home = homeReference({ kind: KINDS.file_data });
    const current = physicalReference({ kind: KINDS.file_data, seed: 9 });
    const plaintext = new Uint8Array([1, 2]);
    const readPort = port({ logical: authenticatedRead({ physicalReference: current, plaintext }) });
    const reader = createMaintenanceRecordReaderFromAuthenticatedPort({ port: readPort });

    await expect(reader.readRecord({
      item: createLogicalMaintenanceTraversalItem({ pageRole: "not_page", reference: home }),
    })).resolves.toEqual({
      bytesRead: current.frameLength,
      childItems: [],
      physicalReference: current,
    });
    expect(readPort.readLogicalRecord).toHaveBeenCalledWith({ reference: home });
    expect(readPort.readPhysicalRecord).not.toHaveBeenCalled();
    expect(plaintext).toEqual(new Uint8Array(2));
  });

  it("marks the current relocated physical frame for a reachable logical record", async () => {
    const home = homeReference({ kind: KINDS.file_data });
    const current = physicalReference({ kind: KINDS.file_data, seed: 12 });
    const readPort = port({ logical: authenticatedRead({ physicalReference: current, plaintext: new Uint8Array([1]) }) });
    const policy = createMaintenancePolicy();
    const candidateBatch = new CandidateSegmentBatch({
      candidates: [{
        frameCount: 1,
        frameOrdinalAuthority: createCandidateFrameOrdinalAuthority({
          frames: [{
            frameLength: current.frameLength,
            physicalOffset: current.byteOffset,
            recordKind: current.recordKind,
          }],
          segmentId: current.segmentId,
        }),
        ownership: "sealed",
        segmentId: current.segmentId,
        totalFrameBytes: current.frameLength,
      }],
      policy,
    });
    const cursor = new GarbageCollectionMarkCursor({
      candidateBatch,
      policy,
      reader: createMaintenanceRecordReaderFromAuthenticatedPort({ port: readPort }),
      roots: [createLogicalMaintenanceTraversalItem({ pageRole: "not_page", reference: home })],
    });

    const result = await cursor.runSlice({
      hasForegroundWaiter: () => false,
      now: () => 0,
      signal: undefined,
    });
    expect(result).toMatchObject({ phase: "batch_complete" });
    if (result.phase !== "batch_complete") expect.unreachable("mark must complete");
    expect(result.plan[0]).toMatchObject({ disposition: "retain", liveFrameCount: 1 });
  });

  it("reads a physical relocation page by exact physical identity", async () => {
    const root = physicalReference({ kind: KINDS.relocation_index_page, seed: 2 });
    const child = physicalReference({ kind: KINDS.relocation_index_page, seed: 3 });
    const plaintext = encodeRelocationIndexPage({
      isRoot: true,
      page: {
        entries: [{
          childPagePhysicalRef: child,
          upperBound: {
            homeOffset: createUInt64({ value: 64n }),
            homeSegmentId: segmentId({ seed: 4 }),
          },
        }],
        level: 1,
        type: "branch",
      },
    });
    const readPort = port({ physical: authenticatedRead({ physicalReference: root, plaintext }) });
    const reader = createMaintenanceRecordReaderFromAuthenticatedPort({ port: readPort });

    const result = await reader.readRecord({
      item: createPhysicalRelocationMaintenanceTraversalItem({ pageRole: "root", reference: root }),
    });
    expect(result.physicalReference).toEqual(root);
    expect(result.childItems).toEqual([
      expect.objectContaining({ kind: "physical_relocation_page", pageRole: "non_root", reference: child }),
    ]);
    expect(readPort.readPhysicalRecord).toHaveBeenCalledWith({ reference: root });
    expect(readPort.readLogicalRecord).not.toHaveBeenCalled();
    expect(plaintext.every(byte => byte === 0)).toBe(true);
  });

  it("rejects a physical reader result for a different frame", async () => {
    const requested = physicalReference({ kind: KINDS.relocation_index_page, seed: 5 });
    const returned = physicalReference({ kind: KINDS.relocation_index_page, seed: 6 });
    const plaintext = encodeRelocationIndexPage({ isRoot: true, page: { entries: [], level: 0, type: "leaf" } });
    const readPort = port({
      physical: authenticatedRead({
        physicalReference: returned,
        plaintext,
      }),
    });
    const reader = createMaintenanceRecordReaderFromAuthenticatedPort({ port: readPort });

    await expect(reader.readRecord({
      item: createPhysicalRelocationMaintenanceTraversalItem({ pageRole: "root", reference: requested }),
    })).rejects.toThrowError("different physical record");
    expect(plaintext.every(byte => byte === 0)).toBe(true);
  });
});
