import { encodeHomeRecordReference, type HomeRecordReference } from "@/00-storage/service/hizofs/00-format";
import {
  sameDurableGenerationIdentity,
  sameWorkingGenerationIdentity,
  type DurableGenerationIdentity,
  type WorkingGenerationIdentity,
} from "@/00-storage/service/hizofs/runtime/application-generation-identity";
import type { RuntimeMaintenanceRootRegistration } from "@/00-storage/service/hizofs/runtime/maintenance-root-registry";

export type WorkingCandidateCoordinatorPublicationState =
  | "empty"
  | "installed"
  | "outcome_unknown"
  | "poisoned"
  | "publishing";

export type WorkingCandidateOutcomeUnknownResolution =
  | "confirmed_not_published"
  | "confirmed_published";

export type WorkingCandidateCoordinatorErrorCode =
  | "admission_closed"
  | "candidate_active"
  | "candidate_identity_mismatch"
  | "candidate_missing"
  | "candidate_owner_mismatch"
  | "coordinator_poisoned"
  | "outcome_resolution_conflict"
  | "outcome_resolution_invalid"
  | "publication_closed";

export class WorkingCandidateCoordinatorError extends Error {
  override readonly cause: unknown | undefined;
  readonly code: WorkingCandidateCoordinatorErrorCode;

  constructor({ cause, code, message }: {
    cause: unknown | undefined;
    code: WorkingCandidateCoordinatorErrorCode;
    message: string;
  }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WorkingCandidateCoordinatorError";
    this.cause = cause;
    this.code = code;
  }
}

