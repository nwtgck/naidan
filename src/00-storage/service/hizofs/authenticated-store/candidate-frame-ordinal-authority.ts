import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  segmentIdToLowercaseHex,
  type PhysicalRecordReference,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";

const UINT32_MAXIMUM = 0xffff_ffff;
const KNOWN_RECORD_KINDS = new Set<number>(Object.values(HIZOFS_V1_FORMAT_CONSTANTS.recordKinds));

export type CandidateFrameOrdinalEntry = Readonly<{
  frameLength: number;
  physicalOffset: bigint;
  recordKind: number;
}>;

export type CandidateFrameOrdinalAuthority = Readonly<{
  byteLength: number;
  frameCount: number;
  segmentIdentity: string;
  copyFrameLengths: () => Uint32Array;
  copyPhysicalOffsets: () => Uint32Array;
  copyRecordKinds: () => Uint8Array;
  copySegmentId: () => SegmentId;
  resolveOrdinal: ({ physicalReference }: {
    physicalReference: PhysicalRecordReference;
  }) => number | undefined;
}>;

export type CandidateFrameOrdinalAuthorityErrorCode =
  | "duplicate_frame_offset"
  | "empty_frame_table"
  | "invalid_frame_length"
  | "invalid_frame_offset"
  | "invalid_record_kind"
  | "unordered_frame_offsets";

export class CandidateFrameOrdinalAuthorityError extends Error {
  readonly code: CandidateFrameOrdinalAuthorityErrorCode;

  constructor({ code, message }: {
    code: CandidateFrameOrdinalAuthorityErrorCode;
    message: string;
  }) {
    super(message);
    this.name = "CandidateFrameOrdinalAuthorityError";
    this.code = code;
  }
}

function checkedPhysicalOffset({ offset }: { offset: bigint }): number {
  const segmentHeaderBytes = BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader);
  if (offset < segmentHeaderBytes || offset % 8n !== 0n || offset > BigInt(UINT32_MAXIMUM)) {
    throw new CandidateFrameOrdinalAuthorityError({
      code: "invalid_frame_offset",
      message: "candidate frame offset must be aligned, follow the Segment Header, and fit the bounded V1 Segment file range",
    });
  }
  return Number(offset);
}

function checkedFrameLength({ frameLength, physicalOffset }: {
  frameLength: number;
  physicalOffset: number;
}): number {
  if (!Number.isSafeInteger(frameLength)
    || frameLength <= 0
    || frameLength % 8 !== 0
    || frameLength > UINT32_MAXIMUM
    || physicalOffset > UINT32_MAXIMUM - frameLength) {
    throw new CandidateFrameOrdinalAuthorityError({
      code: "invalid_frame_length",
      message: "candidate frame length must be aligned and fit the bounded V1 Segment file range",
    });
  }
  return frameLength;
}

function checkedRecordKind({ recordKind }: { recordKind: number }): number {
  if (!Number.isInteger(recordKind) || !KNOWN_RECORD_KINDS.has(recordKind)) {
    throw new CandidateFrameOrdinalAuthorityError({
      code: "invalid_record_kind",
      message: "candidate frame record kind must be a known HizoFS V1 record kind",
    });
  }
  return recordKind;
}

/**
 * Keeps the exact authenticated physical identity of each frame without retaining
 * decoded records or footer bytes. The array index is the authoritative Segment
 * frame ordinal; callers must never derive ordinals from variable-length offsets.
 */
