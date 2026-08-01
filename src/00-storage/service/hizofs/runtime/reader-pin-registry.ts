import type { HomeRecordReference } from "@/00-storage/service/hizofs/00-format";
import type { ContainerCoordinationKey } from "@/00-storage/service/hizofs/filesystem/container-coordination-key";
import {
  MaintenanceRootRegistry,
  type RuntimeMaintenanceRootRegistration,
} from "@/00-storage/service/hizofs/runtime/maintenance-root-registry";

export type ReaderPinRegistryErrorCode =
  | "invalid_pin_limit"
  | "pin_limit_exceeded";

export class ReaderPinRegistryError extends Error {
  readonly code: ReaderPinRegistryErrorCode;

  constructor({ code, message }: { code: ReaderPinRegistryErrorCode; message: string }) {
    super(message);
    this.name = "ReaderPinRegistryError";
    this.code = code;
  }
}

export type ReaderPin = Readonly<{
  commitReference: HomeRecordReference;
  release: () => void;
  released: Promise<void>;
}>;

type ScopeState = {
  pinCount: number;
};

export class ReaderPinRegistry {
  #maintenanceRoots: MaintenanceRootRegistry;
  #maxPinsPerContainer: number;
  #scopes = new WeakMap<ContainerCoordinationKey, ScopeState>();

  constructor({ maintenanceRoots, maxPinsPerContainer }: {
    maintenanceRoots: MaintenanceRootRegistry;
    maxPinsPerContainer: number;
  }) {
    if (!Number.isSafeInteger(maxPinsPerContainer) || maxPinsPerContainer < 1) {
      throw new ReaderPinRegistryError({
        code: "invalid_pin_limit",
        message: "reader pin registry requires a positive safe per-container pin limit",
      });
    }
    this.#maintenanceRoots = maintenanceRoots;
    this.#maxPinsPerContainer = maxPinsPerContainer;
  }

  #scope({ coordinationKey }: { coordinationKey: ContainerCoordinationKey }): ScopeState {
    const existing = this.#scopes.get(coordinationKey);
    if (existing !== undefined) return existing;
    const created: ScopeState = { pinCount: 0 };
    this.#scopes.set(coordinationKey, created);
    return created;
  }

  acquire({ commitReference, coordinationKey }: {
    commitReference: HomeRecordReference;
    coordinationKey: ContainerCoordinationKey;
  }): ReaderPin {
    const scope = this.#scope({ coordinationKey });
    if (scope.pinCount >= this.#maxPinsPerContainer) {
      throw new ReaderPinRegistryError({
        code: "pin_limit_exceeded",
        message: "reader pin registry reached its explicit per-container memory bound",
      });
    }
    const root: RuntimeMaintenanceRootRegistration = this.#maintenanceRoots.acquireReaderPinnedRoot({
      commitReference,
      coordinationKey,
    });
    scope.pinCount += 1;
    const completion = Promise.withResolvers<void>();
    let active = true;
    return {
      commitReference: root.commitReference,
      release: () => {
        if (!active) return;
        active = false;
        try {
          if (scope.pinCount < 1) throw new Error("reader pin registry accounting became inconsistent");
          root.release();
          scope.pinCount -= 1;
          completion.resolve();
        } catch (cause: unknown) {
          completion.reject(cause);
          throw cause;
        }
      },
      released: completion.promise,
    };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
