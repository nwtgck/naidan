import {
  createHizoFSReadApi,
  createHizoFSStorageFileSystemSession,
  createRuntimeBoundHizoFSApplicationSessionPort,
  type HizoFSApplicationMutationPort,
  type HizoFSApplicationRuntimeSession,
  type HizoFSApplicationRuntimeWriter,
  type HizoFSApplicationSessionNamespace,
  type HizoFSApplicationSessionPort,
  type HizoFSReadApi,
  type HizoFSReadApiNamespace,
  type HizoFSWorkerMountGrantIssuer,
} from "@/00-storage/service/hizofs/api";
import type { StorageFileSystemSession } from "@/00-storage/service/storage-file-system/types";
import {
  ContainerRuntime,
  type ContainerRuntimeMaintenanceRootCapture,
  type ContainerRuntimeSession,
} from "@/00-storage/service/hizofs/runtime/container-runtime";
import type { ContainerCoordinationScope } from "@/00-storage/service/hizofs/runtime/container-coordination-scope";
import type { CrossRealmLockPort } from "@/00-storage/service/hizofs/runtime/cross-realm-lock-coordinator";
import type { HizoFSRuntimePolicy } from "@/00-storage/service/hizofs/runtime/runtime-policy";
import {
  createBrowserWebLockManagerPort,
  type BrowserWebLockManager,
  WebLocksCrossRealmLockPort,
} from "@/00-storage/service/hizofs/runtime/web-lock-port";

/**
 * Worker code owns the unlocked runtime but does not import format, crypto,
 * authenticated-store, or physical-store internals. Those authorities are
 * composed behind runtime ports so the worker remains a narrow isolation and
 * lifetime boundary rather than a second filesystem implementation.
 */
export function createBrowserHizoFSWorkerRuntimeHost({ lockManager, policy, scope }: {
  lockManager: BrowserWebLockManager;
  policy: HizoFSRuntimePolicy;
  scope: ContainerCoordinationScope;
}): HizoFSWorkerRuntimeHost {
  return new HizoFSWorkerRuntimeHost({
    crossRealmLockPort: new WebLocksCrossRealmLockPort({
      manager: createBrowserWebLockManagerPort({ manager: lockManager }),
    }),
    policy,
    scope,
  });
}

async function closeRuntimeSessionAfterFailure({ cause, message, session }: {
  cause: unknown;
  message: string;
  session: Pick<ContainerRuntimeSession, "close">;
}): Promise<never> {
  try {
    await session.close();
  } catch (closeFailure: unknown) {
    throw new AggregateError([cause, closeFailure], message);
  }
  throw cause;
}


class PinnedReadSnapshotRuntimeSession implements HizoFSApplicationRuntimeSession {
  #closePromise: Promise<void> | undefined;
  #idleWaiters = new Set<() => void>();
  #inFlightOperations = 0;
  #parent: ContainerRuntimeSession;
  #pin: Awaited<ReturnType<ContainerRuntimeSession["acquireReaderPin"]>>;
  #state: "closed" | "closing" | "open" = "open";

  constructor({ parent, pin }: {
    parent: ContainerRuntimeSession;
    pin: Awaited<ReturnType<ContainerRuntimeSession["acquireReaderPin"]>>;
  }) {
    this.#parent = parent;
    this.#pin = pin;
  }

  async acquireWriter(): Promise<HizoFSApplicationRuntimeWriter> {
    throw new Error("HizoFS read snapshot cannot acquire a writer");
  }

  async close(): Promise<void> {
    this.#closePromise ??= this.#close();
    await this.#closePromise;
  }

  async runReadOperation<Value>({ operation }: {
    operation: () => Promise<Value>;
  }): Promise<Value> {
    switch (this.#state) {
    case "open": break;
    case "closing":
    case "closed": throw new Error("HizoFS read snapshot is closing or closed");
    default: this.#state satisfies never;
    }
    this.#inFlightOperations += 1;
    try {
      return await this.#parent.runReadOperation({ operation });
    } finally {
      this.#inFlightOperations -= 1;
      if (this.#inFlightOperations === 0) {
        for (const resolve of this.#idleWaiters) resolve();
        this.#idleWaiters.clear();
      }
    }
  }

  async #close(): Promise<void> {
    switch (this.#state) {
    case "closed": return;
    case "closing": return;
    case "open": break;
    default: this.#state satisfies never;
    }
    this.#state = "closing";
    if (this.#inFlightOperations > 0) {
      await new Promise<void>(resolve => this.#idleWaiters.add(resolve));
    }
    this.#pin.release();
    await this.#pin.released;
    this.#state = "closed";
  }
}

async function createPinnedReadSnapshotPort({
  assertOperationAllowed,
  createResources,
  parent,
}: {
  assertOperationAllowed?: () => void;
  createResources: () => Readonly<{
    commitReference: Parameters<ContainerRuntimeSession["acquireReaderPin"]>[0]["commitReference"];
    mutationPort: HizoFSApplicationMutationPort;
    namespace: HizoFSApplicationSessionNamespace;
  }>;
  parent: ContainerRuntimeSession;
}): Promise<HizoFSApplicationSessionPort> {
  assertOperationAllowed?.();
  const resources = createResources();
  const pin = await parent.acquireReaderPin({ commitReference: resources.commitReference });
  try {
    assertOperationAllowed?.();
    return createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      ...(assertOperationAllowed === undefined ? {} : { assertOperationAllowed }),
      mutationPort: resources.mutationPort,
      namespace: resources.namespace,
      runtimeSession: new PinnedReadSnapshotRuntimeSession({ parent, pin }),
    } });
  } catch (cause: unknown) {
    try {
      pin.release();
      await pin.released;
    } catch (cleanupCause: unknown) {
      throw new AggregateError(
        [cause, cleanupCause],
        "HizoFS read snapshot construction and reader-pin cleanup both failed",
      );
    }
    throw cause;
  }
}

