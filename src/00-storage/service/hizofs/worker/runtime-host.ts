import {
  createHizoFSReadApi,
  createHizoFSStorageFileSystemSession,
  createRuntimeBoundHizoFSApplicationSessionPort,
  type HizoFSApplicationMutationPort,
  type HizoFSApplicationMutationSuccessCondition,
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
  createStorageFileSystemSyncError,
  requireStorageFileSystemSyncDurability,
  type StorageFileSystemSyncDurability,
} from "@/00-storage/service/storage-file-system/sync-error";
import {
  ContainerRuntime,
  type ContainerRuntimeAuthenticatedApplicationGeneration,
  type ContainerRuntimeHostDisposalResult,
  type ContainerRuntimeMaintenanceRootCapture,
  type ContainerRuntimeManagementCleanHeadBarrier,
  type ContainerRuntimeManagementWriterOwnership,
  type ContainerRuntimeSession,
} from "@/00-storage/service/hizofs/runtime/container-runtime";
import type { ContainerCoordinationScope } from "@/00-storage/service/hizofs/runtime/container-coordination-scope";
import type { CrossRealmLockPort } from "@/00-storage/service/hizofs/runtime/cross-realm-lock-coordinator";
import type { HizoFSRuntimeOwnerOpenPolicy } from "@/00-storage/service/hizofs/runtime/runtime-owner-coordinator";
import type {
  HizoFSLazyPublicationRolloutGateReceipt,
  HizoFSRuntimePolicy,
  HizoFSWritableDurabilityProfile,
} from "@/00-storage/service/hizofs/runtime/runtime-policy";
import type { DurableGenerationIdentity } from "@/00-storage/service/hizofs/runtime/application-generation-identity";
import type { AuthenticatedDurableApplicationGenerationAuthority } from "@/00-storage/service/hizofs/runtime/authenticated-application-generation";
import { WorkingCandidateCoordinatorError, type WorkingCandidateAdmission } from "@/00-storage/service/hizofs/runtime/working-candidate-coordinator";
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

