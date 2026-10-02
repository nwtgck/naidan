import {
  createHizoFSStorageFileSystemSession,
  createRuntimeBoundHizoFSApplicationSessionPort,
  HizoFSStorageFileSystemSession,
  type HizoFSApplicationMutationPort,
  type HizoFSApplicationMutationSuccessCondition,
  type HizoFSApplicationRuntimeSession,
  type HizoFSApplicationRuntimeWriter,
  type HizoFSApplicationSessionNamespace,
  type HizoFSApplicationSessionPort,
  type HizoFSApplicationStableReadNamespaceCapture,
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
import {
  SessionLifecycle,
  type OwnedSessionChild,
  type SessionChildRegistration,
} from "@/00-storage/service/hizofs/runtime/session-lifecycle";
import type {
  HizoFSRuntimePolicy,
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
  case "immediate_publication": return "durable_publication";
  case "lazy_publication": return "working_candidate_acceptance";
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

export type HizoFSReadObservationFactory = ({ capture }: {
  capture: "at_open" | "per_operation";
}) => Promise<Readonly<Pick<StorageFileSystemSession, "root" | "close">>>;

type ReadObservationOwner = Pick<ContainerRuntimeSession, "registerReadChild" | "runReadOperation">;

class OwnedReadObservationRuntimeSession implements HizoFSApplicationRuntimeSession {
  private readonly lifecycle: SessionLifecycle;
  private readonly parent: ReadObservationOwner;
  private registration: SessionChildRegistration | undefined;
  private revoked = false;

  constructor({ parent, release }: { parent: ReadObservationOwner; release: () => void }) {
    this.parent = parent;
    this.lifecycle = new SessionLifecycle({ releaseResources: async () => {
      try {
        release();
      } finally {
        this.registration?.releaseOwnership();
      }
    } });
  }

  assertOpen(): void {
    if (this.revoked || this.lifecycle.state() !== "open") {
      throw new Error("HizoFS read observation is closing or closed");
    }
  }

  attach({ close }: { close: () => Promise<void> }): void {
    this.registration = this.parent.registerReadChild({ child: {
      close,
      revoke: () => {
        this.revoked = true;
      },
    } });
  }

  registerReadChild({ child }: { child: OwnedSessionChild }): SessionChildRegistration {
    this.assertOpen();
    return this.lifecycle.registerChild({ child });
  }

  async acquireWriter(): Promise<HizoFSApplicationRuntimeWriter> {
    throw new Error("HizoFS read observation cannot acquire a writer");
  }

  async close(): Promise<void> {
    this.revoked = true;
    await this.lifecycle.close();
  }

  async runReadOperation<Value>({ operation }: { operation: () => Promise<Value> }): Promise<Value> {
    this.assertOpen();
    return await this.lifecycle.runOperation({ operation: async () => await this.parent.runReadOperation({
      operation: async () => {
        this.assertOpen();
        return await operation();
      },
    }) });
  }
}

async function createReadObservation({
  assertOperationAllowed,
  capture,
  captureStableReadNamespace,
  mutationPort,
  namespace,
  parent,
  rootName,
  rootPath,
}: {
  assertOperationAllowed: (() => void) | undefined;
  capture: "at_open" | "per_operation";
  captureStableReadNamespace: () => HizoFSApplicationStableReadNamespaceCapture;
  mutationPort: HizoFSApplicationMutationPort;
  namespace: HizoFSApplicationSessionNamespace;
  parent: ReadObservationOwner;
  rootName: string | undefined;
  rootPath: readonly string[] | undefined;
}): Promise<Readonly<{ port: HizoFSApplicationSessionPort; session: StorageFileSystemSession }>> {
  let opened: Readonly<{
    port: HizoFSApplicationSessionPort;
    runtime: OwnedReadObservationRuntimeSession;
    session: StorageFileSystemSession;
  }> | undefined;
  let runtime: OwnedReadObservationRuntimeSession | undefined;
  try {
    await parent.runReadOperation({ operation: async () => {
      assertOperationAllowed?.();
      const captured = (() => {
        switch (capture) {
        case "at_open": return captureStableReadNamespace();
        case "per_operation": return undefined;
        default: return capture satisfies never;
        }
      })();
      const readNamespace = captured?.namespace ?? namespace;
      const captureRead = captured === undefined
        ? captureStableReadNamespace
        : () => ({ namespace: readNamespace, release: () => undefined });
      runtime = new OwnedReadObservationRuntimeSession({
        parent,
        release: () => captured?.release(),
      });
      const observationRuntime = runtime;
      const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
        ...(assertOperationAllowed === undefined ? {} : { assertOperationAllowed }),
        captureStableReadNamespace: captureRead,
        // Directory iterators retain this accepted view, never the normal
        // snapshot factory that may materialize and publish a working Commit.
        createReadSnapshot: async () => (await createReadObservation({
          assertOperationAllowed,
          capture: "at_open",
          captureStableReadNamespace: captureRead,
          mutationPort,
          namespace: readNamespace,
          parent: observationRuntime,
          rootName,
          rootPath,
        })).port,
        mutationPort,
        namespace: readNamespace,
        runtimeSession: observationRuntime,
        sync: async () => {
          throw new Error("HizoFS read observation cannot sync");
        },
      } });
      const session = createHizoFSStorageFileSystemSession({ port, rootName, rootPath });
      opened = { port, runtime: observationRuntime, session };
      // Close the complete storage owner so file readers and paged iterators
      // drain before their captured roots or the parent resources are released.
      observationRuntime.attach({ close: async () => await session.close() });
    } });
    if (opened === undefined) throw new Error("HizoFS read observation did not open");
    opened.runtime.assertOpen();
    assertOperationAllowed?.();
    return opened;
  } catch (cause: unknown) {
    try {
      if (opened !== undefined) await opened.session.close();
      else await runtime?.close();
    } catch (cleanupFailure: unknown) {
      throw new AggregateError([cause, cleanupFailure], "read observation open and cleanup both failed");
    }
    throw cause;
  }
}

