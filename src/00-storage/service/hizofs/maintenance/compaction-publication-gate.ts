import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  compareUnsignedBytes,
  createPhysicalRecordReference,
  parseSegmentId,
  segmentIdToLowercaseHex,
  type PhysicalRecordReference,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";

export type CompactionPublicationPhase =
  | "aborted"
  | "converged"
  | "copying"
  | "destination_durable"
  | "publishing"
  | "relocation_index_durable"
  | "roots_revalidated";

export type PreparedCompactionSourceDeletionLease = Readonly<{
  release: () => void;
  segmentId: SegmentId;
}>;

export type CompactionPublicationGateErrorCode =
  | "duplicate_source_segment"
  | "invalid_phase"
  | "invalid_relocation_root"
  | "no_source_segments"
  | "published_root_mismatch"
  | "source_not_reclaimable";

export class CompactionPublicationGateError extends Error {
  readonly code: CompactionPublicationGateErrorCode;

  constructor({ code, message }: { code: CompactionPublicationGateErrorCode; message: string }) {
    super(message);
    this.name = "CompactionPublicationGateError";
    this.code = code;
  }
}

function cloneSegmentId({ segmentId }: { segmentId: SegmentId }): SegmentId {
  return parseSegmentId({ bytes: segmentId });
}

function sameOptionalPhysicalReference({ left, right }: {
  left: PhysicalRecordReference | null;
  right: PhysicalRecordReference | null;
}): boolean {
  if (left === null || right === null) return left === right;
  return left.byteOffset === right.byteOffset
    && left.frameLength === right.frameLength
    && left.recordKind === right.recordKind
    && compareUnsignedBytes({ left: left.segmentId, right: right.segmentId }) === 0;
}

function validateRelocationRoot({ reference }: { reference: PhysicalRecordReference | null }): void {
  if (reference !== null
    && reference.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page) {
    throw new CompactionPublicationGateError({
      code: "invalid_relocation_root",
      message: "compaction publication root must identify a physical-only Relocation Index page",
    });
  }
}

export class CompactionPublicationGate {
  #phase: CompactionPublicationPhase = "copying";
  #relocationRoot: PhysicalRecordReference | null | undefined;
  #sourceSegmentIds: readonly SegmentId[];

  constructor({ sourceSegmentIds }: { sourceSegmentIds: readonly SegmentId[] }) {
    if (sourceSegmentIds.length === 0) {
      throw new CompactionPublicationGateError({
        code: "no_source_segments",
        message: "compaction publication requires at least one protected source segment",
      });
    }
    const unique = new Map<string, SegmentId>();
    for (const segmentId of sourceSegmentIds) {
      const detached = cloneSegmentId({ segmentId });
      const identity = segmentIdToLowercaseHex({ id: detached });
      if (unique.has(identity)) {
        throw new CompactionPublicationGateError({
          code: "duplicate_source_segment",
          message: "compaction source segment set contains a duplicate identity",
        });
      }
      unique.set(identity, detached);
    }
    this.#sourceSegmentIds = Object.freeze([...unique.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, segmentId]) => cloneSegmentId({ segmentId })));
  }

  get phase(): CompactionPublicationPhase {
    return this.#phase;
  }

  #require({ expected, operation }: {
    expected: CompactionPublicationPhase;
    operation: string;
  }): void {
    if (this.#phase !== expected) {
      throw new CompactionPublicationGateError({
        code: "invalid_phase",
        message: `${operation} requires ${expected}, not ${this.#phase}`,
      });
    }
  }

  abort(): void {
    switch (this.#phase) {
    case "aborted":
      return;
    case "converged":
      throw new CompactionPublicationGateError({
        code: "invalid_phase",
        message: "a converged compaction publication cannot be aborted",
      });
    case "copying":
    case "destination_durable":
    case "publishing":
    case "relocation_index_durable":
    case "roots_revalidated":
      this.#phase = "aborted";
      return;
    default:
      this.#phase satisfies never;
    }
  }

  markDestinationFramesDurable(): void {
    this.#require({ expected: "copying", operation: "destination durability" });
    this.#phase = "destination_durable";
  }

  markRelocationIndexDurable({ rootPhysicalReference }: {
    rootPhysicalReference: PhysicalRecordReference | null;
  }): void {
    this.#require({ expected: "destination_durable", operation: "Relocation Index durability" });
    validateRelocationRoot({ reference: rootPhysicalReference });
    this.#relocationRoot = rootPhysicalReference === null
      ? null
      : createPhysicalRecordReference({ fields: rootPhysicalReference });
    this.#phase = "relocation_index_durable";
  }

  markRootsRevalidated(): void {
    this.#require({ expected: "relocation_index_durable", operation: "root revalidation" });
    this.#phase = "roots_revalidated";
  }

  markPublicationStarted(): void {
    this.#require({ expected: "roots_revalidated", operation: "authority publication" });
    this.#phase = "publishing";
  }

  markCopiesConverged({ publishedRelocationRootPhysicalReference }: {
    publishedRelocationRootPhysicalReference: PhysicalRecordReference | null;
  }): void {
    this.#require({ expected: "publishing", operation: "Superblock convergence" });
    validateRelocationRoot({ reference: publishedRelocationRootPhysicalReference });
    if (this.#relocationRoot === undefined || !sameOptionalPhysicalReference({
      left: this.#relocationRoot,
      right: publishedRelocationRootPhysicalReference,
    })) {
      this.#phase = "aborted";
      throw new CompactionPublicationGateError({
        code: "published_root_mismatch",
        message: "converged Superblock authority does not identify the durable rebuilt Relocation Index",
      });
    }
    this.#phase = "converged";
  }

  async prepareSourceDeletionLeases({ beginDeletion }: {
    beginDeletion: ({ segmentId }: { segmentId: SegmentId }) => Promise<Readonly<{ release: () => void }>>;
  }): Promise<readonly PreparedCompactionSourceDeletionLease[]> {
    const eligible = this.sourceSegmentsEligibleForLaterGc();
    const acquired: PreparedCompactionSourceDeletionLease[] = [];
    try {
      for (const segmentId of eligible) {
        const lease = await beginDeletion({ segmentId: cloneSegmentId({ segmentId }) });
        acquired.push(Object.freeze({
          release: lease.release,
          segmentId: cloneSegmentId({ segmentId }),
        }));
      }
      return Object.freeze(acquired);
    } catch (cause: unknown) {
      for (const lease of acquired.reverse()) lease.release();
      throw cause;
    }
  }

  sourceSegmentsEligibleForLaterGc(): readonly SegmentId[] {
    switch (this.#phase) {
    case "converged":
      return Object.freeze(this.#sourceSegmentIds.map(segmentId => cloneSegmentId({ segmentId })));
    case "aborted":
    case "copying":
    case "destination_durable":
    case "publishing":
    case "relocation_index_durable":
    case "roots_revalidated":
      throw new CompactionPublicationGateError({
        code: "source_not_reclaimable",
        message: "source segments remain protected until both Superblock copies converge",
      });
    default:
      return this.#phase satisfies never;
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
