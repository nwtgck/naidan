import type { CrossRealmRuntimeOwnerLease } from "@/00-storage/service/hizofs/runtime/cross-realm-lock-coordinator";

/**
 * `wait` deliberately has no implicit timeout or caller cancellation in V1:
 * revoking only a caller wait without cancelling the shared cross-realm lock
 * request can leave a ghost owner acquisition. Latency-sensitive callers must
 * choose `reject_if_busy`, which never joins the owner wait queue.
 */
export type HizoFSRuntimeOwnerOpenPolicy = "reject_if_busy" | "wait";

export type RuntimeOwnerCoordinatorState =
  | "acquiring"
  | "failed"
  | "idle"
  | "owned"
  | "releasing";

export type RuntimeOwnerAttachment = Readonly<{
  release: () => Promise<void>;
}>;

export type RuntimeOwnerCoordinatorErrorCode =
  | "coordinator_failed"
  | "invalid_attachment_count"
  | "try_attach_unsupported";

export class RuntimeOwnerCoordinatorError extends Error {
  override readonly cause: unknown | undefined;
  readonly code: RuntimeOwnerCoordinatorErrorCode;

  constructor({ cause, code, message }: {
    cause: unknown | undefined;
    code: RuntimeOwnerCoordinatorErrorCode;
    message: string;
  }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RuntimeOwnerCoordinatorError";
    this.cause = cause;
    this.code = code;
  }
}

/**
 * Shares one cross-realm runtime-owner lease across all sessions attached to
 * one in-memory ContainerRuntime. The lease may be released only after the
 * final attachment closes and the runtime reports a clean durable head.
 */
export class RuntimeOwnerCoordinator {
  private readonly acquireLease: () => Promise<CrossRealmRuntimeOwnerLease>;
  private acquisition: Promise<CrossRealmRuntimeOwnerLease> | undefined;
  private attachmentCountValue = 0;
  private failure: unknown | undefined;
  private readonly isReleaseSafe: () => boolean;
  private lease: CrossRealmRuntimeOwnerLease | undefined;
  private readonly tryAcquireLease: (() => Promise<CrossRealmRuntimeOwnerLease | undefined>) | undefined;
  private tryAcquisition: Promise<CrossRealmRuntimeOwnerLease | undefined> | undefined;
  private releaseCompletion: Promise<void> | undefined;

  constructor({ acquireLease, isReleaseSafe, tryAcquireLease }: {
    acquireLease: () => Promise<CrossRealmRuntimeOwnerLease>;
    isReleaseSafe: () => boolean;
    tryAcquireLease?: () => Promise<CrossRealmRuntimeOwnerLease | undefined>;
  }) {
    this.acquireLease = acquireLease;
    this.isReleaseSafe = isReleaseSafe;
    this.tryAcquireLease = tryAcquireLease;
  }

  state(): RuntimeOwnerCoordinatorState {
    if (this.failure !== undefined) return "failed";
    if (this.releaseCompletion !== undefined) return "releasing";
    if (this.lease !== undefined) return "owned";
    if (this.acquisition !== undefined || this.tryAcquisition !== undefined) return "acquiring";
    return "idle";
  }

  attachmentCount(): number {
    return this.attachmentCountValue;
  }

  private assertUsable(): void {
    if (this.failure === undefined) return;
    throw new RuntimeOwnerCoordinatorError({
      cause: this.failure,
      code: "coordinator_failed",
      message: "cross-realm runtime-owner coordination failed and cannot admit another session",
    });
  }

  private async waitForReleaseCompletion(): Promise<void> {
    const releaseCompletion = this.releaseCompletion;
    if (releaseCompletion === undefined) return;
    await releaseCompletion;
  }

  private async requireLease(): Promise<CrossRealmRuntimeOwnerLease> {
    this.assertUsable();
    await this.waitForReleaseCompletion();
    this.assertUsable();
    const existing = this.lease;
    if (existing !== undefined) return existing;
    const pendingTryAcquisition = this.tryAcquisition;
    if (pendingTryAcquisition !== undefined) {
      const acquired = await pendingTryAcquisition;
      if (this.tryAcquisition === pendingTryAcquisition) this.tryAcquisition = undefined;
      if (acquired !== undefined) {
        this.lease ??= acquired;
        return this.lease;
      }
    }
    this.acquisition ??= this.acquireLease();
    try {
      const acquired = await this.acquisition;
      this.lease = acquired;
      return acquired;
    } finally {
      this.acquisition = undefined;
    }
  }

  private createAttachment(): RuntimeOwnerAttachment {
    this.attachmentCountValue += 1;
    let releaseCompletion: Promise<void> | undefined;
    return Object.freeze({
      release: async () => {
        releaseCompletion ??= this.releaseAttachment();
        await releaseCompletion;
      },
    });
  }

  async attach(): Promise<RuntimeOwnerAttachment> {
    await this.requireLease();
    this.assertUsable();
    return this.createAttachment();
  }

  async tryAttach(): Promise<RuntimeOwnerAttachment | undefined> {
    this.assertUsable();
    if (this.releaseCompletion !== undefined || this.acquisition !== undefined) return undefined;
    if (this.lease !== undefined) return this.createAttachment();
    const tryAcquireLease = this.tryAcquireLease;
    if (tryAcquireLease === undefined) {
      throw new RuntimeOwnerCoordinatorError({
        cause: undefined,
        code: "try_attach_unsupported",
        message: "runtime-owner coordinator cannot provide non-blocking attachment",
      });
    }
    const acquisition = this.tryAcquisition ??= tryAcquireLease();
    let acquired: CrossRealmRuntimeOwnerLease | undefined;
    try {
      acquired = await acquisition;
    } finally {
      if (this.tryAcquisition === acquisition) this.tryAcquisition = undefined;
    }
    if (acquired === undefined) return undefined;
    if (this.lease === undefined) this.lease = acquired;
    else if (this.lease !== acquired) {
      acquired.release();
      await acquired.released;
    }
    this.assertUsable();
    return this.createAttachment();
  }

  private async releaseAttachment(): Promise<void> {
    if (this.attachmentCountValue < 1) {
      const failure = new RuntimeOwnerCoordinatorError({
        cause: undefined,
        code: "invalid_attachment_count",
        message: "runtime-owner attachment accounting became negative",
      });
      this.failure = failure;
      throw failure;
    }
    this.attachmentCountValue -= 1;
    await this.releaseIfIdleAndSafe();
  }

  async releaseIfIdleAndSafe(): Promise<void> {
    this.assertUsable();
    if (this.attachmentCountValue !== 0) return;
    if (this.releaseCompletion !== undefined) return await this.releaseCompletion;
    const lease = this.lease;
    if (lease === undefined) return;
    let releaseSafe: boolean;
    try {
      releaseSafe = this.isReleaseSafe();
    } catch (cause: unknown) {
      this.failure = cause;
      throw new RuntimeOwnerCoordinatorError({
        cause,
        code: "coordinator_failed",
        message: "runtime-owner release safety could not be established",
      });
    }
    if (!releaseSafe) return;
    this.lease = undefined;
    const completion = (async (): Promise<void> => {
      try {
        lease.release();
        await lease.released;
      } catch (cause: unknown) {
        this.failure = cause;
        throw new RuntimeOwnerCoordinatorError({
          cause,
          code: "coordinator_failed",
          message: "cross-realm runtime-owner lease did not release cleanly",
        });
      }
    })();
    this.releaseCompletion = completion;
    try {
      await completion;
    } finally {
      this.releaseCompletion = undefined;
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