export function createCandidateFrameOrdinalAuthority({ frames, segmentId }: {
  frames: readonly CandidateFrameOrdinalEntry[];
  segmentId: SegmentId;
}): CandidateFrameOrdinalAuthority {
  if (frames.length === 0) {
    throw new CandidateFrameOrdinalAuthorityError({
      code: "empty_frame_table",
      message: "candidate frame ordinal authority requires at least one authenticated frame",
    });
  }
  const frameLengths = new Uint32Array(frames.length);
  const offsets = new Uint32Array(frames.length);
  const recordKinds = new Uint8Array(frames.length);
  let previous: number | undefined;
  for (let ordinal = 0; ordinal < frames.length; ordinal += 1) {
    const frame = frames[ordinal];
    if (frame === undefined) throw new Error("candidate frame ordinal input invariant failed");
    const offset = checkedPhysicalOffset({ offset: frame.physicalOffset });
    if (previous !== undefined && offset <= previous) {
      throw new CandidateFrameOrdinalAuthorityError({
        code: offset === previous ? "duplicate_frame_offset" : "unordered_frame_offsets",
        message: "candidate frame offsets must preserve authenticated Segment ordinal order",
      });
    }
    offsets[ordinal] = offset;
    frameLengths[ordinal] = checkedFrameLength({ frameLength: frame.frameLength, physicalOffset: offset });
    recordKinds[ordinal] = checkedRecordKind({ recordKind: frame.recordKind });
    previous = offset;
  }
  const detachedSegmentId = Uint8Array.from(segmentId) as SegmentId;
  const segmentIdentity = segmentIdToLowercaseHex({ id: detachedSegmentId });
  return Object.freeze({
    byteLength: offsets.byteLength + frameLengths.byteLength + recordKinds.byteLength,
    copyFrameLengths: () => Uint32Array.from(frameLengths),
    copyPhysicalOffsets: () => Uint32Array.from(offsets),
    copyRecordKinds: () => Uint8Array.from(recordKinds),
    copySegmentId: () => Uint8Array.from(detachedSegmentId) as SegmentId,
    frameCount: offsets.length,
    resolveOrdinal: ({ physicalReference }) => {
      if (segmentIdentity !== segmentIdToLowercaseHex({ id: physicalReference.segmentId })) return undefined;
      if (physicalReference.byteOffset < 0n || physicalReference.byteOffset > BigInt(UINT32_MAXIMUM)) return undefined;
      const target = Number(physicalReference.byteOffset);
      let lower = 0;
      let upper = offsets.length;
      while (lower < upper) {
        const middle = lower + Math.floor((upper - lower) / 2);
        const candidate = offsets[middle];
        if (candidate === undefined) throw new Error("candidate frame ordinal binary-search invariant failed");
        if (candidate < target) lower = middle + 1;
        else upper = middle;
      }
      if (offsets[lower] !== target
        || frameLengths[lower] !== physicalReference.frameLength
        || recordKinds[lower] !== physicalReference.recordKind) return undefined;
      return lower;
    },
    segmentIdentity,
  });
}

export function cloneCandidateFrameOrdinalAuthority({ authority }: {
  authority: CandidateFrameOrdinalAuthority;
}): CandidateFrameOrdinalAuthority {
  const frameLengths = authority.copyFrameLengths();
  const offsets = authority.copyPhysicalOffsets();
  const recordKinds = authority.copyRecordKinds();
  return createCandidateFrameOrdinalAuthority({
    frames: [...offsets].map((physicalOffset, ordinal) => ({
      frameLength: frameLengths[ordinal] ?? -1,
      physicalOffset: BigInt(physicalOffset),
      recordKind: recordKinds[ordinal] ?? -1,
    })),
    segmentId: authority.copySegmentId(),
  });
}

export function sameCandidateFrameOrdinalAuthority({ left, right }: {
  left: CandidateFrameOrdinalAuthority;
  right: CandidateFrameOrdinalAuthority;
}): boolean {
  if (left.segmentIdentity !== right.segmentIdentity
    || left.frameCount !== right.frameCount
    || left.byteLength !== right.byteLength) return false;
  const leftFrameLengths = left.copyFrameLengths();
  const leftOffsets = left.copyPhysicalOffsets();
  const leftRecordKinds = left.copyRecordKinds();
  const rightFrameLengths = right.copyFrameLengths();
  const rightOffsets = right.copyPhysicalOffsets();
  const rightRecordKinds = right.copyRecordKinds();
  return leftOffsets.every((offset, ordinal) => offset === rightOffsets[ordinal]
    && leftFrameLengths[ordinal] === rightFrameLengths[ordinal]
    && leftRecordKinds[ordinal] === rightRecordKinds[ordinal]);
}

export function resolveCandidateFrameOrdinal({ authority, physicalReference }: {
  authority: CandidateFrameOrdinalAuthority;
  physicalReference: PhysicalRecordReference;
}): number | undefined {
  return authority.resolveOrdinal({ physicalReference });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  UINT32_MAXIMUM,
};
