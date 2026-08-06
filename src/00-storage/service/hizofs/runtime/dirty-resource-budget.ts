import type { HizoFSLazyDurabilityPolicy } from "@/00-storage/service/hizofs/runtime/runtime-policy";

export type DirtyResourceBudgetErrorCode =
  | "admission_closed"
  | "dirty_metadata_byte_limit_reached"
  | "dirty_mutation_limit_reached"
  | "invalid_resource_delta"
  | "publication_with_active_admission"
  | "unpublished_physical_byte_limit_reached";

export class DirtyResourceBudgetError extends Error {
  readonly code: DirtyResourceBudgetErrorCode;

  constructor({ code, message }: { code: DirtyResourceBudgetErrorCode; message: string }) {
    super(message);
    this.name = "DirtyResourceBudgetError";
    this.code = code;
  }
}

export type DirtyResourceBudgetSnapshot = Readonly<{
  acceptedMutationCount: number;
  dirtyMetadataBytes: number;
  pendingAdmissionCount: number;
  unpublishedPhysicalBytes: number;
}>;

export type DirtyResourceAdmission = Readonly<{
  commitAccepted: () => void;
  replaceReservation: ({ dirtyMetadataBytes, unpublishedPhysicalBytes }: ResourceDelta) => void;
  rollback: () => void;
}>;

type ResourceDelta = Readonly<{
  dirtyMetadataBytes: number;
  unpublishedPhysicalBytes: number;
}>;

function validateDelta({ name, value }: { name: string; value: number }): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DirtyResourceBudgetError({
      code: "invalid_resource_delta",
      message: `${name} must be a non-negative safe integer`,
    });
  }
}

function checkedAdd({ left, name, right }: { left: number; name: string; right: number }): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new DirtyResourceBudgetError({
      code: "invalid_resource_delta",
      message: `${name} exceeds the JavaScript safe-integer range`,
    });
  }
  return result;
}

/**
 * Reserves dirty-epoch resources before candidate preparation can consume
 * them. Pending admissions count against every limit so concurrent callers
 * cannot individually pass preflight and collectively exceed a hard bound.
 */
export class DirtyResourceBudget {
  #acceptedMutationCount = 0;
  #dirtyMetadataBytes = 0;
  readonly #limits: Pick<
    HizoFSLazyDurabilityPolicy,
    | "maximumAcceptedMutationsPerDirtyEpoch"
    | "maximumDirtyMetadataBytes"
    | "maximumUnpublishedPhysicalBytes"
  >;
  #pendingAdmissionCount = 0;
  #unpublishedPhysicalBytes = 0;

