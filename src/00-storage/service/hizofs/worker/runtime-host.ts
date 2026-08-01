import {
  createHizoFSReadApi,
  createHizoFSStorageFileSystemSession,
  createRuntimeBoundHizoFSApplicationSessionPort,
  type HizoFSApplicationMutationPort,
  type HizoFSApplicationSessionNamespace,
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
    captureAuthority,
    createApplicationSessionResources,
    recheckAuthority,
    rootName,
    rootPath,
    verifyCapturedAuthority,
  }: {
    captureAuthority: () => Promise<Captured>;
    createApplicationSessionResources: ({ captured, verified }: {
      captured: Captured;
      verified: Verified;
    }) => Readonly<{
      mutationPort: HizoFSApplicationMutationPort;
      namespace: HizoFSApplicationSessionNamespace;
      releaseResources: () => Promise<void>;
      workerMountGrantIssuer?: HizoFSWorkerMountGrantIssuer;
    }>;
    recheckAuthority: ({ captured }: { captured: Captured }) => Promise<void>;
    rootName?: string;
    rootPath?: readonly string[];
    verifyCapturedAuthority: ({ captured }: { captured: Captured }) => Promise<Verified>;
  }): Promise<StorageFileSystemSession> {
    let applicationResources: Readonly<{
      mutationPort: HizoFSApplicationMutationPort;
      namespace: HizoFSApplicationSessionNamespace;
      workerMountGrantIssuer: HizoFSWorkerMountGrantIssuer | undefined;
    }> | undefined;
    const session = await this.#runtime.openSessionWithAuthorityHandshake({
      captureAuthority,
      createSessionResources: ({ captured, verified }) => {
        const resources = createApplicationSessionResources({ captured, verified });
        const {
          mutationPort,
          namespace,
          releaseResources,
          workerMountGrantIssuer,
          ...unhandledResources
        } = resources;
        unhandledResources satisfies Record<PropertyKey, never>;
        applicationResources = { mutationPort, namespace, workerMountGrantIssuer };
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
    try {
      return createHizoFSStorageFileSystemSession({
        port: createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
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
