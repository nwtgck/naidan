import { segmentIdToLowercaseHex, type SegmentId } from "@/00-storage/service/hizofs/00-format";
import type { ContainerCoordinationKey } from "@/00-storage/service/hizofs/filesystem/container-coordination-key";

export type ActiveSegmentReferenceKind = "backend_handle" | "read_lease" | "snapshot_cache";

export type ActiveSegmentRegistryActivityState = "active" | "idle";

export type ActiveSegmentRegistryErrorCode =
  | "deletion_active"
  | "invalid_reference_limit"
  | "reference_limit_exceeded";

export class ActiveSegmentRegistryError extends Error {
  readonly code: ActiveSegmentRegistryErrorCode;

  constructor({ code, message }: { code: ActiveSegmentRegistryErrorCode; message: string }) {
    super(message);
    this.name = "ActiveSegmentRegistryError";
    this.code = code;
  }
}

export type ActiveSegmentReference = Readonly<{
  release: () => void;
}>;

export type ActiveSegmentDeletionLease = Readonly<{
  release: () => void;
}>;

type SegmentState = {
  deletionActive: boolean;
  referenceCount: number;
  referencesByKind: Record<ActiveSegmentReferenceKind, number>;
  resolveIdle: (() => void) | undefined;
};

type ContainerState = {
  referenceCount: number;
  segments: Map<string, SegmentState>;
};

function emptyReferences(): Record<ActiveSegmentReferenceKind, number> {
  return { backend_handle: 0, read_lease: 0, snapshot_cache: 0 };
}

export class ActiveSegmentRegistry {
  private containers = new WeakMap<ContainerCoordinationKey, ContainerState>();
  private maxReferencesPerContainer: number;

  constructor({ maxReferencesPerContainer }: { maxReferencesPerContainer: number }) {
    if (!Number.isSafeInteger(maxReferencesPerContainer) || maxReferencesPerContainer < 1) {
      throw new ActiveSegmentRegistryError({
        code: "invalid_reference_limit",
        message: "active segment registry requires a positive safe per-container reference limit",
      });
    }
    this.maxReferencesPerContainer = maxReferencesPerContainer;
  }

  private container({ coordinationKey }: { coordinationKey: ContainerCoordinationKey }): ContainerState {
    const existing = this.containers.get(coordinationKey);
    if (existing !== undefined) return existing;
    const created: ContainerState = { referenceCount: 0, segments: new Map() };
    this.containers.set(coordinationKey, created);
    return created;
  }

  private segment({ container, segmentId }: {
    container: ContainerState;
    segmentId: SegmentId;
  }): { identity: string; state: SegmentState } {
    const identity = segmentIdToLowercaseHex({ id: segmentId });
    const existing = container.segments.get(identity);
    if (existing !== undefined) return { identity, state: existing };
    const state: SegmentState = {
      deletionActive: false,
      referenceCount: 0,
      referencesByKind: emptyReferences(),
      resolveIdle: undefined,
    };
    container.segments.set(identity, state);
    return { identity, state };
  }

  acquire({ coordinationKey, kind, segmentId }: {
    coordinationKey: ContainerCoordinationKey;
    kind: ActiveSegmentReferenceKind;
    segmentId: SegmentId;
  }): ActiveSegmentReference {
    const container = this.container({ coordinationKey });
    const { identity, state } = this.segment({ container, segmentId });
    if (state.deletionActive) {
      throw new ActiveSegmentRegistryError({
        code: "deletion_active",
        message: "new segment references are blocked while deletion owns the segment gate",
      });
    }
    if (container.referenceCount >= this.maxReferencesPerContainer) {
      throw new ActiveSegmentRegistryError({
        code: "reference_limit_exceeded",
        message: "active segment references reached the explicit per-container memory bound",
      });
    }
    container.referenceCount += 1;
    state.referenceCount += 1;
    state.referencesByKind[kind] += 1;
    let active = true;
    return { release: () => {
      if (!active) return;
      active = false;
      if (container.referenceCount < 1 || state.referenceCount < 1 || state.referencesByKind[kind] < 1) {
        throw new Error("active segment reference accounting became inconsistent");
      }
      container.referenceCount -= 1;
      state.referenceCount -= 1;
      state.referencesByKind[kind] -= 1;
      if (state.referenceCount === 0) {
        state.resolveIdle?.();
        state.resolveIdle = undefined;
        if (!state.deletionActive) container.segments.delete(identity);
      }
    } };
  }

  activityState({ coordinationKey }: {
    coordinationKey: ContainerCoordinationKey;
  }): ActiveSegmentRegistryActivityState {
    const container = this.containers.get(coordinationKey);
    if (container === undefined) return "idle";
    if (container.referenceCount > 0) return "active";
    for (const state of container.segments.values()) {
      if (state.deletionActive) return "active";
    }
    return "idle";
  }

  async beginDeletion({ coordinationKey, segmentId }: {
    coordinationKey: ContainerCoordinationKey;
    segmentId: SegmentId;
  }): Promise<ActiveSegmentDeletionLease> {
    const container = this.container({ coordinationKey });
    const { identity, state } = this.segment({ container, segmentId });
    if (state.deletionActive) {
      throw new ActiveSegmentRegistryError({
        code: "deletion_active",
        message: "segment deletion gate is already active",
      });
    }
    state.deletionActive = true;
    if (state.referenceCount > 0) {
      await new Promise<void>(resolve => {
        state.resolveIdle = resolve;
      });
    }
    let active = true;
    return { release: () => {
      if (!active) return;
      active = false;
      state.deletionActive = false;
      if (state.referenceCount === 0) container.segments.delete(identity);
    } };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
