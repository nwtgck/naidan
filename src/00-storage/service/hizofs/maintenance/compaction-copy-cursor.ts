import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  compareUnsignedBytes,
  createHomeRecordReference,
  createPhysicalRecordReference,
  decodeRecordFrameHeader,
  validateRelocationMapping,
  type HomeRecordReference,
  type PhysicalRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import type { HizoFSMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";

export type CompactionCopyEntry = Readonly<{
  homeReference: HomeRecordReference;
  sourcePhysicalReference: PhysicalRecordReference;
}>;

export type CompactionCopiedMapping = Readonly<{
  destinationPhysicalReference: PhysicalRecordReference;
  homeReference: HomeRecordReference;
}>;

export type CompactionCopyYieldReason =
  | "foreground_waiter"
  | "slice_byte_limit"
  | "soft_time_limit";

export type CompactionCopyResult =
  | Readonly<{ phase: "aborted"; reason: "abort_requested" | "copy_failed" }>
  | Readonly<{ mappings: readonly CompactionCopiedMapping[]; phase: "completed" }>
  | Readonly<{ phase: "copying"; reason: CompactionCopyYieldReason }>;

export type CompactionCopyCursorErrorCode =
  | "duplicate_home_reference"
  | "frame_exceeds_slice_budget"
  | "invalid_entry"
  | "physical_only_record";

export class CompactionCopyCursorError extends Error {
  readonly code: CompactionCopyCursorErrorCode;

  constructor({ code, message }: { code: CompactionCopyCursorErrorCode; message: string }) {
    super(message);
    this.name = "CompactionCopyCursorError";
    this.code = code;
  }
}

function cloneHomeReference({ reference }: { reference: HomeRecordReference }): HomeRecordReference {
  return createHomeRecordReference({ fields: reference });
}

function clonePhysicalReference({ reference }: { reference: PhysicalRecordReference }): PhysicalRecordReference {
  return createPhysicalRecordReference({ fields: reference });
}

function compareHomeReferences({ left, right }: {
  left: HomeRecordReference;
  right: HomeRecordReference;
}): number {
  const segmentOrder = compareUnsignedBytes({ left: left.segmentId, right: right.segmentId });
  if (segmentOrder !== 0) return segmentOrder;
  return left.byteOffset < right.byteOffset ? -1 : left.byteOffset > right.byteOffset ? 1 : 0;
}

function samePhysicalReference({ left, right }: {
  left: PhysicalRecordReference;
  right: PhysicalRecordReference;
}): boolean {
  return left.byteOffset === right.byteOffset
    && left.frameLength === right.frameLength
    && left.recordKind === right.recordKind
    && compareUnsignedBytes({ left: left.segmentId, right: right.segmentId }) === 0;
}

function sameBytes({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  return compareUnsignedBytes({ left, right }) === 0;
}

function validateEntry({ entry, policy }: {
  entry: CompactionCopyEntry;
  policy: HizoFSMaintenancePolicy;
}): void {
  if (entry.homeReference.recordKind === HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page) {
    throw new CompactionCopyCursorError({
      code: "physical_only_record",
      message: "compaction must not byte-copy physical-only Relocation Index pages",
    });
  }
  if (entry.sourcePhysicalReference.recordKind !== entry.homeReference.recordKind
    || entry.sourcePhysicalReference.frameLength !== entry.homeReference.frameLength) {
    throw new CompactionCopyCursorError({
      code: "invalid_entry",
      message: "compaction source changes the logical record kind or frame length",
    });
  }
  if (entry.homeReference.frameLength > policy.maxCompactionBytesPerSlice) {
    throw new CompactionCopyCursorError({
      code: "frame_exceeds_slice_budget",
      message: "one immutable frame exceeds the hard compaction byte budget for a slice",
    });
  }
}

export class CompactionCopyCursor {
  #aborted = false;
  #entries: readonly CompactionCopyEntry[];
  #mappings: CompactionCopiedMapping[] = [];
  #nextIndex = 0;
  #policy: HizoFSMaintenancePolicy;

  constructor({ entries, policy }: {
    entries: readonly CompactionCopyEntry[];
    policy: HizoFSMaintenancePolicy;
  }) {
    const detached = entries.map(entry => {
      validateEntry({ entry, policy });
      return Object.freeze({
        homeReference: cloneHomeReference({ reference: entry.homeReference }),
        sourcePhysicalReference: clonePhysicalReference({ reference: entry.sourcePhysicalReference }),
      });
    }).sort((left, right) => compareHomeReferences({ left: left.homeReference, right: right.homeReference }));
    for (let index = 1; index < detached.length; index += 1) {
      const previous = detached[index - 1];
      const current = detached[index];
      if (previous !== undefined && current !== undefined
        && compareHomeReferences({ left: previous.homeReference, right: current.homeReference }) === 0) {
        throw new CompactionCopyCursorError({
          code: "duplicate_home_reference",
          message: "compaction copy plan contains one Home Record Reference more than once",
        });
      }
    }
    this.#entries = Object.freeze(detached);
    this.#policy = policy;
  }

  #completed(): CompactionCopyResult {
    return Object.freeze({
      mappings: Object.freeze(this.#mappings.map(mapping => Object.freeze({
        destinationPhysicalReference: clonePhysicalReference({ reference: mapping.destinationPhysicalReference }),
        homeReference: cloneHomeReference({ reference: mapping.homeReference }),
      }))),
      phase: "completed",
    });
  }

  async runSlice({ appendExactFrame, hasForegroundWaiter, now, readExactFrame, signal }: {
    appendExactFrame: ({ bytes, homeReference }: {
      bytes: Uint8Array;
      homeReference: HomeRecordReference;
    }) => Promise<PhysicalRecordReference>;
    hasForegroundWaiter: () => boolean;
    now: () => number;
    readExactFrame: ({ physicalReference }: {
      physicalReference: PhysicalRecordReference;
    }) => Promise<Uint8Array>;
    signal: AbortSignal | undefined;
  }): Promise<CompactionCopyResult> {
    if (this.#aborted) return Object.freeze({ phase: "aborted", reason: "copy_failed" });
    if (this.#nextIndex >= this.#entries.length) return this.#completed();
    const startedAt = now();
    if (!Number.isFinite(startedAt)) throw new TypeError("compaction clock must return a finite value");
    let copiedBytes = 0;

    while (this.#nextIndex < this.#entries.length) {
      if (signal?.aborted === true) {
        this.#aborted = true;
        return Object.freeze({ phase: "aborted", reason: "abort_requested" });
      }
      if (hasForegroundWaiter()) return Object.freeze({ phase: "copying", reason: "foreground_waiter" });
      const entry = this.#entries[this.#nextIndex];
      if (entry === undefined) throw new Error("compaction cursor index invariant failed");
      if (copiedBytes > 0 && copiedBytes + entry.homeReference.frameLength > this.#policy.maxCompactionBytesPerSlice) {
        return Object.freeze({ phase: "copying", reason: "slice_byte_limit" });
      }
      if (copiedBytes > 0) {
        const elapsed = now() - startedAt;
        if (!Number.isFinite(elapsed) || elapsed < 0) throw new TypeError("compaction clock must be monotonic and finite");
        if (elapsed >= this.#policy.softSliceMilliseconds) {
          return Object.freeze({ phase: "copying", reason: "soft_time_limit" });
        }
      }

      try {
        const readBytes = await readExactFrame({
          physicalReference: clonePhysicalReference({ reference: entry.sourcePhysicalReference }),
        });
        if (readBytes.byteLength !== entry.sourcePhysicalReference.frameLength) {
          throw new RangeError("compaction source read did not return the exact authenticated frame length");
        }
        const header = decodeRecordFrameHeader({
          bytes: readBytes.subarray(0, HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordFrameHeader),
        });
        validateRelocationMapping({
          authenticatedHeader: header,
          homeReference: entry.homeReference,
          mappedPhysicalReference: entry.sourcePhysicalReference,
        });
        const appendBytes = Uint8Array.from(readBytes);
        const expectedBytes = Uint8Array.from(appendBytes);
        const destinationPhysicalReference = await appendExactFrame({
          bytes: appendBytes,
          homeReference: cloneHomeReference({ reference: entry.homeReference }),
        });
        if (!sameBytes({ left: appendBytes, right: expectedBytes })) {
          throw new TypeError("exact-frame append adapter mutated the supplied ciphertext bytes");
        }
        validateRelocationMapping({
          authenticatedHeader: header,
          homeReference: entry.homeReference,
          mappedPhysicalReference: destinationPhysicalReference,
        });
        if (samePhysicalReference({ left: destinationPhysicalReference, right: entry.sourcePhysicalReference })) {
          throw new TypeError("compaction destination must differ from the source physical location");
        }
        this.#mappings.push(Object.freeze({
          destinationPhysicalReference: clonePhysicalReference({ reference: destinationPhysicalReference }),
          homeReference: cloneHomeReference({ reference: entry.homeReference }),
        }));
        this.#nextIndex += 1;
        copiedBytes += entry.homeReference.frameLength;
      } catch {
        this.#aborted = true;
        return Object.freeze({ phase: "aborted", reason: "copy_failed" });
      }
    }
    return this.#completed();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
