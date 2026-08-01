export type WriterMutationLifecycleErrorCode =
  | "operation_in_progress"
  | "publication_revoked"
  | "writer_aborted"
  | "writer_closed";

export class WriterMutationLifecycleError extends Error {
  readonly code: WriterMutationLifecycleErrorCode;

  constructor({ code, message }: { code: WriterMutationLifecycleErrorCode; message: string }) {
    super(message);
    this.name = "WriterMutationLifecycleError";
    this.code = code;
  }
}

export type WriterMutationLifecycleState = "aborted" | "busy" | "closed" | "closing" | "open";

export class WriterMutationLifecycle {
  #closePromise: Promise<void> | undefined;
  #resolveClose: (() => void) | undefined;
  #state: WriterMutationLifecycleState = "open";

  state(): WriterMutationLifecycleState {
    return this.#state;
  }

  #assertPublicationAllowed(): void {
    switch (this.#state) {
    case "busy": return;
    case "closing":
      throw new WriterMutationLifecycleError({ code: "publication_revoked", message: "writer owner is closing" });
    case "aborted":
      throw new WriterMutationLifecycleError({ code: "writer_aborted", message: "writer was aborted" });
    case "closed":
    case "open":
      throw new WriterMutationLifecycleError({ code: "writer_closed", message: "writer is not executing this mutation" });
    default: this.#state satisfies never;
    }
  }

  async runExclusive<T>({ operation }: {
    operation: ({ assertPublicationAllowed }: { assertPublicationAllowed: () => void }) => Promise<T>;
  }): Promise<T> {
    switch (this.#state) {
    case "open": this.#state = "busy"; break;
    case "busy": throw new WriterMutationLifecycleError({ code: "operation_in_progress", message: "writer mutation operation is already in progress" });
    case "aborted": throw new WriterMutationLifecycleError({ code: "writer_aborted", message: "writer was aborted" });
    case "closing":
    case "closed": throw new WriterMutationLifecycleError({ code: "writer_closed", message: "writer is closed" });
    default: this.#state satisfies never;
    }
    try {
      return await operation({
        assertPublicationAllowed: () => this.#assertPublicationAllowed(),
      });
    } finally {
      const currentState = this.state();
      switch (currentState) {
      case "busy": this.#state = "open"; break;
      case "closing":
        this.#state = "closed";
        this.#resolveClose?.();
        this.#resolveClose = undefined;
        this.#closePromise = undefined;
        break;
      case "aborted":
      case "closed":
      case "open": break;
      default: currentState satisfies never;
      }
    }
  }

  abort(): void {
    switch (this.#state) {
    case "open": this.#state = "aborted"; return;
    case "aborted": return;
    case "busy": throw new WriterMutationLifecycleError({ code: "operation_in_progress", message: "abort overlaps an active writer mutation" });
    case "closing":
    case "closed": throw new WriterMutationLifecycleError({ code: "writer_closed", message: "writer is closed" });
    default: return this.#state satisfies never;
    }
  }

  async close(): Promise<void> {
    switch (this.#state) {
    case "open":
    case "aborted": this.#state = "closed"; return;
    case "closed": return;
    case "closing": await this.#closePromise; return;
    case "busy":
      this.#state = "closing";
      this.#closePromise = new Promise<void>(resolve => {
        this.#resolveClose = resolve;
      });
      await this.#closePromise;
      return;
    default: return this.#state satisfies never;
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
