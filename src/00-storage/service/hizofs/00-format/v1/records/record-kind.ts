import { HIZOFS_V1_FORMAT_CONSTANTS } from "@/00-storage/service/hizofs/00-format/v1/format-constants";
import type { SegmentClass } from "@/00-storage/service/hizofs/00-format/v1/paths";

const RECORD_KINDS = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
const RECORD_SEGMENT_CLASSES = HIZOFS_V1_FORMAT_CONSTANTS.recordSegmentClasses;
type RecordKindName = keyof typeof RECORD_KINDS;

const SEGMENT_CLASS_BY_RECORD_KIND = new Map<number, SegmentClass>(
  (Object.keys(RECORD_KINDS) as RecordKindName[]).map(name => [
    RECORD_KINDS[name],
    RECORD_SEGMENT_CLASSES[name],
  ] as const),
);

export function segmentClassForRecordKind({ recordKind }: { recordKind: number }): SegmentClass {
  const segmentClass = SEGMENT_CLASS_BY_RECORD_KIND.get(recordKind);
  if (segmentClass === undefined) throw new TypeError("Record kind is unknown");
  return segmentClass;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
