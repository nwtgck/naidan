import {
  decodeRequiredHomeRecordReference,
  encodeHomeRecordReference,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import type { ContainerCoordinationKey } from "@/00-storage/service/hizofs/filesystem/container-coordination-key";

export type MaintenanceRootRegistryActivityState = "active" | "idle";

export type RuntimeMaintenanceRootSets = Readonly<{
  inspectorPinnedRoots: readonly HomeRecordReference[];
  readerPinnedRoots: readonly HomeRecordReference[];
  sourceSegmentPinnedRoots: readonly HomeRecordReference[];
  unknownFeatureRoots: readonly HomeRecordReference[];
  writerDependencyRoots: readonly HomeRecordReference[];
}>;

export type RuntimeMaintenanceRootRegistration = Readonly<{
  commitReference: HomeRecordReference;
  release: () => void;
}>;

export type RuntimeMaintenanceRootCapture = Readonly<{
  maintenanceRootEpoch: number;
  rootSets: RuntimeMaintenanceRootSets;
  release: () => void;
}>;

export type MaintenanceRootRegistryErrorCode =
  | "invalid_root_limit"
  | "registration_blocked"
  | "root_capture_active"
  | "root_epoch_exhausted"
  | "root_limit_exceeded";

export class MaintenanceRootRegistryError extends Error {
  readonly code: MaintenanceRootRegistryErrorCode;

  constructor({ code, message }: { code: MaintenanceRootRegistryErrorCode; message: string }) {
    super(message);
    this.name = "MaintenanceRootRegistryError";
    this.code = code;
  }
}

type RootEntry = {
  count: number;
  encodedReference: Uint8Array;
};

type RootCategory =
  | "inspector_pinned"
  | "reader_pinned"
  | "source_segment_pinned"
  | "unknown_feature"
  | "writer_dependency";

type ScopeState = {
  captureActive: boolean;
  categories: Record<RootCategory, Map<string, RootEntry>>;
  maintenanceRootEpoch: number;
  registrationCount: number;
};

function referenceIdentity({ encodedReference }: { encodedReference: Uint8Array }): string {
  let identity = "";
  for (const byte of encodedReference) identity += byte.toString(16).padStart(2, "0");
  return identity;
}

function cloneReference({ encodedReference }: { encodedReference: Uint8Array }): HomeRecordReference {
  return decodeRequiredHomeRecordReference({ bytes: encodedReference.slice() });
}

function categoryEntries({ category, scope }: {
  category: RootCategory;
  scope: ScopeState;
}): Map<string, RootEntry> {
  switch (category) {
  case "inspector_pinned": return scope.categories.inspector_pinned;
  case "reader_pinned": return scope.categories.reader_pinned;
  case "source_segment_pinned": return scope.categories.source_segment_pinned;
  case "unknown_feature": return scope.categories.unknown_feature;
  case "writer_dependency": return scope.categories.writer_dependency;
  default: return category satisfies never;
  }
}

function capturedReferences({ entries }: { entries: ReadonlyMap<string, RootEntry> }): readonly HomeRecordReference[] {
  return Object.freeze([...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => cloneReference({ encodedReference: entry.encodedReference })));
}

export class MaintenanceRootRegistry {
  #maxRegistrationsPerContainer: number;
  #scopes = new WeakMap<ContainerCoordinationKey, ScopeState>();

  constructor({ maxRegistrationsPerContainer }: { maxRegistrationsPerContainer: number }) {
    if (!Number.isSafeInteger(maxRegistrationsPerContainer) || maxRegistrationsPerContainer < 1) {
      throw new MaintenanceRootRegistryError({
        code: "invalid_root_limit",
        message: "maintenance root registry requires a positive safe per-container registration limit",
      });
    }
    this.#maxRegistrationsPerContainer = maxRegistrationsPerContainer;
  }

  #scope({ coordinationKey }: { coordinationKey: ContainerCoordinationKey }): ScopeState {
    const existing = this.#scopes.get(coordinationKey);
    if (existing !== undefined) return existing;
    const created: ScopeState = {
      captureActive: false,
      categories: {
        inspector_pinned: new Map(),
        reader_pinned: new Map(),
        source_segment_pinned: new Map(),
        unknown_feature: new Map(),
        writer_dependency: new Map(),
      },
      maintenanceRootEpoch: 0,
      registrationCount: 0,
    };
    this.#scopes.set(coordinationKey, created);
    return created;
  }

  #acquire({ category, commitReference, coordinationKey }: {
    category: RootCategory;
    commitReference: HomeRecordReference;
    coordinationKey: ContainerCoordinationKey;
  }): RuntimeMaintenanceRootRegistration {
    const scope = this.#scope({ coordinationKey });
    if (scope.captureActive) {
      throw new MaintenanceRootRegistryError({
        code: "registration_blocked",
        message: "maintenance root registration is blocked during root capture",
      });
    }
    if (scope.registrationCount >= this.#maxRegistrationsPerContainer) {
      throw new MaintenanceRootRegistryError({
        code: "root_limit_exceeded",
        message: "maintenance root registry reached its explicit per-container memory bound",
      });
    }
    if (scope.maintenanceRootEpoch === Number.MAX_SAFE_INTEGER) {
      throw new MaintenanceRootRegistryError({
        code: "root_epoch_exhausted",
        message: "maintenance root registration cannot advance the root epoch",
      });
    }
    const encodedReference = encodeHomeRecordReference({ reference: commitReference }).slice();
    const identity = referenceIdentity({ encodedReference });
    const entries = categoryEntries({ category, scope });
    const existing = entries.get(identity);
    if (existing === undefined) entries.set(identity, { count: 1, encodedReference });
    else existing.count += 1;
    scope.registrationCount += 1;
    // Every successful registration advances one shared runtime-only epoch.
    // A mark cycle cannot miss a transient root registration in another owner
    // merely because that owner released it before final sweep validation.
    scope.maintenanceRootEpoch += 1;
    let active = true;
    return {
      commitReference: cloneReference({ encodedReference }),
      release: () => {
        if (!active) return;
        active = false;
        const current = entries.get(identity);
        if (current === undefined || current.count < 1 || scope.registrationCount < 1) {
          throw new Error("maintenance root registry accounting became inconsistent");
        }
        current.count -= 1;
        scope.registrationCount -= 1;
        if (current.count === 0) entries.delete(identity);
      },
    };
  }

  acquireInspectorPinnedRoot({ commitReference, coordinationKey }: {
    commitReference: HomeRecordReference;
    coordinationKey: ContainerCoordinationKey;
  }): RuntimeMaintenanceRootRegistration {
    return this.#acquire({ category: "inspector_pinned", commitReference, coordinationKey });
  }

  acquireReaderPinnedRoot({ commitReference, coordinationKey }: {
    commitReference: HomeRecordReference;
    coordinationKey: ContainerCoordinationKey;
  }): RuntimeMaintenanceRootRegistration {
    return this.#acquire({ category: "reader_pinned", commitReference, coordinationKey });
  }

  acquireSourceSegmentPinnedRoot({ commitReference, coordinationKey }: {
    commitReference: HomeRecordReference;
    coordinationKey: ContainerCoordinationKey;
  }): RuntimeMaintenanceRootRegistration {
    return this.#acquire({ category: "source_segment_pinned", commitReference, coordinationKey });
  }

  acquireUnknownFeatureRoot({ commitReference, coordinationKey }: {
    commitReference: HomeRecordReference;
    coordinationKey: ContainerCoordinationKey;
  }): RuntimeMaintenanceRootRegistration {
    return this.#acquire({ category: "unknown_feature", commitReference, coordinationKey });
  }

  acquireWriterDependencyRoot({ commitReference, coordinationKey }: {
    commitReference: HomeRecordReference;
    coordinationKey: ContainerCoordinationKey;
  }): RuntimeMaintenanceRootRegistration {
    return this.#acquire({ category: "writer_dependency", commitReference, coordinationKey });
  }

  activityState({ coordinationKey }: {
    coordinationKey: ContainerCoordinationKey;
  }): MaintenanceRootRegistryActivityState {
    const scope = this.#scopes.get(coordinationKey);
    if (scope === undefined) return "idle";
    return scope.captureActive || scope.registrationCount > 0 ? "active" : "idle";
  }

  isSoleWriterDependencyRoot({ commitReference, coordinationKey }: {
    commitReference: HomeRecordReference;
    coordinationKey: ContainerCoordinationKey;
  }): boolean {
    const scope = this.#scopes.get(coordinationKey);
    if (scope === undefined || scope.captureActive || scope.registrationCount !== 1) return false;
    const identity = referenceIdentity({
      encodedReference: encodeHomeRecordReference({ reference: commitReference }),
    });
    return scope.categories.writer_dependency.get(identity)?.count === 1;
  }

  captureRoots({ coordinationKey }: {
    coordinationKey: ContainerCoordinationKey;
  }): RuntimeMaintenanceRootCapture {
    const scope = this.#scope({ coordinationKey });
    if (scope.captureActive) {
      throw new MaintenanceRootRegistryError({
        code: "root_capture_active",
        message: "maintenance root capture is already active for this physical container",
      });
    }
    scope.captureActive = true;
    let active = true;
    return {
      maintenanceRootEpoch: scope.maintenanceRootEpoch,
      rootSets: Object.freeze({
        inspectorPinnedRoots: capturedReferences({ entries: scope.categories.inspector_pinned }),
        readerPinnedRoots: capturedReferences({ entries: scope.categories.reader_pinned }),
        sourceSegmentPinnedRoots: capturedReferences({ entries: scope.categories.source_segment_pinned }),
        unknownFeatureRoots: capturedReferences({ entries: scope.categories.unknown_feature }),
        writerDependencyRoots: capturedReferences({ entries: scope.categories.writer_dependency }),
      }),
      release: () => {
        if (!active) return;
        active = false;
        scope.captureActive = false;
      },
    };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
