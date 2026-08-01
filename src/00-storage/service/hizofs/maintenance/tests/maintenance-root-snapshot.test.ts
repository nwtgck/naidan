import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createPhysicalRecordReference,
  createUInt64,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";
import type { CapturedCandidateSegment } from "@/00-storage/service/hizofs/maintenance/candidate-segment-batch";
import { createCandidateFrameOrdinalAuthority } from "@/00-storage/service/hizofs/authenticated-store/candidate-frame-ordinal-authority";
import {
  createLogicalMaintenanceTraversalItem,
  createPhysicalRelocationMaintenanceTraversalItem,
} from "@/00-storage/service/hizofs/maintenance/maintenance-traversal-item";
import {
  MaintenanceRootSnapshotError,
  createMaintenanceRootSnapshot,
  validateMaintenanceRootSnapshot,
} from "@/00-storage/service/hizofs/maintenance/maintenance-root-snapshot";

function logicalRoot({ offset }: { offset: bigint }) {
  return createLogicalMaintenanceTraversalItem({
    pageRole: "not_page",
    reference: createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: offset }),
      frameLength: 128,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset / 8n)) }),
    } }),
  });
}

function relocationRoot({ offset, pageRole = "root" }: { offset: bigint; pageRole?: "non_root" | "root" }) {
  return createPhysicalRelocationMaintenanceTraversalItem({
    pageRole,
    reference: createPhysicalRecordReference({ fields: {
      byteOffset: createUInt64({ value: offset }),
      frameLength: 128,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset / 8n) + 10) }),
    } }),
  });
}

function candidate({ frameCount = 2, seed }: { frameCount?: number; seed: number }): CapturedCandidateSegment {
  const id = parseSegmentId({ bytes: new Uint8Array(16).fill(seed) });
  return {
    frameCount,
    frameOrdinalAuthority: createCandidateFrameOrdinalAuthority({
      frames: Array.from({ length: frameCount }, (_, ordinal) => ({
        frameLength: 128,
        physicalOffset: 64n + BigInt(ordinal * 128),
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      })),
      segmentId: id,
    }),
    ownership: "sealed",
    segmentId: id,
    totalFrameBytes: frameCount * 128,
  };
}

describe("maintenance root snapshot validation", () => {
  it("canonicalizes duplicate typed roots and allows newly created non-candidate segments", () => {
    const root = logicalRoot({ offset: 64n });
    const captured = createMaintenanceRootSnapshot({
      candidateSegments: [candidate({ seed: 1 })],
      maintenanceRootEpoch: 4,
      roots: [root, root],
    });
    const current = createMaintenanceRootSnapshot({
      candidateSegments: [candidate({ seed: 1 }), candidate({ seed: 2 })],
      maintenanceRootEpoch: 4,
      roots: [root],
    });
    expect(captured.roots).toHaveLength(1);
    expect(validateMaintenanceRootSnapshot({ captured, current })).toEqual({ valid: true });
  });

  it("treats a physical relocation authority change as a root-set change", () => {
    const captured = createMaintenanceRootSnapshot({
      candidateSegments: [],
      maintenanceRootEpoch: 4,
      roots: [logicalRoot({ offset: 64n }), relocationRoot({ offset: 128n })],
    });
    const current = createMaintenanceRootSnapshot({
      candidateSegments: [],
      maintenanceRootEpoch: 4,
      roots: [logicalRoot({ offset: 64n }), relocationRoot({ offset: 256n })],
    });
    expect(validateMaintenanceRootSnapshot({ captured, current }))
      .toEqual({ reason: "root_set_changed", valid: false });
  });

  it("rejects conflicting root and non-root roles for one physical reference", () => {
    expect(() => createMaintenanceRootSnapshot({
      candidateSegments: [],
      maintenanceRootEpoch: 4,
      roots: [relocationRoot({ offset: 128n }), relocationRoot({ offset: 128n, pageRole: "non_root" })],
    })).toThrowError(expect.objectContaining<Partial<MaintenanceRootSnapshotError>>({ code: "conflicting_root_role" }));
  });

  it.each([
    ["root_epoch_changed", { epoch: 5, roots: [logicalRoot({ offset: 64n })], candidates: [candidate({ seed: 1 })] }],
    ["root_set_changed", { epoch: 4, roots: [logicalRoot({ offset: 72n })], candidates: [candidate({ seed: 1 })] }],
    ["candidate_missing", { epoch: 4, roots: [logicalRoot({ offset: 64n })], candidates: [] }],
    ["candidate_changed", { epoch: 4, roots: [logicalRoot({ offset: 64n })], candidates: [candidate({ frameCount: 3, seed: 1 })] }],
  ])("fails closed with %s", (reason, changed) => {
    const captured = createMaintenanceRootSnapshot({
      candidateSegments: [candidate({ seed: 1 })],
      maintenanceRootEpoch: 4,
      roots: [logicalRoot({ offset: 64n })],
    });
    const current = createMaintenanceRootSnapshot({
      candidateSegments: changed.candidates,
      maintenanceRootEpoch: changed.epoch,
      roots: changed.roots,
    });
    expect(validateMaintenanceRootSnapshot({ captured, current })).toEqual({ reason, valid: false });
  });
});
