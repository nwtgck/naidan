import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createPhysicalRecordReference,
  createUInt64,
  parseSegmentId,
  type HomeRecordReference,
  type PhysicalRecordReference,
  type RelocationLeafEntry,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import {
  RelocationRebuildPlanError,
  buildRelocationRebuildPlan,
} from "@/00-storage/service/hizofs/maintenance/relocation-rebuild-plan";

const KINDS = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;

function segmentId({ seed }: { seed: number }): SegmentId {
  return parseSegmentId({ bytes: new Uint8Array(16).fill(seed) });
}

function home({ offset = 64n, seed = 1 }: { offset?: bigint; seed?: number } = {}): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: KINDS.inode_table_page,
    segmentId: segmentId({ seed }),
  } });
}

function physical({ homeReference, offset = 160n, seed }: {
  homeReference: HomeRecordReference;
  offset?: bigint;
  seed: number;
}): PhysicalRecordReference {
  return createPhysicalRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: homeReference.frameLength,
    recordKind: homeReference.recordKind,
    segmentId: segmentId({ seed }),
  } });
}

function existing({ homeReference, target }: {
  homeReference: HomeRecordReference;
  target: PhysicalRecordReference;
}): RelocationLeafEntry {
  return {
    currentPhysicalRecordRef: target,
    homeOffset: homeReference.byteOffset,
    homeSegmentId: homeReference.segmentId,
  };
}

describe("relocation rebuild plan", () => {
  it("keeps only reachable mappings, replaces moved mappings, and sorts by canonical Home key", () => {
    const late = home({ offset: 160n, seed: 2 });
    const early = home({ offset: 64n, seed: 1 });
    const stale = home({ offset: 256n, seed: 3 });
    const movedTarget = physical({ homeReference: late, seed: 12 });
    const result = buildRelocationRebuildPlan({
      existingEntries: [
        existing({ homeReference: late, target: physical({ homeReference: late, seed: 8 }) }),
        existing({ homeReference: early, target: physical({ homeReference: early, seed: 7 }) }),
        existing({ homeReference: stale, target: physical({ homeReference: stale, seed: 9 }) }),
      ],
      movedMappings: [{ destinationPhysicalReference: movedTarget, homeReference: late }],
      reachableHomeReferences: [late, early],
    });

    expect(result.entries).toEqual([
      existing({ homeReference: early, target: physical({ homeReference: early, seed: 7 }) }),
      existing({ homeReference: late, target: movedTarget }),
    ]);
    expect(result.droppedStaleEntryCount).toBe(1);
  });

  it("omits mappings whose current physical location equals the Home location", () => {
    const reference = home();
    const homePhysical = createPhysicalRecordReference({ fields: reference });
    expect(buildRelocationRebuildPlan({
      existingEntries: [],
      movedMappings: [{ destinationPhysicalReference: homePhysical, homeReference: reference }],
      reachableHomeReferences: [reference],
    }).entries).toEqual([]);
  });

  it("rejects moved mappings for unreachable records and duplicate authorities", () => {
    const first = home();
    const second = home({ offset: 160n, seed: 2 });
    expect(() => buildRelocationRebuildPlan({
      existingEntries: [],
      movedMappings: [{ destinationPhysicalReference: physical({ homeReference: second, seed: 8 }), homeReference: second }],
      reachableHomeReferences: [first],
    })).toThrowError(RelocationRebuildPlanError);
    expect(() => buildRelocationRebuildPlan({
      existingEntries: [],
      movedMappings: [],
      reachableHomeReferences: [first, first],
    })).toThrowError(RelocationRebuildPlanError);
  });

  it("rejects kind or frame-length changes in existing and moved mappings", () => {
    const reference = home();
    const wrong = createPhysicalRecordReference({ fields: {
      ...physical({ homeReference: reference, seed: 7 }),
      recordKind: KINDS.directory_page,
    } });
    expect(() => buildRelocationRebuildPlan({
      existingEntries: [existing({ homeReference: reference, target: wrong })],
      movedMappings: [],
      reachableHomeReferences: [reference],
    })).toThrowError(RelocationRebuildPlanError);
  });
});
