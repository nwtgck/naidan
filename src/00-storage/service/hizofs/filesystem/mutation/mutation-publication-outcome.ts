export type MutationPublicationFailureOutcome = Readonly<
  | { type: "committed_redundancy_degraded" }
  | { type: "not_published" }
  | { type: "outcome_resolution_required" }
>;

export type MutationPublicationOutcome = MutationPublicationFailureOutcome | Readonly<{ type: "succeeded" }>;

type MutationPublicationPhase =
  | "first_authority_verified"
  | "first_authority_write_started"
  | "prepared"
  | "second_copy_converged";

export class MutationPublicationOutcomeTracker {
  private phase: MutationPublicationPhase = "prepared";

  canAbort(): boolean {
    switch (this.phase) {
    case "prepared": return true;
    case "first_authority_write_started":
    case "first_authority_verified":
    case "second_copy_converged": return false;
    default: return this.phase satisfies never;
    }
  }

  startFirstAuthorityWrite(): void {
    switch (this.phase) {
    case "prepared":
      this.phase = "first_authority_write_started";
      return;
    case "first_authority_write_started":
    case "first_authority_verified":
    case "second_copy_converged": throw new Error("first authority write has already started");
    default: return this.phase satisfies never;
    }
  }

  markFirstAuthorityVerified(): void {
    switch (this.phase) {
    case "first_authority_write_started":
      this.phase = "first_authority_verified";
      return;
    case "prepared":
    case "first_authority_verified":
    case "second_copy_converged": throw new Error("first authority write must start before verification");
    default: return this.phase satisfies never;
    }
  }

  markSecondCopyConverged(): void {
    switch (this.phase) {
    case "first_authority_verified":
      this.phase = "second_copy_converged";
      return;
    case "prepared":
    case "first_authority_write_started":
    case "second_copy_converged": throw new Error("first authority copy must be proof-valid before second-copy convergence");
    default: return this.phase satisfies never;
    }
  }

  classifyFailure(): MutationPublicationFailureOutcome {
    switch (this.phase) {
    case "prepared": return { type: "not_published" };
    case "first_authority_write_started": return { type: "outcome_resolution_required" };
    case "first_authority_verified": return { type: "committed_redundancy_degraded" };
    case "second_copy_converged": throw new Error("successful publication cannot be classified as a failure");
    default: return this.phase satisfies never;
    }
  }

  outcome(): MutationPublicationOutcome {
    switch (this.phase) {
    case "second_copy_converged": return { type: "succeeded" };
    case "prepared": return { type: "not_published" };
    case "first_authority_write_started": return { type: "outcome_resolution_required" };
    case "first_authority_verified": return { type: "committed_redundancy_degraded" };
    default: return this.phase satisfies never;
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