class PinnedReadSnapshotRuntimeSession implements HizoFSApplicationRuntimeSession {
  private closePromise: Promise<void> | undefined;
  private idleWaiters = new Set<() => void>();
  private inFlightOperations = 0;
  private pin: Awaited<ReturnType<ContainerRuntimeSession["acquireReaderPin"]>>;
  private resources: Awaited<ReturnType<ContainerRuntimeSession["captureAndAcquireDetachedReaderSnapshot"]>>["resources"];
  private state: "closed" | "closing" | "open" = "open";

  constructor({ pin, resources }: {
    pin: Awaited<ReturnType<ContainerRuntimeSession["acquireReaderPin"]>>;
    resources: Awaited<ReturnType<ContainerRuntimeSession["captureAndAcquireDetachedReaderSnapshot"]>>["resources"];
  }) {
    this.pin = pin;
    this.resources = resources;
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
      return await operation();
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
    const failures: unknown[] = [];
    try {
      this.pin.release();
      await this.pin.released;
    } catch (cause: unknown) {
      failures.push(cause);
    }
    try {
      await this.resources.release();
    } catch (cause: unknown) {
      failures.push(cause);
    }
    this.state = "closed";
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "HizoFS read snapshot cleanup failed");
    }
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
  let preparedResources: PreparedReadSnapshotResources | undefined;
  let captured: Readonly<{
    pin: Awaited<ReturnType<ContainerRuntimeSession["acquireReaderPin"]>>;
    resources: Awaited<ReturnType<ContainerRuntimeSession["captureAndAcquireDetachedReaderSnapshot"]>>["resources"];
    value: PreparedReadSnapshotResources;
  }>;
  try {
    captured = await parent.captureAndAcquireDetachedReaderSnapshot({
      capture: async () => {
        const resources = await createResources();
        preparedResources = resources;
        return { commitReference: resources.commitReference, value: resources };
      },
    });
  } catch (cause: unknown) {
    try {
      preparedResources?.releasePreparation?.();
    } catch (cleanupCause: unknown) {
      throw new AggregateError(
        [cause, cleanupCause],
        "HizoFS reader-pin acquisition and snapshot preparation cleanup both failed",
      );
    }
    throw cause;
  }
  const resources = captured.value;
  const pin = captured.pin;
  try {
    resources.releasePreparation?.();
    assertOperationAllowed?.();
    return createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      ...(assertOperationAllowed === undefined ? {} : { assertOperationAllowed }),
      mutationPort: resources.mutationPort,
      namespace: resources.namespace,
      runtimeSession: new PinnedReadSnapshotRuntimeSession({ pin, resources: captured.resources }),
      sync: async () => requireStorageFileSystemSyncDurability({
        durability: syncDurability,
        implementation: "hizofs",
      }),
    } });
  } catch (cause: unknown) {
    const failures: unknown[] = [cause];
    try {
      pin.release();
      await pin.released;
    } catch (cleanupCause: unknown) {
      failures.push(cleanupCause);
    }
    try {
      await captured.resources.release();
    } catch (cleanupCause: unknown) {
      failures.push(cleanupCause);
    }
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(
      failures,
      "HizoFS read snapshot construction and detached resource cleanup failed",
    );
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

  constructor({ crossRealmLockPort, policy, scope }: {
    crossRealmLockPort: CrossRealmLockPort;
    policy: HizoFSRuntimePolicy;
    scope: ContainerCoordinationScope;
  }) {
    this.runtime = new ContainerRuntime({
      crossRealmLockPort,
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
      captureStableReadNamespace?: () => HizoFSApplicationStableReadNamespaceCapture;
      createReadSnapshotResources?: ReadSnapshotResourceFactory;
      mutationPort: HizoFSApplicationMutationPort;
      namespace: HizoFSApplicationSessionNamespace;
      readOnlyMutationPort?: HizoFSApplicationMutationPort;
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
    recheckAuthority: ({ captured }: { captured: Captured }) => Promise<void>;
    registerRuntimeSession?: ({ openReadObservation, runtimeSession }: {
      openReadObservation: HizoFSReadObservationFactory | undefined;
      runtimeSession: HizoFSApplicationRuntimeSession;
    }) => void;
    rootName?: string;
    rootPath?: readonly string[];
    runtimeOwnerPolicy?: HizoFSRuntimeOwnerOpenPolicy;
    verifyCapturedAuthority: ({ captured }: { captured: Captured }) => Promise<Verified>;
  }): Promise<StorageFileSystemSession> {
    let applicationResources: Readonly<{
      authenticatedGeneration: ContainerRuntimeAuthenticatedApplicationGeneration | undefined;
      captureStableReadNamespace: (() => HizoFSApplicationStableReadNamespaceCapture) | undefined;
      createReadSnapshotResources: ReadSnapshotResourceFactory | undefined;
      mutationPort: HizoFSApplicationMutationPort;
      namespace: HizoFSApplicationSessionNamespace;
      readOnlyMutationPort: HizoFSApplicationMutationPort | undefined;
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
          captureStableReadNamespace,
          createReadSnapshotResources,
          mutationPort,
          namespace,
          readOnlyMutationPort,
          releaseResources,
          syncDurability,
          workerMountGrantIssuer,
          ...unhandledResources
        } = resources;
        unhandledResources satisfies Record<PropertyKey, never>;
        applicationResources = {
          authenticatedGeneration,
          captureStableReadNamespace,
          createReadSnapshotResources,
          mutationPort,
          namespace,
          readOnlyMutationPort,
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
    const captureStableReadNamespace = resolvedApplicationResources.captureStableReadNamespace;
    const createReadSnapshotResources = resolvedApplicationResources.createReadSnapshotResources;
    const sync = async (): Promise<void> => {
      const authenticatedGeneration = resolvedApplicationResources.authenticatedGeneration;
      const target = authenticatedGeneration?.captureSyncTarget();
      const targetWasAlreadyDurable = target !== undefined
        && authenticatedGeneration?.isSyncTargetDurable({ target }) === true;
      await session.syncDurableState({
        assertDurabilityDemonstrated: () => requireStorageFileSystemSyncDurability({
          durability: resolvedApplicationResources.syncDurability,
          implementation: "hizofs",
        }),
        recheckAuthority: resolvedApplicationResources.recheckSyncAuthority,
        writerBarrierRequired: !targetWasAlreadyDurable,
      });
      try {
        if (!targetWasAlreadyDurable) await authenticatedGeneration?.requestExplicitFlush();
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
      const fileSystemSession = new HizoFSStorageFileSystemSession({
        port: createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
          ...(assertOperationAllowed === undefined ? {} : { assertOperationAllowed }),
          ...(captureStableReadNamespace === undefined ? {} : { captureStableReadNamespace }),
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
      const readOnlyMutationPort = resolvedApplicationResources.readOnlyMutationPort;
      const openReadObservation: HizoFSReadObservationFactory | undefined =
        captureStableReadNamespace === undefined || readOnlyMutationPort === undefined
          ? undefined
          : async ({ capture }) => {
            const observation = await createReadObservation({
              assertOperationAllowed: () => {
                fileSystemSession.assertOpen();
                assertOperationAllowed?.();
              },
              capture,
              captureStableReadNamespace,
              mutationPort: readOnlyMutationPort,
              namespace: resolvedApplicationResources.namespace,
              parent: session,
              rootName,
              rootPath,
            });
            return { close: async () => await observation.session.close(), root: observation.session.root };
          };
      registerRuntimeSession?.({ openReadObservation, runtimeSession: session });
      return fileSystemSession;
    } catch (cause: unknown) {
      return await closeRuntimeSessionAfterFailure({
        cause,
        message: "application session construction and runtime session cleanup both failed",
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

  acquireWorkingGenerationDependencyRoot({ commitReference }:
  Parameters<ContainerRuntime["acquireWorkingGenerationDependencyRoot"]>[0]):
  ReturnType<ContainerRuntime["acquireWorkingGenerationDependencyRoot"]> {
    return this.runtime.acquireWorkingGenerationDependencyRoot({ commitReference });
  }

  acquireWorkingGenerationPageRoot({ pageReference }:
  Parameters<ContainerRuntime["acquireWorkingGenerationPageRoot"]>[0]):
  ReturnType<ContainerRuntime["acquireWorkingGenerationPageRoot"]> {
    return this.runtime.acquireWorkingGenerationPageRoot({ pageReference });
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
