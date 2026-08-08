export type ExplicitBulkOwnerView = "fixed_read_view" | "mutable_live" | "persisted_read_subvolume";

export type ExplicitBulkLifecycleState =
  | "aborted"
  | "active"
  | "busy"
  | "committed"
  | "committing"
  | "failed"
  | "publishing"
  | "revoked";

export type ExplicitBulkLifecycleErrorCode =
  | "builder_aborted"
  | "builder_committed"
  | "builder_failed"
  | "capability_revoked"
  | "invalid_owner_view"
  | "operation_in_progress"
  | "target_not_fresh_empty";

export class ExplicitBulkLifecycleError extends Error {
  readonly code: ExplicitBulkLifecycleErrorCode;

  constructor({ code, message }: { code: ExplicitBulkLifecycleErrorCode; message: string }) {
    super(message);
    this.name = "ExplicitBulkLifecycleError";
    this.code = code;
  }
}

export class ExplicitBulkLifecycle {
  private stateValue: ExplicitBulkLifecycleState = "active";

  constructor({ ownerView, target }: {
    ownerView: ExplicitBulkOwnerView;
    target: Readonly<{ empty: boolean; fresh: boolean }>;
  }) {
    switch (ownerView) {
    case "mutable_live": break;
    case "fixed_read_view":
    case "persisted_read_subvolume":
      throw new ExplicitBulkLifecycleError({
        code: "invalid_owner_view",
        message: "explicit bulk requires a mutable live owner view",
      });
    default: ownerView satisfies never;
    }
    if (!target.fresh || !target.empty) {
      throw new ExplicitBulkLifecycleError({
        code: "target_not_fresh_empty",
        message: "explicit bulk target directory must be fresh and empty",
      });
    }
  }

  state(): ExplicitBulkLifecycleState {
    return this.stateValue;
  }

  private terminalError(): ExplicitBulkLifecycleError {
    switch (this.stateValue) {
    case "aborted": return new ExplicitBulkLifecycleError({ code: "builder_aborted", message: "explicit bulk builder was aborted" });
    case "committed": return new ExplicitBulkLifecycleError({ code: "builder_committed", message: "explicit bulk builder was already committed" });
    case "failed": return new ExplicitBulkLifecycleError({ code: "builder_failed", message: "explicit bulk builder failed and cannot be reused" });
    case "revoked": return new ExplicitBulkLifecycleError({ code: "capability_revoked", message: "explicit bulk capability was revoked by owner close" });
    case "busy":
    case "committing":
    case "publishing": return new ExplicitBulkLifecycleError({ code: "operation_in_progress", message: "explicit bulk operation is already in progress" });
    case "active": throw new Error("active explicit bulk builder has no terminal error");
    default: return this.stateValue satisfies never;
    }
  }

  private begin({ next }: { next: "busy" | "committing" }): void {
    switch (this.stateValue) {
    case "active": this.stateValue = next; return;
    case "aborted":
    case "busy":
    case "committed":
    case "committing":
    case "failed":
    case "publishing":
    case "revoked": throw this.terminalError();
    default: return this.stateValue satisfies never;
    }
  }

  private assertMutationActive(): void {
    switch (this.stateValue) {
    case "busy": return;
    case "revoked": throw this.terminalError();
    case "aborted":
    case "active":
    case "committed":
    case "committing":
    case "failed":
    case "publishing": throw new ExplicitBulkLifecycleError({ code: "operation_in_progress", message: "explicit bulk mutation is no longer active" });
    default: return this.stateValue satisfies never;
    }
  }

  async runMutation<T>({ operation }: {
    operation: ({ assertActive }: { assertActive: () => void }) => Promise<T>;
  }): Promise<T> {
    this.begin({ next: "busy" });
    try {
      const result = await operation({ assertActive: () => this.assertMutationActive() });
      this.assertMutationActive();
      this.stateValue = "active";
      return result;
    } catch (cause: unknown) {
      switch (this.stateValue) {
      case "busy": this.stateValue = "aborted"; break;
      case "revoked": break;
      case "aborted":
      case "active":
      case "committed":
      case "committing":
      case "failed":
      case "publishing": break;
      default: this.stateValue satisfies never;
      }
      throw cause;
    }
  }

  async commit<T>({ publication }: {
    publication: ({ assertPublicationAllowed }: { assertPublicationAllowed: () => void }) => Promise<T>;
  }): Promise<T> {
    this.begin({ next: "committing" });
    try {
      const result = await publication({
        assertPublicationAllowed: () => {
          switch (this.stateValue) {
          case "committing": this.stateValue = "publishing"; return;
          case "revoked": throw this.terminalError();
          case "aborted":
          case "active":
          case "busy":
          case "committed":
          case "failed":
          case "publishing": throw new ExplicitBulkLifecycleError({ code: "operation_in_progress", message: "explicit bulk publication gate is not available" });
          default: return this.stateValue satisfies never;
          }
        },
      });
      switch (this.stateValue) {
      case "publishing": this.stateValue = "committed"; return result;
      case "revoked": throw this.terminalError();
      case "aborted":
      case "active":
      case "busy":
      case "committed":
      case "committing":
      case "failed": throw new ExplicitBulkLifecycleError({ code: "builder_failed", message: "explicit bulk publication did not cross its authority gate" });
      default: return this.stateValue satisfies never;
      }
    } catch (cause: unknown) {
      switch (this.stateValue) {
      case "committing": this.stateValue = "aborted"; break;
      case "publishing": this.stateValue = "failed"; break;
      case "revoked": break;
      case "aborted":
      case "active":
      case "busy":
      case "committed":
      case "failed": break;
      default: this.stateValue satisfies never;
      }
      throw cause;
    }
  }

  ownerClose(): void {
    switch (this.stateValue) {
    case "active":
    case "busy":
    case "committing": this.stateValue = "revoked"; return;
    case "publishing": return;
    case "aborted":
    case "committed":
    case "failed":
    case "revoked": return;
    default: return this.stateValue satisfies never;
    }
  }

  abort(): void {
    switch (this.stateValue) {
    case "active": this.stateValue = "aborted"; return;
    case "aborted": return;
    case "busy":
    case "committing":
    case "publishing": throw new ExplicitBulkLifecycleError({ code: "operation_in_progress", message: "cannot abort an active explicit bulk operation" });
    case "committed": throw this.terminalError();
    case "failed":
    case "revoked": return;
    default: return this.stateValue satisfies never;
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
