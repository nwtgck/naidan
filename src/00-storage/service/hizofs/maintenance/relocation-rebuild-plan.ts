import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  compareUnsignedBytes,
  createHomeRecordReference,
  createPhysicalRecordReference,
  segmentIdToLowercaseHex,
  type HomeRecordReference,
  type PhysicalRecordReference,
  type RelocationLeafEntry,
} from "@/00-storage/service/hizofs/00-format";
import type { CompactionCopiedMapping } from "@/00-storage/service/hizofs/maintenance/compaction-copy-cursor";

export type RelocationRebuildPlanErrorCode =
  | "duplicate_existing_mapping"
  | "duplicate_moved_mapping"
  | "duplicate_reachable_reference"
  | "invalid_mapping"
  | "physical_only_record"
  | "unreachable_moved_mapping";

export class RelocationRebuildPlanError extends Error {
  readonly code: RelocationRebuildPlanErrorCode;

  constructor({ code, message }: { code: RelocationRebuildPlanErrorCode; message: string }) {
    super(message);
    this.name = "RelocationRebuildPlanError";
    this.code = code;
  }
}

export type RelocationRebuildPlan = Readonly<{
  droppedStaleEntryCount: number;
  entries: readonly RelocationLeafEntry[];
}>;

function homeKey({ byteOffset, segmentId }: Pick<HomeRecordReference, "byteOffset" | "segmentId">): string {
  return `${segmentIdToLowercaseHex({ id: segmentId })}:${byteOffset.toString(16).padStart(16, "0")}`;
}

function cloneHomeReference({ reference }: { reference: HomeRecordReference }): HomeRecordReference {
  return createHomeRecordReference({ fields: reference });
}

function clonePhysicalReference({ reference }: { reference: PhysicalRecordReference }): PhysicalRecordReference {
  return createPhysicalRecordReference({ fields: reference });
}

function compareHomeReferences({ left, right }: {
  left: Pick<HomeRecordReference, "byteOffset" | "segmentId">;
  right: Pick<HomeRecordReference, "byteOffset" | "segmentId">;
}): number {
  const segmentOrder = compareUnsignedBytes({ left: left.segmentId, right: right.segmentId });
  if (segmentOrder !== 0) return segmentOrder;
  return left.byteOffset < right.byteOffset ? -1 : left.byteOffset > right.byteOffset ? 1 : 0;
}

function samePhysicalAsHome({ homeReference, physicalReference }: {
  homeReference: HomeRecordReference;
  physicalReference: PhysicalRecordReference;
}): boolean {
  return homeReference.byteOffset === physicalReference.byteOffset
    && compareUnsignedBytes({ left: homeReference.segmentId, right: physicalReference.segmentId }) === 0;
}

function validateTarget({ homeReference, physicalReference }: {
  homeReference: HomeRecordReference;
  physicalReference: PhysicalRecordReference;
}): void {
  if (homeReference.recordKind === HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page) {
    throw new RelocationRebuildPlanError({
      code: "physical_only_record",
      message: "Relocation Index pages must not appear as logical relocation mappings",
    });
  }
  if (physicalReference.recordKind !== homeReference.recordKind
    || physicalReference.frameLength !== homeReference.frameLength) {
    throw new RelocationRebuildPlanError({
      code: "invalid_mapping",
      message: "relocation rebuild changes the logical record kind or frame length",
    });
  }
}

function insertUnique<T>({ code, key, label, map, value }: {
  code: RelocationRebuildPlanErrorCode;
  key: string;
  label: string;
  map: Map<string, T>;
  value: T;
}): void {
  if (map.has(key)) throw new RelocationRebuildPlanError({ code, message: `${label} contains a duplicate Home identity` });
  map.set(key, value);
}

export function buildRelocationRebuildPlan({ existingEntries, movedMappings, reachableHomeReferences }: {
  existingEntries: readonly RelocationLeafEntry[];
  movedMappings: readonly CompactionCopiedMapping[];
  reachableHomeReferences: readonly HomeRecordReference[];
}): RelocationRebuildPlan {
  const reachable = new Map<string, HomeRecordReference>();
  for (const reference of reachableHomeReferences) {
    if (reference.recordKind === HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page) {
      throw new RelocationRebuildPlanError({
        code: "physical_only_record",
        message: "reachable logical roots must not include physical-only Relocation Index pages",
      });
    }
    insertUnique({
      code: "duplicate_reachable_reference",
      key: homeKey(reference),
      label: "reachable reference set",
      map: reachable,
      value: cloneHomeReference({ reference }),
    });
  }

  const existing = new Map<string, RelocationLeafEntry>();
  for (const entry of existingEntries) {
    insertUnique({
      code: "duplicate_existing_mapping",
      key: homeKey({ byteOffset: entry.homeOffset, segmentId: entry.homeSegmentId }),
      label: "existing relocation index",
      map: existing,
      value: Object.freeze({
        currentPhysicalRecordRef: clonePhysicalReference({ reference: entry.currentPhysicalRecordRef }),
        homeOffset: entry.homeOffset,
        homeSegmentId: Uint8Array.from(entry.homeSegmentId) as typeof entry.homeSegmentId,
      }),
    });
  }

  const moved = new Map<string, CompactionCopiedMapping>();
  for (const mapping of movedMappings) {
    const key = homeKey(mapping.homeReference);
    if (!reachable.has(key)) {
      throw new RelocationRebuildPlanError({
        code: "unreachable_moved_mapping",
        message: "compaction produced a relocation mapping for a record outside the reachable root closure",
      });
    }
    validateTarget({
      homeReference: mapping.homeReference,
      physicalReference: mapping.destinationPhysicalReference,
    });
    insertUnique({
      code: "duplicate_moved_mapping",
      key,
      label: "moved relocation set",
      map: moved,
      value: Object.freeze({
        destinationPhysicalReference: clonePhysicalReference({ reference: mapping.destinationPhysicalReference }),
        homeReference: cloneHomeReference({ reference: mapping.homeReference }),
      }),
    });
  }

  const output: RelocationLeafEntry[] = [];
  for (const [key, homeReference] of reachable) {
    const movedMapping = moved.get(key);
    const existingEntry = existing.get(key);
    const physicalReference = movedMapping?.destinationPhysicalReference ?? existingEntry?.currentPhysicalRecordRef;
    if (physicalReference === undefined) continue;
    validateTarget({ homeReference, physicalReference });
    if (samePhysicalAsHome({ homeReference, physicalReference })) continue;
    output.push(Object.freeze({
      currentPhysicalRecordRef: clonePhysicalReference({ reference: physicalReference }),
      homeOffset: homeReference.byteOffset,
      homeSegmentId: Uint8Array.from(homeReference.segmentId) as typeof homeReference.segmentId,
    }));
  }
  output.sort((left, right) => compareHomeReferences({
    left: { byteOffset: left.homeOffset, segmentId: left.homeSegmentId },
    right: { byteOffset: right.homeOffset, segmentId: right.homeSegmentId },
  }));
  const droppedStaleEntryCount = [...existing.keys()].filter(key => !reachable.has(key)).length;
  return Object.freeze({
    droppedStaleEntryCount,
    entries: Object.freeze(output),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
