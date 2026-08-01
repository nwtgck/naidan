import {
  createHomeRecordReference,
  createUInt64,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";

export function createTestingHomeRecordReference({ offset = 64n }: {
  offset?: bigint;
} = {}) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    segmentId: parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 1) }),
  } });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