export class HizoFSWorkerRuntimeHost {
  #runtime: ContainerRuntime;

  constructor({ crossRealmLockPort, policy, scope }: {
    crossRealmLockPort: CrossRealmLockPort;
    policy: HizoFSRuntimePolicy;
    scope: ContainerCoordinationScope;
  }) {
    this.#runtime = new ContainerRuntime({
      crossRealmLockPort,
      limits: policy,
      scope,
    });
  }

  async openSession<Captured, Verified>({
    captureAuthority,
    createSessionResources,
    recheckAuthority,
    verifyCapturedAuthority,
  }: {
    captureAuthority: () => Promise<Captured>;
    createSessionResources: ({ captured, verified }: {
      captured: Captured;
      verified: Verified;
    }) => Readonly<{ releaseResources: () => Promise<void> }>;
    recheckAuthority: ({ captured }: { captured: Captured }) => Promise<void>;
    verifyCapturedAuthority: ({ captured }: { captured: Captured }) => Promise<Verified>;
  }): Promise<ContainerRuntimeSession> {
    return await this.#runtime.openSessionWithAuthorityHandshake({
      captureAuthority,
      createSessionResources,
      recheckAuthority,
      verifyCapturedAuthority,
    });
  }

  async openApplicationSession<Captured, Verified>({
    assertOperationAllowed,
    captureAuthority,
    createApplicationSessionResources,
    recheckAuthority,
    registerRuntimeSession,
    rootName,
    rootPath,
    verifyCapturedAuthority,
  }: {
    assertOperationAllowed?: () => void;
    captureAuthority: () => Promise<Captured>;
    createApplicationSessionResources: ({ captured, verified }: {
      captured: Captured;
      verified: Verified;
    }) => Readonly<{
      createReadSnapshotResources?: () => Readonly<{
        commitReference: Parameters<ContainerRuntimeSession["acquireReaderPin"]>[0]["commitReference"];
        mutationPort: HizoFSApplicationMutationPort;
        namespace: HizoFSApplicationSessionNamespace;
      }>;
      mutationPort: HizoFSApplicationMutationPort;
      namespace: HizoFSApplicationSessionNamespace;
      releaseResources: () => Promise<void>;
      workerMountGrantIssuer?: HizoFSWorkerMountGrantIssuer;
    }>;
    recheckAuthority: ({ captured }: { captured: Captured }) => Promise<void>;
    registerRuntimeSession?: ({ runtimeSession }: {
      runtimeSession: HizoFSApplicationRuntimeSession;
    }) => void;
    rootName?: string;
    rootPath?: readonly string[];
    verifyCapturedAuthority: ({ captured }: { captured: Captured }) => Promise<Verified>;
  }): Promise<StorageFileSystemSession> {
    let applicationResources: Readonly<{
      createReadSnapshotResources: (() => Readonly<{
        commitReference: Parameters<ContainerRuntimeSession["acquireReaderPin"]>[0]["commitReference"];
        mutationPort: HizoFSApplicationMutationPort;
        namespace: HizoFSApplicationSessionNamespace;
      }>) | undefined;
      mutationPort: HizoFSApplicationMutationPort;
      namespace: HizoFSApplicationSessionNamespace;
      workerMountGrantIssuer: HizoFSWorkerMountGrantIssuer | undefined;
    }> | undefined;
    const session = await this.#runtime.openSessionWithAuthorityHandshake({
      captureAuthority,
      createSessionResources: ({ captured, verified }) => {
        const resources = createApplicationSessionResources({ captured, verified });
        const {
          createReadSnapshotResources,
          mutationPort,
          namespace,
          releaseResources,
          workerMountGrantIssuer,
          ...unhandledResources
        } = resources;
        unhandledResources satisfies Record<PropertyKey, never>;
        applicationResources = {
          createReadSnapshotResources,
          mutationPort,
          namespace,
          workerMountGrantIssuer,
        };
        return { releaseResources };
      },
      recheckAuthority,
      verifyCapturedAuthority,
    });
    if (applicationResources === undefined) {
      return await closeRuntimeSessionAfterFailure({
        cause: new Error("runtime session opened without its application namespace resources"),
        message: "application session resource rejection and runtime session cleanup both failed",
        session,
      });
    }
    const createReadSnapshotResources = applicationResources.createReadSnapshotResources;
    try {
      registerRuntimeSession?.({ runtimeSession: session });
      return createHizoFSStorageFileSystemSession({
        port: createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
          ...(assertOperationAllowed === undefined ? {} : { assertOperationAllowed }),
          ...(createReadSnapshotResources === undefined ? {} : {
            createReadSnapshot: async () => await createPinnedReadSnapshotPort({
              ...(assertOperationAllowed === undefined ? {} : { assertOperationAllowed }),
              createResources: createReadSnapshotResources,
              parent: session,
            }),
          }),
          mutationPort: applicationResources.mutationPort,
          namespace: applicationResources.namespace,
          runtimeSession: session,
        } }),
        rootName,
        rootPath,
        workerMountGrantIssuer: applicationResources.workerMountGrantIssuer,
      });
    } catch (cause: unknown) {
      return await closeRuntimeSessionAfterFailure({
        cause,
        message: "application session construction and runtime session cleanup both failed",
        session,
      });
    }
  }

  async openReadApi<Captured, Verified>({
    captureAuthority,
    createReadSessionResources,
    recheckAuthority,
    verifyCapturedAuthority,
  }: {
    captureAuthority: () => Promise<Captured>;
    createReadSessionResources: ({ captured, verified }: {
      captured: Captured;
      verified: Verified;
    }) => Readonly<{
      namespace: HizoFSReadApiNamespace;
      releaseResources: () => Promise<void>;
    }>;
    recheckAuthority: ({ captured }: { captured: Captured }) => Promise<void>;
    verifyCapturedAuthority: ({ captured }: { captured: Captured }) => Promise<Verified>;
  }): Promise<HizoFSReadApi> {
    let namespace: HizoFSReadApiNamespace | undefined;
    const session = await this.#runtime.openSessionWithAuthorityHandshake({
      captureAuthority,
      createSessionResources: ({ captured, verified }) => {
        const resources = createReadSessionResources({ captured, verified });
        namespace = resources.namespace;
        return { releaseResources: resources.releaseResources };
      },
      recheckAuthority,
      verifyCapturedAuthority,
    });
    if (namespace === undefined) {
      return await closeRuntimeSessionAfterFailure({
        cause: new Error("runtime session opened without its read namespace"),
        message: "read session resource rejection and runtime session cleanup both failed",
        session,
      });
    }
    try {
      return createHizoFSReadApi({ namespace, session });
    } catch (cause: unknown) {
      return await closeRuntimeSessionAfterFailure({
        cause,
        message: "read API construction and runtime session cleanup both failed",
        session,
      });
    }
  }

  async beginMaintenanceRootCapture(): Promise<ContainerRuntimeMaintenanceRootCapture> {
    return await this.#runtime.beginMaintenanceRootCapture();
  }

  acquireInspectorPinnedRoot({ commitReference }:
  Parameters<ContainerRuntime["acquireInspectorPinnedRoot"]>[0]):
  ReturnType<ContainerRuntime["acquireInspectorPinnedRoot"]> {
    return this.#runtime.acquireInspectorPinnedRoot({ commitReference });
  }

  acquireSourceSegmentPinnedRoot({ commitReference }:
  Parameters<ContainerRuntime["acquireSourceSegmentPinnedRoot"]>[0]):
  ReturnType<ContainerRuntime["acquireSourceSegmentPinnedRoot"]> {
    return this.#runtime.acquireSourceSegmentPinnedRoot({ commitReference });
  }

  acquireUnknownFeatureRoot({ commitReference }:
  Parameters<ContainerRuntime["acquireUnknownFeatureRoot"]>[0]):
  ReturnType<ContainerRuntime["acquireUnknownFeatureRoot"]> {
    return this.#runtime.acquireUnknownFeatureRoot({ commitReference });
  }

  acquireWriterDependencyRoot({ commitReference }:
  Parameters<ContainerRuntime["acquireWriterDependencyRoot"]>[0]):
  ReturnType<ContainerRuntime["acquireWriterDependencyRoot"]> {
    return this.#runtime.acquireWriterDependencyRoot({ commitReference });
  }

  async beginSegmentDeletion({ segmentId }: Parameters<ContainerRuntime["beginSegmentDeletion"]>[0]):
  ReturnType<ContainerRuntime["beginSegmentDeletion"]> {
    // Keep the branded Segment ID inside the runtime owner type surface. The
    // worker host delegates the exact deletion gate without importing format.
    return await this.#runtime.beginSegmentDeletion({ segmentId });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  closeRuntimeSessionAfterFailure,
};