function mutationSuccessConditionFromPublicationMode({ mode }: {
  mode: ReturnType<ContainerRuntimeAuthenticatedApplicationGeneration["publicationModeApplied"]>;
}): HizoFSApplicationMutationSuccessCondition {
  switch (mode) {
  case "immediate_publication_requested":
  case "immediate_publication_unqualified": return "durable_publication";
  case "lazy_publication_development":
  case "lazy_publication_strict": return "working_candidate_acceptance";
  default: return mode satisfies never;
  }
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
  private closePromise: Promise<void> | undefined;
  private idleWaiters = new Set<() => void>();
  private inFlightOperations = 0;
  private parent: ContainerRuntimeSession;
  private pin: Awaited<ReturnType<ContainerRuntimeSession["acquireReaderPin"]>>;
  private state: "closed" | "closing" | "open" = "open";

  constructor({ parent, pin }: {
    parent: ContainerRuntimeSession;
    pin: Awaited<ReturnType<ContainerRuntimeSession["acquireReaderPin"]>>;
  }) {
    this.parent = parent;
    this.pin = pin;
  }

  async acquireWriter(): Promise<HizoFSApplicationRuntimeWriter> {
    throw new Error("HizoFS read snapshot cannot acquire a writer");
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    await this.closePromise;
  }

  async runReadOperation<Value>({ operation }: {
    operation: () => Promise<Value>;
  }): Promise<Value> {
    switch (this.state) {
    case "open": break;
    case "closing":
    case "closed": throw new Error("HizoFS read snapshot is closing or closed");
    default: this.state satisfies never;
    }
    this.inFlightOperations += 1;
    try {
      return await this.parent.runReadOperation({ operation });
    } finally {
      this.inFlightOperations -= 1;
      if (this.inFlightOperations === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }

  private async closeInternal(): Promise<void> {
    switch (this.state) {
    case "closed": return;
    case "closing": return;
    case "open": break;
    default: this.state satisfies never;
    }
    this.state = "closing";
    if (this.inFlightOperations > 0) {
      await new Promise<void>(resolve => this.idleWaiters.add(resolve));
    }
    this.pin.release();
    await this.pin.released;
    this.state = "closed";
  }
}

type PreparedReadSnapshotResources = Readonly<{
  commitReference: Parameters<ContainerRuntimeSession["acquireReaderPin"]>[0]["commitReference"];
  mutationPort: HizoFSApplicationMutationPort;
  namespace: HizoFSApplicationSessionNamespace;
  releasePreparation?: () => void;
}>;

type ReadSnapshotResourceFactory = () => PreparedReadSnapshotResources | Promise<PreparedReadSnapshotResources>;

async function createPinnedReadSnapshotPort({
  assertOperationAllowed,
  createResources,
  parent,
  syncDurability,
}: {
  assertOperationAllowed?: () => void;
  createResources: ReadSnapshotResourceFactory;
  parent: ContainerRuntimeSession;
  syncDurability: StorageFileSystemSyncDurability;
}): Promise<HizoFSApplicationSessionPort> {
  assertOperationAllowed?.();
  const resources = await createResources();
  let pin: Awaited<ReturnType<ContainerRuntimeSession["acquireReaderPin"]>>;
  try {
    pin = await parent.acquireReaderPin({ commitReference: resources.commitReference });
  } catch (cause: unknown) {
    try {
      resources.releasePreparation?.();
    } catch (cleanupCause: unknown) {
      throw new AggregateError(
        [cause, cleanupCause],
        "HizoFS reader-pin acquisition and snapshot preparation cleanup both failed",
      );
    }
    throw cause;
  }
  try {
    resources.releasePreparation?.();
    assertOperationAllowed?.();
    return createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      ...(assertOperationAllowed === undefined ? {} : { assertOperationAllowed }),
      mutationPort: resources.mutationPort,
      namespace: resources.namespace,
      runtimeSession: new PinnedReadSnapshotRuntimeSession({ parent, pin }),
      sync: async () => requireStorageFileSystemSyncDurability({
        durability: syncDurability,
        implementation: "hizofs",
      }),
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


export type HizoFSWorkerRuntimeHostErrorCode = "runtime_owner_busy";

export class HizoFSWorkerRuntimeHostError extends Error {
  readonly code: HizoFSWorkerRuntimeHostErrorCode;

  constructor({ code, message }: { code: HizoFSWorkerRuntimeHostErrorCode; message: string }) {
    super(message);
    this.name = "HizoFSWorkerRuntimeHostError";
    this.code = code;
  }
}

export class HizoFSWorkerRuntimeHost {
  private runtime: ContainerRuntime;

  constructor({ crossRealmLockPort, lazyPublicationRollout, policy, scope }: {
    crossRealmLockPort: CrossRealmLockPort;
    /** Trusted composition seam. The browser factory intentionally does not expose it. */
    lazyPublicationRollout?: HizoFSLazyPublicationRolloutGateReceipt;
    policy: HizoFSRuntimePolicy;
    scope: ContainerCoordinationScope;
  }) {
    this.runtime = new ContainerRuntime({
      crossRealmLockPort,
      ...(lazyPublicationRollout === undefined ? {} : { lazyPublicationRollout }),
      limits: policy,
      scope,
    });
  }

  private async openSessionWithRuntimeOwnerPolicy<Captured, Verified>({
    captureAuthority,
    createSessionResources,
    recheckAuthority,
    runtimeOwnerPolicy,
    verifyCapturedAuthority,
  }: {
    captureAuthority: () => Promise<Captured>;
    createSessionResources: ({ captured, verified }: {
      captured: Captured;
      verified: Verified;
    }) => Readonly<{ releaseResources: () => Promise<void> }>;
    recheckAuthority: ({ captured }: { captured: Captured }) => Promise<void>;
    runtimeOwnerPolicy: HizoFSRuntimeOwnerOpenPolicy;
    verifyCapturedAuthority: ({ captured }: { captured: Captured }) => Promise<Verified>;
  }): Promise<ContainerRuntimeSession> {
    const input = { captureAuthority, createSessionResources, recheckAuthority, verifyCapturedAuthority };
    switch (runtimeOwnerPolicy) {
    case "wait": return await this.runtime.openSessionWithAuthorityHandshake(input);
    case "reject_if_busy": {
      const session = await this.runtime.tryOpenSessionWithAuthorityHandshake(input);
      if (session !== undefined) return session;
      throw new HizoFSWorkerRuntimeHostError({
        code: "runtime_owner_busy",
        message: "another runtime currently owns this HizoFS container",
      });
    }
    default: return runtimeOwnerPolicy satisfies never;
    }
  }

  async openSession<Captured, Verified>({
    captureAuthority,
    createSessionResources,
    recheckAuthority,
    runtimeOwnerPolicy = "wait",
    verifyCapturedAuthority,
  }: {
    captureAuthority: () => Promise<Captured>;
    createSessionResources: ({ captured, verified }: {
      captured: Captured;
      verified: Verified;
    }) => Readonly<{ releaseResources: () => Promise<void> }>;
    recheckAuthority: ({ captured }: { captured: Captured }) => Promise<void>;
    runtimeOwnerPolicy?: HizoFSRuntimeOwnerOpenPolicy;
    verifyCapturedAuthority: ({ captured }: { captured: Captured }) => Promise<Verified>;
  }): Promise<ContainerRuntimeSession> {
    return await this.openSessionWithRuntimeOwnerPolicy({
      captureAuthority,
      createSessionResources,
      recheckAuthority,
      runtimeOwnerPolicy,
      verifyCapturedAuthority,
    });
  }

  async tryOpenSession<Captured, Verified>({
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
  }): Promise<ContainerRuntimeSession | undefined> {
    return await this.runtime.tryOpenSessionWithAuthorityHandshake({
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
    observeAuthenticatedDurableAuthority,
    observeAuthenticatedDurableIdentity,
    observeWritableDurabilityProfile,
    recheckAuthority,
    registerRuntimeSession,
    runtimeOwnerPolicy = "wait",
    rootName,
    rootPath,
    verifyCapturedAuthority,
  }: {
    assertOperationAllowed?: () => void;
    captureAuthority: () => Promise<Captured>;
    createApplicationSessionResources: ({
      authenticatedGeneration,
      captured,
      openWorkingCandidateAdmission,
      verified,
    }: {
      authenticatedGeneration: ContainerRuntimeAuthenticatedApplicationGeneration | undefined;
      captured: Captured;
      openWorkingCandidateAdmission: <Candidate extends object>({ durableBaseIdentity, operationLabel }: {
        durableBaseIdentity: DurableGenerationIdentity;
        operationLabel: string;
      }) => WorkingCandidateAdmission<Candidate>;
      verified: Verified;
    }) => Readonly<{
      createReadSnapshotResources?: ReadSnapshotResourceFactory;
      mutationPort: HizoFSApplicationMutationPort;
      namespace: HizoFSApplicationSessionNamespace;
      releaseResources: () => Promise<void>;
      syncDurability: StorageFileSystemSyncDurability;
      workerMountGrantIssuer?: HizoFSWorkerMountGrantIssuer;
    }>;
    observeAuthenticatedDurableAuthority?: ({ verified }: {
      verified: Verified;
    }) => AuthenticatedDurableApplicationGenerationAuthority;
    observeAuthenticatedDurableIdentity?: ({ verified }: {
      verified: Verified;
    }) => DurableGenerationIdentity;
    observeWritableDurabilityProfile?: ({ verified }: {
      verified: Verified;
    }) => HizoFSWritableDurabilityProfile;
    recheckAuthority: ({ captured }: { captured: Captured }) => Promise<void>;
    registerRuntimeSession?: ({ runtimeSession }: {
      runtimeSession: HizoFSApplicationRuntimeSession;
    }) => void;
    rootName?: string;
    rootPath?: readonly string[];
    runtimeOwnerPolicy?: HizoFSRuntimeOwnerOpenPolicy;
    verifyCapturedAuthority: ({ captured }: { captured: Captured }) => Promise<Verified>;
  }): Promise<StorageFileSystemSession> {
    let applicationResources: Readonly<{
      authenticatedGeneration: ContainerRuntimeAuthenticatedApplicationGeneration | undefined;
      createReadSnapshotResources: ReadSnapshotResourceFactory | undefined;
      mutationPort: HizoFSApplicationMutationPort;
      namespace: HizoFSApplicationSessionNamespace;
      recheckSyncAuthority: () => Promise<void>;
      syncDurability: StorageFileSystemSyncDurability;
      workerMountGrantIssuer: HizoFSWorkerMountGrantIssuer | undefined;
    }> | undefined;
    const session = await this.openSessionWithRuntimeOwnerPolicy({
      captureAuthority,
      createSessionResources: ({ captured, verified }) => {
        const observedDurableAuthority = observeAuthenticatedDurableAuthority?.({ verified });
        const observedDurableIdentity = observedDurableAuthority?.identity
          ?? observeAuthenticatedDurableIdentity?.({ verified });
        const publicationState = this.runtime.workingCandidatePublicationState();
        switch (publicationState) {
        case "empty":
        case "installed":
        case "publishing":
          break;
        case "outcome_unknown":
          if (observedDurableIdentity === undefined) {
            throw new TypeError(
              "outcome-unknown runtime requires an authenticated durable identity before application resources open",
            );
          }
          if (observedDurableAuthority === undefined) {
            this.runtime.resolveWorkingCandidateOutcomeUnknownAgainstDurableAuthority({
              observedDurableIdentity,
            });
          } else {
            this.runtime.resolveWorkingCandidateOutcomeUnknownAgainstAuthenticatedDurableAuthority({
              observedDurableAuthority,
            });
          }
          break;
        case "poisoned":
          throw new TypeError("poisoned runtime cannot open application resources");
        default:
          return publicationState satisfies never;
        }
        const authenticatedGeneration = observedDurableAuthority === undefined
          ? undefined
          : this.runtime.attachAuthenticatedApplicationGeneration({
            durableAuthority: observedDurableAuthority,
            ...(observeWritableDurabilityProfile === undefined
              ? {}
              : { writableProfile: observeWritableDurabilityProfile({ verified }) }),
          });
        let candidateAdmissionsOpen = true;
        const openWorkingCandidateAdmission = <Candidate extends object>({
          durableBaseIdentity,
          operationLabel,
        }: {
          durableBaseIdentity: DurableGenerationIdentity;
          operationLabel: string;
        }): WorkingCandidateAdmission<Candidate> => {
          if (!candidateAdmissionsOpen) {
            throw new WorkingCandidateCoordinatorError({
              cause: undefined,
              code: "admission_closed",
              message: `${operationLabel} cannot reserve a candidate after its application session resources closed`,
            });
          }
          return this.runtime.openWorkingCandidateAdmission<Candidate>({
            durableBaseIdentity,
            operationLabel,
          });
        };
        let resources: ReturnType<typeof createApplicationSessionResources>;
        try {
          resources = createApplicationSessionResources({
            authenticatedGeneration,
            captured,
            openWorkingCandidateAdmission,
            verified,
          });
        } catch (cause: unknown) {
          candidateAdmissionsOpen = false;
          throw cause;
        }
        const {
          createReadSnapshotResources,
          mutationPort,
          namespace,
          releaseResources,
          syncDurability,
          workerMountGrantIssuer,
          ...unhandledResources
        } = resources;
        unhandledResources satisfies Record<PropertyKey, never>;
        applicationResources = {
          authenticatedGeneration,
          createReadSnapshotResources,
          mutationPort,
          namespace,
          recheckSyncAuthority: async () => {
            try {
              await recheckAuthority({ captured });
            } catch (cause: unknown) {
              throw createStorageFileSystemSyncError({
                cause,
                code: "authority_epoch_lost",
                implementation: "hizofs",
                message: "HizoFS sync authority epoch is no longer current",
                retryable: false,
              });
            }
          },
          syncDurability,
          workerMountGrantIssuer,
        };
        return {
          releaseResources: async () => {
            candidateAdmissionsOpen = false;
            await releaseResources();
          },
        };
      },
      recheckAuthority,
      runtimeOwnerPolicy,
      verifyCapturedAuthority,
    });
    if (applicationResources === undefined) {
      return await closeRuntimeSessionAfterFailure({
        cause: new Error("runtime session opened without its application namespace resources"),
        message: "application session resource rejection and runtime session cleanup both failed",
        session,
      });
    }
    const resolvedApplicationResources = applicationResources;
    const createReadSnapshotResources = resolvedApplicationResources.createReadSnapshotResources;
    const sync = async (): Promise<void> => {
      const target = resolvedApplicationResources.authenticatedGeneration?.captureSyncTarget();
      await session.syncDurableState({
        assertDurabilityDemonstrated: () => requireStorageFileSystemSyncDurability({
          durability: resolvedApplicationResources.syncDurability,
          implementation: "hizofs",
        }),
        recheckAuthority: resolvedApplicationResources.recheckSyncAuthority,
      });
      try {
        await resolvedApplicationResources.authenticatedGeneration?.requestExplicitFlush();
      } catch (cause: unknown) {
        const publicationState = this.runtime.workingCandidatePublicationState();
        switch (publicationState) {
        case "outcome_unknown":
        case "poisoned": throw createStorageFileSystemSyncError({
          cause,
          code: "durable_publication_outcome_unknown",
          implementation: "hizofs",
          message: "HizoFS cannot determine whether the captured working generation became durable",
          retryable: false,
        });
        case "empty":
        case "installed":
        case "publishing": throw createStorageFileSystemSyncError({
          cause,
          code: "durable_publication_failed",
          implementation: "hizofs",
          message: "HizoFS could not flush the captured working generation",
          retryable: true,
        });
        default: return publicationState satisfies never;
        }
      }
      if (target !== undefined) {
        await resolvedApplicationResources.authenticatedGeneration?.waitForSyncTarget({ target });
      }
    };
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
              syncDurability: resolvedApplicationResources.syncDurability,
            }),
          }),
          mutationPort: resolvedApplicationResources.mutationPort,
          mutationSuccessCondition: resolvedApplicationResources.authenticatedGeneration === undefined
            ? "durable_publication"
            : mutationSuccessConditionFromPublicationMode({
              mode: resolvedApplicationResources.authenticatedGeneration.publicationModeApplied(),
            }),
          namespace: resolvedApplicationResources.namespace,
          runtimeSession: session,
          sync,
        } }),
        rootName,
        rootPath,
        workerMountGrantIssuer: resolvedApplicationResources.workerMountGrantIssuer,
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
    const session = await this.runtime.openSessionWithAuthorityHandshake({
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

  openManagementCleanHeadBarrier({ writerOwnership }: {
    writerOwnership?: ContainerRuntimeManagementWriterOwnership;
  }): ContainerRuntimeManagementCleanHeadBarrier {
    return this.runtime.openManagementCleanHeadBarrier({ writerOwnership });
  }

  async disposeIfIdleAndSafe(): Promise<ContainerRuntimeHostDisposalResult> {
    return await this.runtime.disposeIfIdleAndSafe();
  }

  async flushAndDisposeIfIdleAndSafe(): Promise<ContainerRuntimeHostDisposalResult> {
    return await this.runtime.flushAndDisposeIfIdleAndSafe();
  }

  workingCandidatePublicationState(): ReturnType<ContainerRuntime["workingCandidatePublicationState"]> {
    return this.runtime.workingCandidatePublicationState();
  }

  async beginCleanHeadMaintenanceRootCapture(): Promise<ContainerRuntimeMaintenanceRootCapture> {
    return await this.runtime.beginCleanHeadMaintenanceRootCapture();
  }

  async beginMaintenanceRootCapture(): Promise<ContainerRuntimeMaintenanceRootCapture> {
    return await this.runtime.beginMaintenanceRootCapture();
  }

  acquireInspectorPinnedRoot({ commitReference }:
  Parameters<ContainerRuntime["acquireInspectorPinnedRoot"]>[0]):
  ReturnType<ContainerRuntime["acquireInspectorPinnedRoot"]> {
    return this.runtime.acquireInspectorPinnedRoot({ commitReference });
  }

  acquireSourceSegmentPinnedRoot({ commitReference }:
  Parameters<ContainerRuntime["acquireSourceSegmentPinnedRoot"]>[0]):
  ReturnType<ContainerRuntime["acquireSourceSegmentPinnedRoot"]> {
    return this.runtime.acquireSourceSegmentPinnedRoot({ commitReference });
  }

  acquireUnknownFeatureRoot({ commitReference }:
  Parameters<ContainerRuntime["acquireUnknownFeatureRoot"]>[0]):
  ReturnType<ContainerRuntime["acquireUnknownFeatureRoot"]> {
    return this.runtime.acquireUnknownFeatureRoot({ commitReference });
  }

  acquireWriterDependencyRoot({ commitReference }:
  Parameters<ContainerRuntime["acquireWriterDependencyRoot"]>[0]):
  ReturnType<ContainerRuntime["acquireWriterDependencyRoot"]> {
    return this.runtime.acquireWriterDependencyRoot({ commitReference });
  }

  acquireWriterWorkingPageRoot({ pageReference }:
  Parameters<ContainerRuntime["acquireWriterWorkingPageRoot"]>[0]):
  ReturnType<ContainerRuntime["acquireWriterWorkingPageRoot"]> {
    return this.runtime.acquireWriterWorkingPageRoot({ pageReference });
  }

  async beginSegmentDeletion({ segmentId }: Parameters<ContainerRuntime["beginSegmentDeletion"]>[0]):
  ReturnType<ContainerRuntime["beginSegmentDeletion"]> {
    // Keep the branded Segment ID inside the runtime owner type surface. The
    // worker host delegates the exact deletion gate without importing format.
    return await this.runtime.beginSegmentDeletion({ segmentId });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  closeRuntimeSessionAfterFailure,
  mutationSuccessConditionFromPublicationMode,
};