  constructor({ policy }: { policy: HizoFSLazyDurabilityPolicy }) {
    this.#limits = Object.freeze({
      maximumAcceptedMutationsPerDirtyEpoch: policy.maximumAcceptedMutationsPerDirtyEpoch,
      maximumDirtyMetadataBytes: policy.maximumDirtyMetadataBytes,
      maximumUnpublishedPhysicalBytes: policy.maximumUnpublishedPhysicalBytes,
    });
  }

  snapshot(): DirtyResourceBudgetSnapshot {
    return Object.freeze({
      acceptedMutationCount: this.#acceptedMutationCount,
      dirtyMetadataBytes: this.#dirtyMetadataBytes,
      pendingAdmissionCount: this.#pendingAdmissionCount,
      unpublishedPhysicalBytes: this.#unpublishedPhysicalBytes,
    });
  }

  reserveAdmission({ dirtyMetadataBytes, unpublishedPhysicalBytes }: ResourceDelta): DirtyResourceAdmission {
    validateDelta({ name: "dirtyMetadataBytes", value: dirtyMetadataBytes });
    validateDelta({ name: "unpublishedPhysicalBytes", value: unpublishedPhysicalBytes });
    const acceptedMutationCount = checkedAdd({
      left: this.#acceptedMutationCount,
      name: "accepted mutation count",
      right: this.#pendingAdmissionCount + 1,
    });
    if (acceptedMutationCount > this.#limits.maximumAcceptedMutationsPerDirtyEpoch) {
      throw new DirtyResourceBudgetError({
        code: "dirty_mutation_limit_reached",
        message: "dirty epoch accepted-mutation limit reached",
      });
    }
    const nextDirtyMetadataBytes = checkedAdd({
      left: this.#dirtyMetadataBytes,
      name: "dirty metadata bytes",
      right: dirtyMetadataBytes,
    });
    if (nextDirtyMetadataBytes > this.#limits.maximumDirtyMetadataBytes) {
      throw new DirtyResourceBudgetError({
        code: "dirty_metadata_byte_limit_reached",
        message: "dirty metadata byte limit reached",
      });
    }
    const nextUnpublishedPhysicalBytes = checkedAdd({
      left: this.#unpublishedPhysicalBytes,
      name: "unpublished physical bytes",
      right: unpublishedPhysicalBytes,
    });
    if (nextUnpublishedPhysicalBytes > this.#limits.maximumUnpublishedPhysicalBytes) {
      throw new DirtyResourceBudgetError({
        code: "unpublished_physical_byte_limit_reached",
        message: "unpublished physical byte limit reached",
      });
    }
    this.#pendingAdmissionCount += 1;
    this.#dirtyMetadataBytes = nextDirtyMetadataBytes;
    this.#unpublishedPhysicalBytes = nextUnpublishedPhysicalBytes;
    let active = true;
    let reservedDirtyMetadataBytes = dirtyMetadataBytes;
    let reservedUnpublishedPhysicalBytes = unpublishedPhysicalBytes;
    const requireActive = (): void => {
      if (!active) {
        throw new DirtyResourceBudgetError({
          code: "admission_closed",
          message: "dirty resource admission is already closed",
        });
      }
    };
    const close = (): void => {
      requireActive();
      active = false;
      this.#pendingAdmissionCount -= 1;
    };
    return Object.freeze({
      commitAccepted: () => {
        close();
        this.#acceptedMutationCount += 1;
      },
      replaceReservation: ({
        dirtyMetadataBytes: replacementDirtyMetadataBytes,
        unpublishedPhysicalBytes: replacementUnpublishedPhysicalBytes,
      }) => {
        requireActive();
        validateDelta({ name: "dirtyMetadataBytes", value: replacementDirtyMetadataBytes });
        validateDelta({ name: "unpublishedPhysicalBytes", value: replacementUnpublishedPhysicalBytes });
        const retainedDirtyMetadataBytes = this.#dirtyMetadataBytes - reservedDirtyMetadataBytes;
        const retainedUnpublishedPhysicalBytes = this.#unpublishedPhysicalBytes - reservedUnpublishedPhysicalBytes;
        const replacementDirtyTotal = checkedAdd({
          left: retainedDirtyMetadataBytes,
          name: "dirty metadata bytes",
          right: replacementDirtyMetadataBytes,
        });
        if (replacementDirtyTotal > this.#limits.maximumDirtyMetadataBytes) {
          throw new DirtyResourceBudgetError({
            code: "dirty_metadata_byte_limit_reached",
            message: "dirty metadata byte limit reached",
          });
        }
        const replacementPhysicalTotal = checkedAdd({
          left: retainedUnpublishedPhysicalBytes,
          name: "unpublished physical bytes",
          right: replacementUnpublishedPhysicalBytes,
        });
        if (replacementPhysicalTotal > this.#limits.maximumUnpublishedPhysicalBytes) {
          throw new DirtyResourceBudgetError({
            code: "unpublished_physical_byte_limit_reached",
            message: "unpublished physical byte limit reached",
          });
        }
        this.#dirtyMetadataBytes = replacementDirtyTotal;
        this.#unpublishedPhysicalBytes = replacementPhysicalTotal;
        reservedDirtyMetadataBytes = replacementDirtyMetadataBytes;
        reservedUnpublishedPhysicalBytes = replacementUnpublishedPhysicalBytes;
      },
      rollback: () => {
        close();
        this.#dirtyMetadataBytes -= reservedDirtyMetadataBytes;
        this.#unpublishedPhysicalBytes -= reservedUnpublishedPhysicalBytes;
      },
    });
  }

  resetAfterDurablePublication(): void {
    if (this.#pendingAdmissionCount !== 0) {
      throw new DirtyResourceBudgetError({
        code: "publication_with_active_admission",
        message: "dirty resource budget cannot reset while mutation admission is active",
      });
    }
    this.#acceptedMutationCount = 0;
    this.#dirtyMetadataBytes = 0;
    this.#unpublishedPhysicalBytes = 0;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
