import {
  decodeBase64UrlUnpadded,
  decodeRequiredHomeRecordReference,
  encodeBase64UrlUnpadded,
  encodeHomeRecordReference,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import type { ContainerCoordinationScopeToken } from "@/00-storage/service/hizofs/runtime/container-coordination-scope";

export type CrossRealmLockMode = "exclusive" | "shared";

export type CrossRealmLockLease = Readonly<{
  release: () => void;
  released: Promise<void>;
}>;

export interface CrossRealmLockPort {
  acquire({ mode, name }: {
    mode: CrossRealmLockMode;
    name: string;
  }): Promise<CrossRealmLockLease>;
  tryAcquire?({ mode, name }: {
    mode: CrossRealmLockMode;
    name: string;
  }): Promise<CrossRealmLockLease | undefined>;
  queryHeldLockNames(): Promise<readonly string[]>;
}

export type CrossRealmCoordinatorErrorCode =
  | "held_lock_limit_exceeded"
  | "invalid_held_lock_limit"
  | "invalid_held_reader_pin"
  | "lease_released"
  | "publication_in_progress"
  | "try_acquire_unsupported";

export class CrossRealmCoordinatorError extends Error {
  readonly code: CrossRealmCoordinatorErrorCode;

  constructor({ code, message }: { code: CrossRealmCoordinatorErrorCode; message: string }) {
    super(message);
    this.name = "CrossRealmCoordinatorError";
    this.code = code;
  }
}

export type CrossRealmReaderPin = Readonly<{
  commitReference: HomeRecordReference;
  release: () => void;
  released: Promise<void>;
}>;

export type CrossRealmMaintenanceLease = Readonly<{
  pinnedCommitReferences: readonly HomeRecordReference[];
  release: () => void;
  released: Promise<void>;
}>;

export type CrossRealmRuntimeOwnerLease = Readonly<{
  release: () => void;
  released: Promise<void>;
}>;

export type CrossRealmWriterLease = Readonly<{
  release: () => void;
  released: Promise<void>;
  runPublication: <T>({ operation }: {
    operation: () => Promise<T>;
  }) => Promise<T>;
}>;

const LOCK_PREFIX = "hizofs-v1";

function authorityLockName({ scopeToken }: {
  scopeToken: ContainerCoordinationScopeToken;
}): string {
  return `${LOCK_PREFIX}/authority/${scopeToken}`;
}

function publicationLockName({ scopeToken }: {
  scopeToken: ContainerCoordinationScopeToken;
}): string {
  return `${LOCK_PREFIX}/publication/${scopeToken}`;
}

function runtimeOwnerLockName({ scopeToken }: {
  scopeToken: ContainerCoordinationScopeToken;
}): string {
  return `${LOCK_PREFIX}/runtime-owner/${scopeToken}`;
}

function readerRegistrationLockName({ scopeToken }: {
  scopeToken: ContainerCoordinationScopeToken;
}): string {
  return `${LOCK_PREFIX}/reader-registration/${scopeToken}`;
}

export function readerPinLockName({ commitReference, scopeToken }: {
  commitReference: HomeRecordReference;
  scopeToken: ContainerCoordinationScopeToken;
}): string {
  const encodedReference = encodeBase64UrlUnpadded({
    bytes: encodeHomeRecordReference({ reference: commitReference }),
  });
  return `${LOCK_PREFIX}/reader-pin/${scopeToken}/${encodedReference}`;
}

function readerPinPrefix({ scopeToken }: {
  scopeToken: ContainerCoordinationScopeToken;
}): string {
  return `${LOCK_PREFIX}/reader-pin/${scopeToken}/`;
}

function decodeHeldReaderPin({ name, scopeToken }: {
  name: string;
  scopeToken: ContainerCoordinationScopeToken;
}): HomeRecordReference | undefined {
  const prefix = readerPinPrefix({ scopeToken });
  if (!name.startsWith(prefix)) return undefined;
  const encodedReference = name.slice(prefix.length);
  try {
    const bytes = decodeBase64UrlUnpadded({ maximumDecodedBytes: 32, value: encodedReference });
    if (bytes.byteLength !== 32) throw new Error("Home Record Reference lock suffix must encode 32 bytes");
    return decodeRequiredHomeRecordReference({ bytes });
  } catch (cause: unknown) {
    throw new CrossRealmCoordinatorError({
      code: "invalid_held_reader_pin",
      message: `held reader-pin lock cannot be decoded safely: ${String(cause)}`,
    });
  }
}

function referenceIdentity({ reference }: { reference: HomeRecordReference }): string {
  return encodeBase64UrlUnpadded({ bytes: encodeHomeRecordReference({ reference }) });
}

function releaseLeasesNow({ leases }: {
  leases: readonly CrossRealmLockLease[];
}): void {
  const failures: unknown[] = [];
  for (const lease of leases) {
    try {
      lease.release();
    } catch (cause: unknown) {
      failures.push(cause);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "multiple cross-realm leases failed to release");
}

async function releaseLeasesAndWait({ leases }: {
  leases: readonly CrossRealmLockLease[];
}): Promise<void> {
  const failures: unknown[] = [];
  try {
    releaseLeasesNow({ leases });
  } catch (cause: unknown) {
    failures.push(cause);
  }
  for (const result of await Promise.allSettled(leases.map(lease => lease.released))) {
    switch (result.status) {
    case "fulfilled": break;
    case "rejected": failures.push(result.reason); break;
    default: result satisfies never;
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "cross-realm lease cleanup did not complete cleanly");
}

/**
 * A cross-realm lease must be released after the protected operation, but a
 * cleanup failure must not erase the operation failure that explains why the
 * protected state was rejected.
 */
async function runWithCrossRealmLeaseCleanup<T>({ failureMessage, leases, operation }: {
  failureMessage: string;
  leases: readonly CrossRealmLockLease[];
  operation: () => Promise<T>;
}): Promise<T> {
  let operationFailure: unknown;
  let value: T | undefined;
  try {
    value = await operation();
  } catch (cause: unknown) {
    operationFailure = cause;
  }
  try {
    await releaseLeasesAndWait({ leases });
  } catch (cleanupFailure: unknown) {
    if (operationFailure !== undefined) {
      throw new AggregateError([operationFailure, cleanupFailure], failureMessage);
    }
    throw cleanupFailure;
  }
  if (operationFailure !== undefined) throw operationFailure;
  return value as T;
}

export class CrossRealmLockCoordinator {
  private lockPort: CrossRealmLockPort;
  private maxHeldLockNames: number;
  private scopeToken: ContainerCoordinationScopeToken;

  constructor({ lockPort, maxHeldLockNames, scopeToken }: {
    lockPort: CrossRealmLockPort;
    maxHeldLockNames: number;
    scopeToken: ContainerCoordinationScopeToken;
  }) {
    if (!Number.isSafeInteger(maxHeldLockNames) || maxHeldLockNames < 1) {
      throw new CrossRealmCoordinatorError({
        code: "invalid_held_lock_limit",
        message: "cross-realm coordinator requires a positive safe held-lock enumeration limit",
      });
    }
    this.lockPort = lockPort;
    this.maxHeldLockNames = maxHeldLockNames;
    this.scopeToken = scopeToken;
  }

  async runAuthorityRead<T>({ operation }: {
    operation: () => Promise<T>;
  }): Promise<T> {
    const authority = await this.lockPort.acquire({
      mode: "shared",
      name: authorityLockName({ scopeToken: this.scopeToken }),
    });
    return await runWithCrossRealmLeaseCleanup({
      failureMessage: "authority read and lease cleanup both failed",
      leases: [authority],
      operation,
    });
  }

  async captureAndAcquireReaderPin<Value>({ capture }: {
    capture: () => Promise<Readonly<{ commitReference: HomeRecordReference; value: Value }>>;
  }): Promise<Readonly<{ pin: CrossRealmReaderPin; value: Value }>> {
    const registration = await this.lockPort.acquire({
      mode: "shared",
      name: readerRegistrationLockName({ scopeToken: this.scopeToken }),
    });
    let captured: Readonly<{ commitReference: HomeRecordReference; value: Value }>;
    let commitReference: HomeRecordReference;
    let pin: CrossRealmLockLease;
    try {
      captured = await capture();
      commitReference = decodeRequiredHomeRecordReference({
        bytes: encodeHomeRecordReference({ reference: captured.commitReference }),
      });
      pin = await this.lockPort.acquire({
        mode: "shared",
        name: readerPinLockName({ commitReference, scopeToken: this.scopeToken }),
      });
    } catch (acquisitionFailure: unknown) {
      try {
        await releaseLeasesAndWait({ leases: [registration] });
      } catch (registrationCleanupFailure: unknown) {
        throw new AggregateError(
          [acquisitionFailure, registrationCleanupFailure],
          "reader capture or pin acquisition and registration cleanup both failed",
        );
      }
      throw acquisitionFailure;
    }
    try {
      await releaseLeasesAndWait({ leases: [registration] });
    } catch (registrationCleanupFailure: unknown) {
      try {
        await releaseLeasesAndWait({ leases: [pin] });
      } catch (pinCleanupFailure: unknown) {
        throw new AggregateError(
          [registrationCleanupFailure, pinCleanupFailure],
          "reader registration and unreturned pin cleanup both failed",
        );
      }
      throw registrationCleanupFailure;
    }
    let active = true;
    return {
      pin: {
        commitReference,
        release: () => {
          if (!active) return;
          active = false;
          pin.release();
        },
        released: pin.released,
      },
      value: captured.value,
    };
  }

  async acquireReaderPin({ commitReference }: {
    commitReference: HomeRecordReference;
  }): Promise<CrossRealmReaderPin> {
    const captured = await this.captureAndAcquireReaderPin({
      capture: async () => ({ commitReference, value: undefined }),
    });
    return captured.pin;
  }

  async acquireRuntimeOwner(): Promise<CrossRealmRuntimeOwnerLease> {
    const owner = await this.lockPort.acquire({
      mode: "exclusive",
      name: runtimeOwnerLockName({ scopeToken: this.scopeToken }),
    });
    let active = true;
    return {
      release: () => {
        if (!active) return;
        active = false;
        owner.release();
      },
      released: owner.released,
    };
  }

  async tryAcquireRuntimeOwner(): Promise<CrossRealmRuntimeOwnerLease | undefined> {
    const tryAcquire = this.lockPort.tryAcquire;
    if (tryAcquire === undefined) {
      throw new CrossRealmCoordinatorError({
        code: "try_acquire_unsupported",
        message: "cross-realm lock port does not support non-blocking runtime-owner acquisition",
      });
    }
    const owner = await tryAcquire.call(this.lockPort, {
      mode: "exclusive",
      name: runtimeOwnerLockName({ scopeToken: this.scopeToken }),
    });
    if (owner === undefined) return undefined;
    let active = true;
    return {
      release: () => {
        if (!active) return;
        active = false;
        owner.release();
      },
      released: owner.released,
    };
  }

  async acquireWriter(): Promise<CrossRealmWriterLease> {
    const authority = await this.lockPort.acquire({
      mode: "exclusive",
      name: authorityLockName({ scopeToken: this.scopeToken }),
    });
    let active = true;
    let publicationActive = false;
    return {
      release: () => {
        if (!active) return;
        if (publicationActive) {
          throw new CrossRealmCoordinatorError({
            code: "publication_in_progress",
            message: "cross-realm writer ownership cannot be released during publication",
          });
        }
        active = false;
        authority.release();
      },
      released: authority.released,
      runPublication: async <T>({ operation }: {
        operation: () => Promise<T>;
      }): Promise<T> => {
        if (!active) {
          throw new CrossRealmCoordinatorError({
            code: "lease_released",
            message: "released cross-realm writer lease cannot publish",
          });
        }
        if (publicationActive) {
          throw new CrossRealmCoordinatorError({
            code: "publication_in_progress",
            message: "one writer lease cannot run overlapping publications",
          });
        }
        publicationActive = true;
        try {
          const publication = await this.lockPort.acquire({
            mode: "exclusive",
            name: publicationLockName({ scopeToken: this.scopeToken }),
          });
          return await runWithCrossRealmLeaseCleanup({
            failureMessage: "publication operation and lease cleanup both failed",
            leases: [publication],
            operation,
          });
        } finally {
          publicationActive = false;
        }
      },
    };
  }

  async beginMaintenance(): Promise<CrossRealmMaintenanceLease> {
    const registration = await this.lockPort.acquire({
      mode: "exclusive",
      name: readerRegistrationLockName({ scopeToken: this.scopeToken }),
    });
    let authority: CrossRealmLockLease | undefined;
    try {
      // WHY: reader snapshot capture may need ordinary writer authority to
      // materialize a staged generation while holding the shared registration
      // gate. Taking registration before authority gives both paths one lock
      // order and prevents capture/pin registration from racing final GC root
      // validation without introducing a writer/read deadlock.
      authority = await this.lockPort.acquire({
        mode: "exclusive",
        name: authorityLockName({ scopeToken: this.scopeToken }),
      });
      const heldNames = await this.lockPort.queryHeldLockNames();
      if (heldNames.length > this.maxHeldLockNames) {
        throw new CrossRealmCoordinatorError({
          code: "held_lock_limit_exceeded",
          message: "held lock enumeration exceeds the explicit runtime memory bound",
        });
      }
      const uniqueReferences = new Map<string, HomeRecordReference>();
      for (const name of heldNames) {
        const reference = decodeHeldReaderPin({ name, scopeToken: this.scopeToken });
        if (reference === undefined) continue;
        uniqueReferences.set(referenceIdentity({ reference }), reference);
      }
      let active = true;
      const heldRegistration = registration;
      const heldAuthority = authority;
      const released = Promise.all([heldRegistration.released, heldAuthority.released]).then(() => undefined);
      return {
        pinnedCommitReferences: [...uniqueReferences.values()],
        release: () => {
          if (!active) return;
          active = false;
          releaseLeasesNow({ leases: [heldAuthority, heldRegistration] });
        },
        released,
      };
    } catch (cause: unknown) {
      const leases = authority === undefined ? [registration] : [authority, registration];
      try {
        await releaseLeasesAndWait({ leases });
      } catch (cleanupCause: unknown) {
        throw new AggregateError([cause, cleanupCause], "maintenance acquisition and cleanup both failed");
      }
      throw cause;
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
