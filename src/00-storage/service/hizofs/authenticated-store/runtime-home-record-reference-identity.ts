import {
  assertHomeRecordReferenceValid,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";

/**
 * Returns a collision-free runtime-only identity for one validated Home Record
 * Reference without allocating its persisted 32-byte encoding first.
 *
 * WHY: immutable-tree traversal and bounded caches compare these references on
 * hot paths. Persisted encoding remains the format authority, but rebuilding
 * those bytes and expanding them to hex for every Map lookup adds allocation
 * without strengthening runtime identity. The U+0100 separator cannot occur in
 * the byte-derived Segment prefix or ASCII hexadecimal suffixes.
 */
export function runtimeHomeRecordReferenceIdentity({ reference }: {
  reference: HomeRecordReference;
}): string {
  assertHomeRecordReferenceValid({ reference });
  let segmentIdentity = "";
  for (const byte of reference.segmentId) segmentIdentity += String.fromCharCode(byte);
  const separator = "\u0100";
  return `${segmentIdentity}${separator}${reference.byteOffset.toString(16)}`
    + `${separator}${reference.frameLength.toString(16)}`
    + `${separator}${reference.recordKind.toString(16)}`;
}

export const TEST_ONLY = {
  runtimeHomeRecordReferenceIdentity,
};