function sameBytes({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameCommitReference({ left, right }: {
  left: HomeRecordReference;
  right: HomeRecordReference;
}): boolean {
  return sameBytes({
    left: encodeHomeRecordReference({ reference: left }),
    right: encodeHomeRecordReference({ reference: right }),
  });
}

export type WorkingCandidateReleaseDisposition =
  | "confirmed_not_published"
  | "confirmed_published"
  | "discarded";

type WorkingCandidateSlot = {
  candidate: object;
  candidateDurableIdentity: DurableGenerationIdentity;
  durableBaseIdentity: DurableGenerationIdentity;
  owner: symbol | undefined;
  releaseCandidate: ({ disposition }: {
    disposition: WorkingCandidateReleaseDisposition;
  }) => void;
  rootRegistration: RuntimeMaintenanceRootRegistration;
  state: Exclude<WorkingCandidateCoordinatorPublicationState, "empty" | "poisoned">;
  workingIdentity: WorkingGenerationIdentity;
};

type WorkingCandidateReservation = Readonly<{
  durableBaseIdentity: DurableGenerationIdentity;
  operationLabel: string;
  owner: symbol;
}>;

export type WorkingCandidateAdmission<Candidate extends object> = Readonly<{
  closeWithoutCandidate: () => void;
  install: ({ candidate, candidateDurableIdentity, releaseCandidate, workingIdentity }: {
    candidate: Candidate;
    candidateDurableIdentity: DurableGenerationIdentity;
    releaseCandidate: ({ disposition }: {
      disposition: WorkingCandidateReleaseDisposition;
    }) => void;
    workingIdentity: WorkingGenerationIdentity;
  }) => void;
  matchesWorkingIdentity: ({ workingIdentity }: {
    workingIdentity: WorkingGenerationIdentity;
  }) => boolean;
  requireWorkingIdentity: () => WorkingGenerationIdentity;
  resolve: ({ outcome }: { outcome: "discarded" | "published" }) => void;
  retainInstalled: () => void;
  retainOutcomeUnknown: ({ cause }: { cause: unknown }) => void;
  selectCandidateForPublication: () => Candidate;
}>;

export type WorkingCandidatePublication<Candidate extends object> = Readonly<{
  candidate: Candidate;
  candidateDurableIdentity: DurableGenerationIdentity;
  completePublished: () => void;
  durableBaseIdentity: DurableGenerationIdentity;
  restoreInstalled: () => void;
  retainOutcomeUnknown: ({ cause }: { cause: unknown }) => void;
  workingIdentity: WorkingGenerationIdentity;
}>;

/**
 * Owns the exact latest unpublished application mutation candidate for one
 * in-memory container runtime. An operation-local admission may replace an
 * already retained candidate, but only inside the same durable publication
 * epoch. Publication is opened separately so accepted operation lifetime is
 * not coupled to a later sync or background flush.
 */
export class WorkingCandidateCoordinator {
  readonly #acquireWriterDependencyRoot: ({ commitReference }: {
    commitReference: HomeRecordReference;
  }) => RuntimeMaintenanceRootRegistration;
  #poison: unknown | undefined;
  #reservation: WorkingCandidateReservation | undefined;
  #slot: WorkingCandidateSlot | undefined;

  constructor({ acquireWriterDependencyRoot }: {
    acquireWriterDependencyRoot: ({ commitReference }: {
      commitReference: HomeRecordReference;
    }) => RuntimeMaintenanceRootRegistration;
  }) {
    this.#acquireWriterDependencyRoot = acquireWriterDependencyRoot;
  }

  publicationState(): WorkingCandidateCoordinatorPublicationState {
    const slot = this.#slot;
    if (slot !== undefined) return slot.state;
    return this.#poison === undefined ? "empty" : "poisoned";
  }

  retainedInstalledCandidateCommitReference(): HomeRecordReference | undefined {
    const slot = this.#slot;
    return slot?.state === "installed" && slot.owner === undefined
      ? slot.rootRegistration.commitReference
      : undefined;
  }

  /**
   * Clears a retained candidate only when an authenticated durable-authority
   * observation exactly names either the previous durable head or the
   * candidate whose publication outcome was unknown. A third authority is
   * not cleanup evidence: retain the root and runtime-owner lease fail-closed.
   */
  resolveOutcomeUnknownAgainstDurableAuthority({ observedDurableIdentity }: {
    observedDurableIdentity: DurableGenerationIdentity;
  }): WorkingCandidateOutcomeUnknownResolution {
    const slot = this.#slot;
    if (slot === undefined || slot.state !== "outcome_unknown" || this.#poison === undefined) {
      throw new WorkingCandidateCoordinatorError({
        cause: this.#poison,
        code: "outcome_resolution_invalid",
        message: "runtime working candidate has no outcome-unknown authority to resolve",
      });
    }
    const resolution = sameDurableGenerationIdentity({
      left: observedDurableIdentity,
      right: slot.candidateDurableIdentity,
    })
      ? "confirmed_published"
      : sameDurableGenerationIdentity({
        left: observedDurableIdentity,
        right: slot.durableBaseIdentity,
      })
        ? "confirmed_not_published"
        : undefined;
    if (resolution === undefined) {
      throw new WorkingCandidateCoordinatorError({
        cause: this.#poison,
        code: "outcome_resolution_conflict",
        message: "observed durable authority matches neither the retained candidate nor its durable base",
      });
    }
    const failures: unknown[] = [];
    try {
      slot.releaseCandidate({ disposition: resolution });
    } catch (cause: unknown) {
      failures.push(cause);
    }
    try {
      slot.rootRegistration.release();
    } catch (cause: unknown) {
      failures.push(cause);
    }
    if (failures.length > 0) {
      const cause = failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "resolved working-candidate cleanup failed");
      this.#poison = cause;
      throw new WorkingCandidateCoordinatorError({
        cause,
        code: "coordinator_poisoned",
        message: "runtime working candidate was resolved but its retained authority could not be released",
      });
    }
    this.#slot = undefined;
    this.#reservation = undefined;
    this.#poison = undefined;
    return resolution;
  }

  #assertCoordinatorHealthy({ operationLabel }: { operationLabel: string }): void {
    if (this.#poison !== undefined) {
      throw new WorkingCandidateCoordinatorError({
        cause: this.#poison,
        code: "coordinator_poisoned",
        message: `${operationLabel} cannot use a poisoned working-candidate coordinator`,
      });
    }
  }

  #assertAdmissionAvailable({ durableBaseIdentity, operationLabel }: {
    durableBaseIdentity: DurableGenerationIdentity;
    operationLabel: string;
  }): void {
    this.#assertCoordinatorHealthy({ operationLabel });
    if (this.#reservation !== undefined) {
      throw new WorkingCandidateCoordinatorError({
        cause: undefined,
        code: "candidate_active",
        message: `${operationLabel} cannot replace an active candidate admission`,
      });
    }
    const current = this.#slot;
    if (current === undefined) return;
    if (current.state !== "installed" || current.owner !== undefined) {
      throw new WorkingCandidateCoordinatorError({
        cause: undefined,
        code: "candidate_active",
        message: `${operationLabel} cannot replace a candidate while publication is active`,
      });
    }
    if (!sameDurableGenerationIdentity({ left: current.durableBaseIdentity, right: durableBaseIdentity })) {
      throw new WorkingCandidateCoordinatorError({
        cause: undefined,
        code: "candidate_identity_mismatch",
        message: `${operationLabel} durable base differs from the retained dirty publication epoch`,
      });
    }
  }

  openAdmission<Candidate extends object>({ durableBaseIdentity, operationLabel }: {
    durableBaseIdentity: DurableGenerationIdentity;
    operationLabel: string;
  }): WorkingCandidateAdmission<Candidate> {
    this.#assertAdmissionAvailable({ durableBaseIdentity, operationLabel });
    const owner = Symbol("working-candidate-admission");
    this.#reservation = Object.freeze({ durableBaseIdentity, operationLabel, owner });
    let active = true;
    let replacedSlot: WorkingCandidateSlot | undefined;

    const assertActive = (): void => {
      if (!active) {
        throw new WorkingCandidateCoordinatorError({
          cause: undefined,
          code: "admission_closed",
          message: `${operationLabel} working-candidate admission is closed`,
        });
      }
    };
    const requireReservation = (): WorkingCandidateReservation => {
      assertActive();
      const reservation = this.#reservation;
      if (reservation === undefined || reservation.owner !== owner) {
        throw new WorkingCandidateCoordinatorError({
          cause: undefined,
          code: "candidate_owner_mismatch",
          message: `${operationLabel} no longer owns the runtime candidate admission`,
        });
      }
      return reservation;
    };
    const requireSlot = (): WorkingCandidateSlot => {
      requireReservation();
      const slot = this.#slot;
      if (slot === undefined) {
        throw new WorkingCandidateCoordinatorError({
          cause: undefined,
          code: "candidate_missing",
          message: `${operationLabel} has not installed a runtime working candidate`,
        });
      }
      if (slot.owner !== owner) {
        throw new WorkingCandidateCoordinatorError({
          cause: undefined,
          code: "candidate_owner_mismatch",
          message: `${operationLabel} does not own the installed runtime working candidate`,
        });
      }
      return slot;
    };
    const closeInstalledSlot = ({ disposition, restorePrevious }: {
      disposition: WorkingCandidateReleaseDisposition;
      restorePrevious: boolean;
    }): void => {
      const slot = requireSlot();
      this.#slot = restorePrevious ? replacedSlot : undefined;
      this.#reservation = undefined;
      active = false;
      const previous = replacedSlot;
      replacedSlot = undefined;
      const failures: unknown[] = [];
      try {
        slot.releaseCandidate({ disposition });
      } catch (cause: unknown) {
        failures.push(cause);
      }
      try {
        slot.rootRegistration.release();
      } catch (cause: unknown) {
        failures.push(cause);
      }
      if (!restorePrevious && previous !== undefined) {
        try {
          previous.releaseCandidate({ disposition: "discarded" });
        } catch (cause: unknown) {
          failures.push(cause);
        }
        try {
          previous.rootRegistration.release();
        } catch (cause: unknown) {
          failures.push(cause);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, `${operationLabel} candidate root cleanup failed`);
      }
    };

    return Object.freeze({
      closeWithoutCandidate: () => {
        const reservation = requireReservation();
        const slot = this.#slot;
        if (slot?.owner === owner) {
          throw new WorkingCandidateCoordinatorError({
            cause: undefined,
            code: "candidate_active",
            message: `${operationLabel} cannot close its admission while its candidate is installed`,
          });
        }
        if (this.#reservation !== reservation) {
          throw new WorkingCandidateCoordinatorError({
            cause: undefined,
            code: "candidate_owner_mismatch",
            message: `${operationLabel} admission ownership changed unexpectedly`,
          });
        }
        this.#reservation = undefined;
        active = false;
      },
      install: ({ candidate, candidateDurableIdentity, releaseCandidate, workingIdentity }) => {
        const reservation = requireReservation();
        const current = this.#slot;
        if (current?.owner === owner) {
          throw new WorkingCandidateCoordinatorError({
            cause: undefined,
            code: "candidate_active",
            message: `${operationLabel} cannot replace its own installed runtime candidate`,
          });
        }
        if (
          !sameCommitReference({
            left: candidateDurableIdentity.commitReference,
            right: workingIdentity.commitReference,
          })
          || !sameBytes({ left: candidateDurableIdentity.mutationId, right: workingIdentity.mutationId })
          || candidateDurableIdentity.commitSequence !== reservation.durableBaseIdentity.commitSequence + 1n
        ) {
          throw new WorkingCandidateCoordinatorError({
            cause: undefined,
            code: "candidate_identity_mismatch",
            message: `${operationLabel} durable candidate identity disagrees with its working identity or durable base`,
          });
        }
        const rootRegistration = this.#acquireWriterDependencyRoot({
          commitReference: candidateDurableIdentity.commitReference,
        });
        if (current !== undefined && (
          current.state !== "installed"
          || current.owner !== undefined
          || !sameDurableGenerationIdentity({
            left: current.durableBaseIdentity,
            right: reservation.durableBaseIdentity,
          })
        )) {
          rootRegistration.release();
          throw new WorkingCandidateCoordinatorError({
            cause: undefined,
            code: "candidate_active",
            message: `${operationLabel} cannot replace the current runtime candidate`,
          });
        }
        replacedSlot = current;
        this.#slot = {
          candidate,
          candidateDurableIdentity,
          durableBaseIdentity: reservation.durableBaseIdentity,
          owner,
          releaseCandidate,
          rootRegistration,
          state: "installed",
          workingIdentity,
        };
      },
      matchesWorkingIdentity: ({ workingIdentity }) => {
        const slot = requireSlot();
        return sameWorkingGenerationIdentity({ left: slot.workingIdentity, right: workingIdentity });
      },
      requireWorkingIdentity: () => requireSlot().workingIdentity,
      resolve: ({ outcome }) => {
        switch (outcome) {
        case "discarded": closeInstalledSlot({ disposition: "discarded", restorePrevious: true }); return;
        case "published": closeInstalledSlot({ disposition: "confirmed_published", restorePrevious: false }); return;
        default: return outcome satisfies never;
        }
      },
      retainInstalled: () => {
        const slot = requireSlot();
        switch (slot.state) {
        case "installed": break;
        case "outcome_unknown":
        case "publishing": throw new WorkingCandidateCoordinatorError({
          cause: undefined,
          code: "candidate_active",
          message: `${operationLabel} cannot retain a candidate after publication has started`,
        });
        default: return slot.state satisfies never;
        }
        const previous = replacedSlot;
        replacedSlot = undefined;
        slot.owner = undefined;
        this.#reservation = undefined;
        active = false;
        if (previous !== undefined) {
          const failures: unknown[] = [];
          try {
            previous.releaseCandidate({ disposition: "discarded" });
          } catch (cause: unknown) {
            failures.push(cause);
          }
          try {
            previous.rootRegistration.release();
          } catch (cause: unknown) {
            failures.push(cause);
          }
          if (failures.length > 0) {
            const cause = failures.length === 1
              ? failures[0]
              : new AggregateError(failures, `${operationLabel} replaced candidate cleanup failed`);
            slot.state = "outcome_unknown";
            this.#poison = cause;
            throw new WorkingCandidateCoordinatorError({
              cause,
              code: "coordinator_poisoned",
              message: `${operationLabel} retained the new candidate but failed to release the replaced candidate authority`,
            });
          }
        }
      },
      retainOutcomeUnknown: ({ cause }) => {
        const slot = requireSlot();
        slot.state = "outcome_unknown";
        const previous = replacedSlot;
        replacedSlot = undefined;
        if (previous !== undefined) {
          const failures: unknown[] = [];
          try {
            previous.releaseCandidate({ disposition: "discarded" });
          } catch (cleanupCause: unknown) {
            failures.push(cleanupCause);
          }
          try {
            previous.rootRegistration.release();
          } catch (cleanupCause: unknown) {
            failures.push(cleanupCause);
          }
          if (failures.length > 0) {
            cause = new AggregateError(
              [cause, ...failures],
              `${operationLabel} outcome-unknown replacement cleanup failed`,
            );
          }
        }
        slot.owner = undefined;
        this.#poison = cause;
        this.#reservation = undefined;
        active = false;
      },
      selectCandidateForPublication: () => {
        const slot = requireSlot();
        switch (slot.state) {
        case "installed": slot.state = "publishing"; break;
        case "publishing": break;
        case "outcome_unknown": throw new WorkingCandidateCoordinatorError({
          cause: this.#poison,
          code: "coordinator_poisoned",
          message: `${operationLabel} cannot publish an unresolved runtime working candidate`,
        });
        default: return slot.state satisfies never;
        }
        return slot.candidate as Candidate;
      },
    });
  }

  openCurrentPublication<Candidate extends object>(): WorkingCandidatePublication<Candidate> {
    this.#assertCoordinatorHealthy({ operationLabel: "runtime candidate publication" });
    if (this.#reservation !== undefined) {
      throw new WorkingCandidateCoordinatorError({
        cause: undefined,
        code: "candidate_active",
        message: "runtime candidate publication cannot start while mutation admission is active",
      });
    }
    const slot = this.#slot;
    if (slot === undefined) {
      throw new WorkingCandidateCoordinatorError({
        cause: undefined,
        code: "candidate_missing",
        message: "runtime has no installed candidate to publish",
      });
    }
    if (slot.state !== "installed" || slot.owner !== undefined) {
      throw new WorkingCandidateCoordinatorError({
        cause: undefined,
        code: "candidate_active",
        message: "runtime candidate is not available for publication",
      });
    }
    slot.state = "publishing";
    let active = true;
    const requireActive = (): WorkingCandidateSlot => {
      if (!active || this.#slot !== slot || slot.state !== "publishing") {
        throw new WorkingCandidateCoordinatorError({
          cause: undefined,
          code: "publication_closed",
          message: "runtime candidate publication capability is closed",
        });
      }
      return slot;
    };
    return Object.freeze({
      candidate: slot.candidate as Candidate,
      candidateDurableIdentity: slot.candidateDurableIdentity,
      completePublished: () => {
        const current = requireActive();
        active = false;
        this.#slot = undefined;
        const failures: unknown[] = [];
        try {
          current.releaseCandidate({ disposition: "confirmed_published" });
        } catch (cause: unknown) {
          failures.push(cause);
        }
        try {
          current.rootRegistration.release();
        } catch (cause: unknown) {
          failures.push(cause);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, "published working-candidate cleanup failed");
        }
      },
      durableBaseIdentity: slot.durableBaseIdentity,
      restoreInstalled: () => {
        const current = requireActive();
        active = false;
        current.state = "installed";
      },
      retainOutcomeUnknown: ({ cause }) => {
        const current = requireActive();
        active = false;
        current.state = "outcome_unknown";
        this.#poison = cause;
      },
      workingIdentity: slot.workingIdentity,
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
