import type { ContainerCoordinationKey } from "@/00-storage/service/hizofs/filesystem/container-coordination-key";

export type RuntimeCoordinationRegistryActivityState = "active" | "idle";

export type RuntimeCoordinationErrorCode =
  | "maintenance_active"
  | "publication_in_progress"
  | "writer_active"
  | "writer_released";

export class RuntimeCoordinationError extends Error {
  readonly code: RuntimeCoordinationErrorCode;

  constructor({ code, message }: { code: RuntimeCoordinationErrorCode; message: string }) {
    super(message);
    this.name = "RuntimeCoordinationError";
    this.code = code;
  }
}

type CoordinationState = {
  maintenanceActive: boolean;
  publicationActive: boolean;
  writerActive: boolean;
};

export type RuntimeMaintenanceLease = Readonly<{
  release: () => void;
}>;

export type RuntimeWriterLease = Readonly<{
  release: () => void;
  runPublication: <T>({ operation }: { operation: () => Promise<T> }) => Promise<T>;
}>;

export class RuntimeCoordinationRegistry {
  private states = new WeakMap<ContainerCoordinationKey, CoordinationState>();

  private state({ coordinationKey }: { coordinationKey: ContainerCoordinationKey }): CoordinationState {
    const existing = this.states.get(coordinationKey);
    if (existing !== undefined) return existing;
    const created = { maintenanceActive: false, publicationActive: false, writerActive: false };
    this.states.set(coordinationKey, created);
    return created;
  }

  activityState({ coordinationKey }: {
    coordinationKey: ContainerCoordinationKey;
  }): RuntimeCoordinationRegistryActivityState {
    const state = this.states.get(coordinationKey);
    if (state === undefined) return "idle";
    return state.maintenanceActive || state.publicationActive || state.writerActive ? "active" : "idle";
  }

  acquireWriter({ coordinationKey }: {
    coordinationKey: ContainerCoordinationKey;
  }): RuntimeWriterLease {
    const state = this.state({ coordinationKey });
    if (state.maintenanceActive) {
      throw new RuntimeCoordinationError({
        code: "maintenance_active",
        message: "writer ownership is blocked by the container maintenance gate",
      });
    }
    if (state.writerActive) {
      throw new RuntimeCoordinationError({
        code: "writer_active",
        message: "one physical container already has a writer owner",
      });
    }
    state.writerActive = true;
    let active = true;
    return {
      release: () => {
        if (!active) return;
        if (state.publicationActive) {
          throw new RuntimeCoordinationError({
            code: "publication_in_progress",
            message: "writer ownership cannot be released during publication",
          });
        }
        active = false;
        state.writerActive = false;
      },
      runPublication: async <T>({ operation }: { operation: () => Promise<T> }): Promise<T> => {
        if (!active) {
          throw new RuntimeCoordinationError({
            code: "writer_released",
            message: "released writer ownership cannot publish",
          });
        }
        if (state.maintenanceActive) {
          throw new RuntimeCoordinationError({
            code: "maintenance_active",
            message: "publication is blocked by the container maintenance gate",
          });
        }
        if (state.publicationActive) {
          throw new RuntimeCoordinationError({
            code: "publication_in_progress",
            message: "another publication already owns the short authority gate",
          });
        }
        state.publicationActive = true;
        try {
          return await operation();
        } finally {
          state.publicationActive = false;
        }
      },
    };
  }

  beginMaintenance({ coordinationKey }: {
    coordinationKey: ContainerCoordinationKey;
  }): RuntimeMaintenanceLease {
    const state = this.state({ coordinationKey });
    if (state.maintenanceActive) {
      throw new RuntimeCoordinationError({
        code: "maintenance_active",
        message: "maintenance already owns this physical container gate",
      });
    }
    if (state.writerActive || state.publicationActive) {
      throw new RuntimeCoordinationError({
        code: "writer_active",
        message: "maintenance cannot capture roots while a writer is active",
      });
    }
    state.maintenanceActive = true;
    let active = true;
    return {
      release: () => {
        if (!active) return;
        active = false;
        state.maintenanceActive = false;
      },
    };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
