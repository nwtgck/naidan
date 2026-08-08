export type SessionLifecycleState = "closed" | "closing" | "open";

export type SessionLifecycleErrorCode =
  | "capability_closed"
  | "publication_revoked";

export class SessionLifecycleError extends Error {
  readonly code: SessionLifecycleErrorCode;

  constructor({ code, message }: { code: SessionLifecycleErrorCode; message: string }) {
    super(message);
    this.name = "SessionLifecycleError";
    this.code = code;
  }
}

export type SessionOperationAuthority = Readonly<{
  assertCapabilityReturnAllowed: () => void;
  assertPublicationAllowed: () => void;
  commitPointCrossed: () => boolean;
  markCommitPointCrossed: () => void;
}>;

export type OwnedSessionChild = Readonly<{
  close: () => Promise<void>;
  revoke: () => void;
}>;

export type SessionChildRegistration = Readonly<{
  releaseOwnership: () => void;
}>;

export class SessionLifecycle {
  private activeOperations = 0;
  private children = new Map<symbol, OwnedSessionChild>();
  private closePromise: Promise<void> | undefined;
  private idlePromise: Promise<void> | undefined;
  private releaseResources: () => Promise<void>;
  private resolveIdle: (() => void) | undefined;
  private stateValue: SessionLifecycleState = "open";

  constructor({ releaseResources }: {
    releaseResources: () => Promise<void>;
  }) {
    this.releaseResources = releaseResources;
  }

  state(): SessionLifecycleState {
    return this.stateValue;
  }

  assertCapabilityOpen(): void {
    this.assertOpen({
      code: "capability_closed",
      message: "session capability is closing or closed",
    });
  }

  private assertOpen({ code, message }: {
    code: SessionLifecycleErrorCode;
    message: string;
  }): void {
    switch (this.stateValue) {
    case "open": return;
    case "closing":
    case "closed": throw new SessionLifecycleError({ code, message });
    default: return this.stateValue satisfies never;
    }
  }

  registerChild({ child }: { child: OwnedSessionChild }): SessionChildRegistration {
    this.assertOpen({
      code: "capability_closed",
      message: "session no longer accepts child capabilities",
    });
    const token = Symbol("session-child");
    this.children.set(token, child);
    let owned = true;
    return {
      releaseOwnership: () => {
        if (!owned) return;
        owned = false;
        this.children.delete(token);
      },
    };
  }

  async runOperation<T>({ operation }: {
    operation: ({ authority }: { authority: SessionOperationAuthority }) => Promise<T>;
  }): Promise<T> {
    this.assertOpen({
      code: "capability_closed",
      message: "session is closing or closed",
    });
    this.activeOperations += 1;
    let crossedCommitPoint = false;
    const assertPublicationAllowed = (): void => {
      if (crossedCommitPoint) return;
      this.assertOpen({
        code: "publication_revoked",
        message: "session close revoked publication before the authority commit point",
      });
    };
    try {
      return await operation({
        authority: {
          assertCapabilityReturnAllowed: () => this.assertOpen({
            code: "capability_closed",
            message: "session close won the capability return race",
          }),
          assertPublicationAllowed,
          commitPointCrossed: () => crossedCommitPoint,
          markCommitPointCrossed: () => {
            assertPublicationAllowed();
            crossedCommitPoint = true;
          },
        },
      });
    } finally {
      this.activeOperations -= 1;
      if (this.activeOperations === 0) {
        this.resolveIdle?.();
        this.resolveIdle = undefined;
        this.idlePromise = undefined;
      }
    }
  }

  private async waitForOperations(): Promise<void> {
    if (this.activeOperations === 0) return;
    this.idlePromise ??= new Promise<void>(resolve => {
      this.resolveIdle = resolve;
    });
    await this.idlePromise;
  }

  async close(): Promise<void> {
    switch (this.stateValue) {
    case "closed": return;
    case "closing": await this.closePromise; return;
    case "open": this.stateValue = "closing"; break;
    default: return this.stateValue satisfies never;
    }

    const closeCompletion = Promise.withResolvers<void>();
    // Publish the shared completion promise before invoking owner callbacks.
    // A revoke callback may synchronously re-enter close(); it must observe the
    // same in-flight close rather than resolving while cleanup is still active.
    this.closePromise = closeCompletion.promise;
    const children = [...this.children.values()];
    const errors: unknown[] = [];
    void (async () => {
      for (const child of children) {
        try {
          child.revoke();
        } catch (cause: unknown) {
          errors.push(cause);
        }
      }
      await this.waitForOperations();
      for (const child of children) {
        try {
          await child.close();
        } catch (cause: unknown) {
          errors.push(cause);
        }
      }
      this.children.clear();
      try {
        await this.releaseResources();
      } catch (cause: unknown) {
        errors.push(cause);
      }
      this.stateValue = "closed";
      if (errors.length > 0) throw new AggregateError(errors, "session close encountered child or resource cleanup failures");
    })().then(closeCompletion.resolve, closeCompletion.reject);
    await closeCompletion.promise;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
