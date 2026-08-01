import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createUInt64,
  parseSegmentId,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import {
  BoundedCompletedReferenceMemo,
  BoundedCompletedReferenceMemoError,
} from "@/00-storage/service/hizofs/maintenance/bounded-completed-reference-memo";
import { createLogicalMaintenanceTraversalItem } from "@/00-storage/service/hizofs/maintenance/maintenance-traversal-item";

function reference({ offset }: { offset: bigint }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: 64n + offset * 8n }),
    frameLength: 128,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset) + 1) }),
  } });
}

function item({ offset }: { offset: bigint }) {
  return createLogicalMaintenanceTraversalItem({ pageRole: "non_root", reference: reference({ offset }) });
}

describe("bounded completed reference memo", () => {
  it("uses exact traversal-item identity", () => {
    const memo = new BoundedCompletedReferenceMemo({ maxEntries: 2 });
    const first = item({ offset: 1n });
    memo.remember({ item: first });
    expect(memo.has({ item: first })).toBe(true);
    expect(memo.has({ item: item({ offset: 2n }) })).toBe(false);
  });

  it("evicts the least recently remembered item and permits safe revisit", () => {
    const memo = new BoundedCompletedReferenceMemo({ maxEntries: 2 });
    const first = item({ offset: 1n });
    const second = item({ offset: 2n });
    const third = item({ offset: 3n });
    memo.remember({ item: first });
    memo.remember({ item: second });
    memo.remember({ item: first });
    memo.remember({ item: third });
    expect(memo.size).toBe(2);
    expect(memo.has({ item: first })).toBe(true);
    expect(memo.has({ item: second })).toBe(false);
    expect(memo.has({ item: third })).toBe(true);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid bound %s", maxEntries => {
    expect(() => new BoundedCompletedReferenceMemo({ maxEntries }))
      .toThrowError(BoundedCompletedReferenceMemoError);
  });
});
