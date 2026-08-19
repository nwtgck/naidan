import {
  encodeBase64UrlUnpadded,
  sameFileSystemCommitPayloadFields,
  encodeHomeRecordReference,
  type DirectoryLeafEntry,
  type HomeRecordReference,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import type { ContainerCoordinationKey } from "@/00-storage/service/hizofs/filesystem/container-coordination-key";
import {
  HizoFSBackgroundFlushScheduler,
  type HizoFSBackgroundFlushSchedulerSnapshot,
  type HizoFSBackgroundFlushTimerPort,
  type HizoFSBackgroundFlushTrigger,
} from "@/00-storage/service/hizofs/runtime/background-flush-scheduler";
import {
  ActiveSegmentRegistry,
  type ActiveSegmentDeletionLease,
  type ActiveSegmentReference,
  type ActiveSegmentReferenceKind,
} from "@/00-storage/service/hizofs/runtime/active-segment-registry";
import {
  CapturedDirectoryIterator,
  type CapturedDirectoryGeneration,
} from "@/00-storage/service/hizofs/runtime/captured-directory-iterator";
import type { ContainerCoordinationScope } from "@/00-storage/service/hizofs/runtime/container-coordination-scope";
import {
  CrossRealmLockCoordinator,
  type CrossRealmLockPort,
  type CrossRealmReaderPin,
  type CrossRealmWriterLease,
} from "@/00-storage/service/hizofs/runtime/cross-realm-lock-coordinator";
import {
  ReaderPinRegistry,
  type ReaderPin,
} from "@/00-storage/service/hizofs/runtime/reader-pin-registry";
import {
  MaintenanceRootRegistry,
  type RuntimeMaintenanceRootCapture,
  type RuntimeMaintenanceRootRegistration,
} from "@/00-storage/service/hizofs/runtime/maintenance-root-registry";
import {
  RuntimeCoordinationRegistry,
  type RuntimeMaintenanceLease,
  type RuntimeWriterLease,
} from "@/00-storage/service/hizofs/runtime/runtime-coordination-registry";
import {
  CURRENT_HIZOFS_LAZY_PUBLICATION_ROLLOUT_GATE,
  createRuntimePolicy,
  resolvePublicationModeApplied,
  type HizoFSLazyPublicationRolloutGateReceipt,
  type HizoFSPublicationModeApplied,
  type HizoFSRuntimePolicy,
  type HizoFSWritableDurabilityProfile,
} from "@/00-storage/service/hizofs/runtime/runtime-policy";
import {
  RuntimeOwnerCoordinator,
  type RuntimeOwnerAttachment,
} from "@/00-storage/service/hizofs/runtime/runtime-owner-coordinator";
import {
  WorkingGenerationCoordinator,
  WorkingGenerationCoordinatorError,
  type WorkingGenerationCoordinatorSnapshot,
  type WorkingGenerationManagementBarrier,
} from "@/00-storage/service/hizofs/runtime/working-generation-coordinator";
import {
  WorkingCandidateCoordinator,
  type WorkingCandidateAdmission,
  type WorkingCandidateCoordinatorPublicationState,
  type WorkingCandidateOutcomeUnknownResolution,
} from "@/00-storage/service/hizofs/runtime/working-candidate-coordinator";
import {
  createWorkingGenerationAuthorityEpoch,
  createWorkingGenerationIdentity,
  createWorkingGenerationNumber,
  sameDurableGenerationIdentity,
  sameWorkingGenerationIdentity,
  type DurableGenerationIdentity,
  type WorkingGenerationIdentity,
} from "@/00-storage/service/hizofs/runtime/application-generation-identity";
import {
  createAuthenticatedApplicationGenerationDescriptor,
  createAuthenticatedStagedApplicationGenerationDescriptor,
  requireMaterializedApplicationGenerationDescriptor,
  type AuthenticatedApplicationGenerationDescriptor,
  type AuthenticatedDurableApplicationGenerationAuthority,
  type AuthenticatedStagedApplicationGenerationDescriptor,
  type AuthenticatedWorkingApplicationGenerationDescriptor,
} from "@/00-storage/service/hizofs/runtime/authenticated-application-generation";
import {
  openRuntimeSessionWithAuthorityHandshake,
  tryOpenRuntimeSessionWithAuthorityHandshake,
} from "@/00-storage/service/hizofs/runtime/session-open-handshake";
import {
  SessionLifecycle,
  SessionLifecycleError,
  type SessionChildRegistration,
  type SessionLifecycleState,
  type SessionOperationAuthority,
} from "@/00-storage/service/hizofs/runtime/session-lifecycle";


export type ContainerRuntimeImmediateMutationAdmission<Candidate extends object = object> = Readonly<{
  commitDurableSuccessor: ({ successor }: {
    successor: AuthenticatedApplicationGenerationDescriptor;
  }) => void;
  installSelectedCandidate: ({ candidate, successor }: {
    candidate: Candidate;
    successor: AuthenticatedApplicationGenerationDescriptor;
  }) => void;
  releasePublishedCandidate: () => void;
  replaceResourceReservation: ({ dirtyMetadataBytes, unpublishedPhysicalBytes }: {
    dirtyMetadataBytes: number;
    unpublishedPhysicalBytes: number;
  }) => void;
  retainSelectedCandidateOutcomeUnknown: ({ cause }: { cause: unknown }) => void;
  rollback: () => void;
  selectCandidateForPublication: () => Candidate;
}>;

export type ContainerRuntimeSelectedCandidatePublicationOutcome =
  | Readonly<{
    cause: unknown;
    refreshedDurableAuthority: AuthenticatedDurableApplicationGenerationAuthority;
    type: "not_published";
  }>
  | Readonly<{
    cause: unknown;
    type: "outcome_unknown";
  }>
  | Readonly<{
    durableSuccessor: AuthenticatedApplicationGenerationDescriptor;
    type: "published";
  }>;

export type ContainerRuntimeStagedCommitMaterializationAttempt = Readonly<{
  completeReusableCandidate: () => void;
  fail: () => void;
}>;

export type ContainerRuntimeSelectedCandidatePublisher = Readonly<{
  abandon: () => void;
  completeOutcomeUnknownResolution: ({ outcome }: {
    outcome: "confirmed_not_published" | "confirmed_published";
  }) => void;
  publish: ({ onCandidateMaterialized, onMaterializationAppendAttempt }: {
    onCandidateMaterialized: ({ candidateDurableIdentity }: {
      candidateDurableIdentity: DurableGenerationIdentity;
    }) => void;
    onMaterializationAppendAttempt: ({ frameBytes }: {
      frameBytes: number;
    }) => ContainerRuntimeStagedCommitMaterializationAttempt;
  }) => Promise<ContainerRuntimeSelectedCandidatePublicationOutcome>;
}>;

export type ContainerRuntimeAcceptedMutationAdmission = Readonly<{
  commitAcceptedStagedSuccessor: ({ publisher, successor }: {
    publisher: ContainerRuntimeSelectedCandidatePublisher;
    successor: AuthenticatedStagedApplicationGenerationDescriptor;
  }) => void;
  commitAcceptedSuccessor: ({ publisher, successor }: {
    publisher: ContainerRuntimeSelectedCandidatePublisher;
    successor: AuthenticatedApplicationGenerationDescriptor;
  }) => void;
  replaceResourceReservation: ({ dirtyMetadataBytes, unpublishedPhysicalBytes }: {
    dirtyMetadataBytes: number;
    unpublishedPhysicalBytes: number;
  }) => void;
  reserveStagedCommitMaterializationHeadroom: ({ bytes }: { bytes: number }) => void;
  rollback: () => void;
}>;

export type ContainerRuntimeManagementWriterOwnership = "acquire" | "caller_owned";

export type ContainerRuntimeManagementCleanHeadBarrier = Readonly<{
  flushAndCaptureCleanGeneration: () => Promise<AuthenticatedApplicationGenerationDescriptor>;
  release: () => void;
}>;

type ContainerRuntimeInternalWriterOwnership = Readonly<{
  release: () => Promise<void>;
  runPublication: <Value>({ operation }: { operation: () => Promise<Value> }) => Promise<Value>;
}>;

export type ContainerRuntimeAuthenticatedApplicationGeneration = Readonly<{
  capture: () => AuthenticatedWorkingApplicationGenerationDescriptor;
  publicationModeApplied: () => HizoFSPublicationModeApplied;
  captureSyncTarget: () => WorkingGenerationIdentity;
  isSyncTargetDurable: ({ target }: { target: WorkingGenerationIdentity }) => boolean;
  openAcceptedMutationAdmission: ({
    dirtyMetadataBytes,
    expectedBase,
    unpublishedPhysicalBytes,
  }: {
    dirtyMetadataBytes: number;
    expectedBase: AuthenticatedWorkingApplicationGenerationDescriptor;
    unpublishedPhysicalBytes: number;
  }) => ContainerRuntimeAcceptedMutationAdmission;
  openImmediateMutationAdmission: <Candidate extends object>({
    dirtyMetadataBytes,
    expectedBase,
    unpublishedPhysicalBytes,
  }: {
    dirtyMetadataBytes: number;
    expectedBase: AuthenticatedApplicationGenerationDescriptor;
    unpublishedPhysicalBytes: number;
  }) => ContainerRuntimeImmediateMutationAdmission<Candidate>;
  openManagementCleanHeadBarrier: ({ writerOwnership }: {
    writerOwnership?: ContainerRuntimeManagementWriterOwnership;
  }) => ContainerRuntimeManagementCleanHeadBarrier;
  requestExplicitFlush: () => Promise<void>;
  refreshDurableAuthority: ({
    durableAuthority,
    expectedWorkingIdentity,
  }: {
    durableAuthority: AuthenticatedDurableApplicationGenerationAuthority;
    expectedWorkingIdentity: WorkingGenerationIdentity;
  }) => AuthenticatedApplicationGenerationDescriptor;
  waitForInFlightPublication: () => Promise<boolean>;
  waitForSyncTarget: ({ target }: { target: WorkingGenerationIdentity }) => Promise<void>;
}>;

export type ContainerRuntimeReaderPin = Readonly<{
  commitReference: HomeRecordReference;
  release: () => void;
  released: Promise<void>;
}>;

export type ContainerRuntimeMaintenanceRootCapture = Readonly<{
  inspectorPinnedRoots: readonly HomeRecordReference[];
  maintenanceRootEpoch: number;
  readerPinnedRoots: readonly HomeRecordReference[];
  release: () => void;
  released: Promise<void>;
  sourceSegmentPinnedRoots: readonly HomeRecordReference[];
  unknownFeatureRoots: readonly HomeRecordReference[];
  workingGenerationDependencyRoots: readonly HomeRecordReference[];
  workingGenerationPageRoots: readonly HomeRecordReference[];
}>;

export type ContainerRuntimeLazyDurabilityDiagnostics = Readonly<{
  acceptedGeneration: string | null;
  backgroundFlush: HizoFSBackgroundFlushSchedulerSnapshot;
  candidatePublicationState: WorkingCandidateCoordinatorPublicationState;
  dirtyMetadataBytes: number;
  dirtyMutationCount: number;
  durableGeneration: string | null;
  flushState: "flushing" | "idle" | "stalled";
  managementBarrierActive: boolean;
  mutationAdmissionActive: boolean;
  appliedPublicationMode: HizoFSPublicationModeApplied;
  lazyPublicationRollout: HizoFSLazyPublicationRolloutGateReceipt;
  requestedPublicationMode: HizoFSRuntimePolicy["lazyDurability"]["publicationModeRequest"];
  stagedCommitMaterializationHeadroomBytes: number;
  syncWaiters: number;
  unpublishedPhysicalBytes: number;
}>;

export type ContainerRuntimeHostDisposalBlocker =
  | "active_segment_resource"
  | "maintenance_root_resource"
  | "management_barrier_active"
  | "explicit_flush_in_flight"
  | "runtime_coordination_active"
  | "runtime_owner_acquiring"
  | "runtime_owner_failed"
  | "runtime_owner_releasing"
  | "session_attached"
  | "session_open_in_flight"
  | "working_candidate_not_empty"
  | "working_generation_not_durable";

export type ContainerRuntimeHostDisposalResult =
  | Readonly<{ status: "disposed" }>
  | Readonly<{ blocker: ContainerRuntimeHostDisposalBlocker; status: "retained" }>;

export type ContainerRuntimeHostLifecycleErrorCode =
  | "runtime_host_disposal_in_progress"
  | "runtime_host_disposed";

export class ContainerRuntimeHostLifecycleError extends Error {
  readonly code: ContainerRuntimeHostLifecycleErrorCode;

  constructor({ code, message }: { code: ContainerRuntimeHostLifecycleErrorCode; message: string }) {
    super(message);
    this.name = "ContainerRuntimeHostLifecycleError";
    this.code = code;
  }
}

export type ContainerRuntimeWriterErrorCode =
  | "capability_closed"
  | "operation_in_progress";

export class ContainerRuntimeWriterError extends Error {
  readonly code: ContainerRuntimeWriterErrorCode;

  constructor({ code, message }: { code: ContainerRuntimeWriterErrorCode; message: string }) {
    super(message);
    this.name = "ContainerRuntimeWriterError";
    this.code = code;
  }
}

function referenceIdentity({ reference }: { reference: HomeRecordReference }): string {
  return encodeBase64UrlUnpadded({ bytes: encodeHomeRecordReference({ reference }) });
}

function releaseAllNow({ releases }: { releases: readonly (() => void)[] }): void {
  const failures: unknown[] = [];
  for (const release of releases) {
    try {
      release();
    } catch (cause: unknown) {
      failures.push(cause);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "multiple runtime resources failed to release");
}

async function waitForReleaseCompletion({ completions }: {
  completions: readonly Promise<void>[];
}): Promise<void> {
  const failures: unknown[] = [];
  for (const result of await Promise.allSettled(completions)) {
    switch (result.status) {
    case "fulfilled": break;
    case "rejected": failures.push(result.reason); break;
    default: result satisfies never;
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "multiple runtime release completions failed");
}

class OwnedReaderPin implements ContainerRuntimeReaderPin, ReaderPin {
  private active = true;
  private crossRealmPin: CrossRealmReaderPin;
  private localPin: ReaderPin;
  private registration: SessionChildRegistration | undefined;

  constructor({ crossRealmPin, localPin, session, ownedBySession }: {
    crossRealmPin: CrossRealmReaderPin;
    localPin: ReaderPin;
    ownedBySession: boolean;
    session: SessionLifecycle;
  }) {
    this.crossRealmPin = crossRealmPin;
    this.localPin = localPin;
    if (ownedBySession) {
      this.registration = session.registerChild({ child: {
        close: async () => {
          const failures: unknown[] = [];
          try {
            this.release();
          } catch (cause: unknown) {
            failures.push(cause);
          }
          try {
            await this.released;
          } catch (cause: unknown) {
            failures.push(cause);
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) throw new AggregateError(failures, "reader pin release failed");
        },
        revoke: () => undefined,
      } });
    }
  }

  get commitReference(): HomeRecordReference {
    return this.localPin.commitReference;
  }

  get released(): Promise<void> {
    return Promise.all([this.localPin.released, this.crossRealmPin.released]).then(() => undefined);
  }

  release(): void {
    if (!this.active) return;
    this.active = false;
    const registration = this.registration;
    void this.released.then(
      () => registration?.releaseOwnership(),
      () => registration?.releaseOwnership(),
    );
    this.registration = undefined;
    releaseAllNow({ releases: [
      () => this.localPin.release(),
      () => this.crossRealmPin.release(),
    ] });
  }
}

class OwnedSegmentReference {
  private active = true;
  private reference: ActiveSegmentReference;
  private registration: SessionChildRegistration;

  constructor({ reference, session }: {
    reference: ActiveSegmentReference;
    session: SessionLifecycle;
  }) {
    this.reference = reference;
    this.registration = session.registerChild({ child: {
      close: async () => this.release(),
      revoke: () => undefined,
    } });
  }

  release(): void {
    if (!this.active) return;
    this.active = false;
    this.reference.release();
    this.registration.releaseOwnership();
  }
}

export class ContainerRuntimeWriter {
  private active = true;
  private busy = false;
  private closePromise: Promise<void> | undefined;
  private crossRealmWriter: CrossRealmWriterLease;
  private localWriter: RuntimeWriterLease;
  private registration: SessionChildRegistration;
  private revoked = false;
  private session: SessionLifecycle;

  constructor({ crossRealmWriter, localWriter, session }: {
    crossRealmWriter: CrossRealmWriterLease;
    localWriter: RuntimeWriterLease;
    session: SessionLifecycle;
  }) {
    this.crossRealmWriter = crossRealmWriter;
    this.localWriter = localWriter;
    this.session = session;
    this.registration = session.registerChild({ child: {
      close: async () => await this.closeOwned(),
      revoke: () => {
        this.revoked = true;
      },
    } });
  }

  private assertUsable(): void {
    if (!this.active || this.revoked) {
      throw new ContainerRuntimeWriterError({
        code: "capability_closed",
        message: "writer capability is closed or revoked by its owner session",
      });
    }
    if (this.busy) {
      throw new ContainerRuntimeWriterError({
        code: "operation_in_progress",
        message: "writer mutation is already in progress",
      });
    }
  }

  async runPublication<T>({ operation }: {
    operation: ({ authority }: { authority: SessionOperationAuthority }) => Promise<T>;
  }): Promise<T> {
    this.assertUsable();
    this.busy = true;
    try {
      return await this.session.runOperation({ operation: async ({ authority }) => {
        authority.assertPublicationAllowed();
        return await this.localWriter.runPublication({ operation: async () => {
          return await this.crossRealmWriter.runPublication({ operation: async () => {
            authority.assertPublicationAllowed();
            return await operation({ authority });
          } });
        } });
      } });
    } finally {
      this.busy = false;
    }
  }

  private async closeOwned(): Promise<void> {
    if (this.closePromise !== undefined) return await this.closePromise;
    if (this.busy) {
      throw new ContainerRuntimeWriterError({
        code: "operation_in_progress",
        message: "writer cannot release ownership while an operation is active",
      });
    }
    this.active = false;
    this.closePromise = (async () => {
      const failures: unknown[] = [];
      try {
        releaseAllNow({ releases: [
          () => this.localWriter.release(),
          () => this.crossRealmWriter.release(),
        ] });
      } catch (cause: unknown) {
        failures.push(cause);
      }
      try {
        await this.crossRealmWriter.released;
      } catch (cause: unknown) {
        failures.push(cause);
      }
      this.registration.releaseOwnership();
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "writer ownership release failed");
    })();
    return await this.closePromise;
  }

  async close(): Promise<void> {
    await this.closeOwned();
  }
}

type RetainedSessionResources = Readonly<{
  release: () => Promise<void>;
}>;

class SharedSessionResourceLifetime {
  private activeReferences = 1;
  private ownerReleased = false;
  private releaseResources: () => Promise<void>;
  private releaseCompletion: Promise<void> | undefined;

  constructor({ releaseResources }: {
    releaseResources: () => Promise<void>;
  }) {
    this.releaseResources = releaseResources;
  }

  retain(): RetainedSessionResources {
    if (this.activeReferences === 0) {
      throw new SessionLifecycleError({
        code: "capability_closed",
        message: "session resources are already released",
      });
    }
    this.activeReferences += 1;
    let active = true;
    return Object.freeze({
      release: async () => {
        if (!active) return;
        active = false;
        await this.releaseReference();
      },
    });
  }

  async releaseOwner(): Promise<void> {
    if (this.ownerReleased) return;
    this.ownerReleased = true;
    await this.releaseReference();
  }

  private async releaseReference(): Promise<void> {
    if (this.activeReferences <= 0) {
      throw new TypeError("session resource reference count underflow");
    }
    this.activeReferences -= 1;
    if (this.activeReferences !== 0) return;
    this.releaseCompletion ??= this.releaseResources();
    await this.releaseCompletion;
  }
}

export class ContainerRuntimeSession {
  private activeSegments: ActiveSegmentRegistry;
  private captureInFlightPublication: () => Promise<void> | undefined;
  private coordinationKey: ContainerCoordinationKey;
  private crossRealm: CrossRealmLockCoordinator;
  private lifecycle: SessionLifecycle;
  private limits: HizoFSRuntimePolicy;
  private readerPins: ReaderPinRegistry;
  private resources: SharedSessionResourceLifetime;
  private runtimeCoordination: RuntimeCoordinationRegistry;

  constructor({
    activeSegments,
    captureInFlightPublication,
    coordinationKey,
    crossRealm,
    limits,
    readerPins,
    releaseResources,
    runtimeCoordination,
  }: {
    activeSegments: ActiveSegmentRegistry;
    captureInFlightPublication: () => Promise<void> | undefined;
    coordinationKey: ContainerCoordinationKey;
    crossRealm: CrossRealmLockCoordinator;
    limits: HizoFSRuntimePolicy;
    readerPins: ReaderPinRegistry;
    releaseResources: () => Promise<void>;
    runtimeCoordination: RuntimeCoordinationRegistry;
  }) {
    this.activeSegments = activeSegments;
    this.captureInFlightPublication = captureInFlightPublication;
    this.coordinationKey = coordinationKey;
    this.crossRealm = crossRealm;
    this.limits = limits;
    this.readerPins = readerPins;
    this.resources = new SharedSessionResourceLifetime({ releaseResources });
    this.runtimeCoordination = runtimeCoordination;
    this.lifecycle = new SessionLifecycle({
      releaseResources: async () => await this.resources.releaseOwner(),
    });
  }

  state(): SessionLifecycleState {
    return this.lifecycle.state();
  }

  async close(): Promise<void> {
    await this.lifecycle.close();
  }

  async runReadOperation<T>({ operation }: {
    operation: () => Promise<T>;
  }): Promise<T> {
    return await this.lifecycle.runOperation({ operation: async () => await operation() });
  }

  private async captureAndAcquireReaderPinInternal<Value>({ capture, ownedBySession }: {
    capture: () => Promise<Readonly<{ commitReference: HomeRecordReference; value: Value }>>;
    ownedBySession: boolean;
  }): Promise<Readonly<{ pin: OwnedReaderPin; value: Value }>> {
    return await this.lifecycle.runOperation({ operation: async ({ authority }) => {
      const captured = await this.crossRealm.captureAndAcquireReaderPin({ capture });
      const crossRealmPin = captured.pin;
      let localPin: ReaderPin | undefined;
      try {
        localPin = this.readerPins.acquire({
          commitReference: crossRealmPin.commitReference,
          coordinationKey: this.coordinationKey,
        });
        authority.assertCapabilityReturnAllowed();
        return {
          pin: new OwnedReaderPin({
            crossRealmPin,
            localPin,
            ownedBySession,
            session: this.lifecycle,
          }),
          value: captured.value,
        };
      } catch (cause: unknown) {
        const acquiredLocalPin = localPin;
        const releases = acquiredLocalPin === undefined
          ? [() => crossRealmPin.release()]
          : [() => acquiredLocalPin.release(), () => crossRealmPin.release()];
        try {
          releaseAllNow({ releases });
          await waitForReleaseCompletion({ completions: [crossRealmPin.released] });
        } catch (cleanupCause: unknown) {
          throw new AggregateError([cause, cleanupCause], "reader pin acquisition and cleanup both failed");
        }
        throw cause;
      }
    } });
  }

  private async acquireReaderPinInternal({ commitReference, ownedBySession }: {
    commitReference: HomeRecordReference;
    ownedBySession: boolean;
  }): Promise<OwnedReaderPin> {
    const captured = await this.captureAndAcquireReaderPinInternal({
      capture: async () => ({ commitReference, value: undefined }),
      ownedBySession,
    });
    return captured.pin;
  }

  async acquireReaderPin({ commitReference }: {
    commitReference: HomeRecordReference;
  }): Promise<ContainerRuntimeReaderPin> {
    return await this.acquireReaderPinInternal({ commitReference, ownedBySession: true });
  }

  async captureAndAcquireReaderPin<Value>({ capture }: {
    capture: () => Promise<Readonly<{ commitReference: HomeRecordReference; value: Value }>>;
  }): Promise<Readonly<{ pin: ContainerRuntimeReaderPin; value: Value }>> {
    return await this.captureAndAcquireReaderPinInternal({ capture, ownedBySession: true });
  }

  async captureAndAcquireDetachedReaderSnapshot<Value>({ capture }: {
    capture: () => Promise<Readonly<{ commitReference: HomeRecordReference; value: Value }>>;
  }): Promise<Readonly<{
    pin: ContainerRuntimeReaderPin;
    resources: RetainedSessionResources;
    value: Value;
  }>> {
    const captured = await this.captureAndAcquireReaderPinInternal({ capture, ownedBySession: false });
    let resources: RetainedSessionResources | undefined;
    try {
      resources = await this.lifecycle.runOperation({ operation: async ({ authority }) => {
        const retained = this.resources.retain();
        try {
          authority.assertCapabilityReturnAllowed();
          return retained;
        } catch (cause: unknown) {
          try {
            await retained.release();
          } catch (cleanupCause: unknown) {
            throw new AggregateError(
              [cause, cleanupCause],
              "snapshot resource retention and rollback both failed",
            );
          }
          throw cause;
        }
      } });
      return Object.freeze({ pin: captured.pin, resources, value: captured.value });
    } catch (cause: unknown) {
      const failures: unknown[] = [cause];
      try {
        captured.pin.release();
        await captured.pin.released;
      } catch (cleanupCause: unknown) {
        failures.push(cleanupCause);
      }
      if (resources !== undefined) {
        try {
          await resources.release();
        } catch (cleanupCause: unknown) {
          failures.push(cleanupCause);
        }
      }
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, "detached reader snapshot acquisition cleanup failed");
    }
  }

  async createDirectoryIterator({ entries, generation }: {
    entries: readonly DirectoryLeafEntry[];
    generation: CapturedDirectoryGeneration;
  }): Promise<CapturedDirectoryIterator> {
    const pin = await this.acquireReaderPinInternal({
      commitReference: generation.commitReference,
      ownedBySession: false,
    });
    try {
      return new CapturedDirectoryIterator({
        entries,
        generation,
        maxEntries: this.limits.maxDirectoryIteratorEntries,
        pin,
        session: this.lifecycle,
      });
    } catch (cause: unknown) {
      try {
        pin.release();
        await pin.released;
      } catch (cleanupCause: unknown) {
        throw new AggregateError([cause, cleanupCause], "directory iterator creation and pin cleanup both failed");
      }
      throw cause;
    }
  }

  async acquireWriter(): Promise<ContainerRuntimeWriter> {
    return await this.lifecycle.runOperation({ operation: async ({ authority }) => {
      for (;;) {
        const crossRealmWriter = await this.crossRealm.acquireWriter();
        let localWriter: RuntimeWriterLease | undefined;
        try {
          localWriter = this.runtimeCoordination.acquireWriter({
            coordinationKey: this.coordinationKey,
          });
        } catch (cause: unknown) {
          try {
            crossRealmWriter.release();
            await crossRealmWriter.released;
          } catch (cleanupCause: unknown) {
            throw new AggregateError([cause, cleanupCause], "writer acquisition and cleanup both failed");
          }
          throw cause;
        }

        const publication = this.captureInFlightPublication();
        if (publication !== undefined) {
          // WHY: a foreground writer can have entered the cross-realm FIFO
          // before a prior mutation reaches resource pressure or a dirty-age
          // timer requests publication. Yield here, before returning the writer
          // capability to application code, so that queued publication can
          // close the dirty epoch. Admission itself must not wait on the flush:
          // a prepared writable may already own this writer and would deadlock
          // if its commit waited for publication that is waiting for its lease.
          try {
            releaseAllNow({ releases: [
              () => localWriter.release(),
              () => crossRealmWriter.release(),
            ] });
            await crossRealmWriter.released;
          } catch (cleanupCause: unknown) {
            throw new AggregateError(
              [cleanupCause],
              "foreground writer yield before queued publication failed",
            );
          }
          await publication;
          continue;
        }

        try {
          authority.assertCapabilityReturnAllowed();
          return new ContainerRuntimeWriter({ crossRealmWriter, localWriter, session: this.lifecycle });
        } catch (cause: unknown) {
          try {
            releaseAllNow({ releases: [
              () => localWriter.release(),
              () => crossRealmWriter.release(),
            ] });
            await crossRealmWriter.released;
          } catch (cleanupCause: unknown) {
            throw new AggregateError([cause, cleanupCause], "writer acquisition and cleanup both failed");
          }
          throw cause;
        }
      }
    } });
  }

  async syncDurableState({ assertDurabilityDemonstrated, recheckAuthority, writerBarrierRequired = true }: {
    assertDurabilityDemonstrated: () => void;
    recheckAuthority: () => Promise<void>;
    writerBarrierRequired?: boolean;
  }): Promise<void> {
    if (!writerBarrierRequired) {
      await this.lifecycle.runOperation({ operation: async ({ authority }) => {
        // WHY: a sync target that was already durable when captured does not
        // include any unaccepted prepared mutation. Re-acquiring the container
        // writer would let that unrelated prepared mutation self-deadlock sync.
        authority.assertCapabilityReturnAllowed();
        assertDurabilityDemonstrated();
        await recheckAuthority();
        authority.assertCapabilityReturnAllowed();
        assertDurabilityDemonstrated();
      } });
      return;
    }
    const writer = await this.acquireWriter();
    let primary: unknown | undefined;
    try {
      await writer.runPublication({ operation: async ({ authority }) => {
        authority.assertPublicationAllowed();
        assertDurabilityDemonstrated();
        await recheckAuthority();
        authority.assertPublicationAllowed();
        assertDurabilityDemonstrated();
      } });
    } catch (cause: unknown) {
      primary = cause;
    }
    try {
      await writer.close();
    } catch (closeCause: unknown) {
      if (primary !== undefined) {
        throw new AggregateError([primary, closeCause], "sync barrier and writer cleanup both failed");
      }
      throw closeCause;
    }
    if (primary !== undefined) throw primary;
  }

  async acquireSegmentReference({ kind, segmentId }: {
    kind: ActiveSegmentReferenceKind;
    segmentId: SegmentId;
  }): Promise<Readonly<{ release: () => void }>> {
    return await this.lifecycle.runOperation({ operation: async ({ authority }) => {
      const reference = this.activeSegments.acquire({
        coordinationKey: this.coordinationKey,
        kind,
        segmentId,
      });
      try {
        authority.assertCapabilityReturnAllowed();
        return new OwnedSegmentReference({ reference, session: this.lifecycle });
      } catch (cause: unknown) {
        reference.release();
        throw cause;
      }
    } });
  }
}

export class ContainerRuntime {
  private backgroundFlushScheduler: HizoFSBackgroundFlushScheduler;
  private disposal: Promise<ContainerRuntimeHostDisposalResult> | undefined;
  private flushOperation: Promise<void> | undefined;
  private hostLifecycleState: "active" | "disposed" | "disposing" = "active";
  private sessionOpenCount = 0;
  private activeSegments: ActiveSegmentRegistry;
  private appliedPublicationMode: HizoFSPublicationModeApplied;
  private lazyPublicationRollout: HizoFSLazyPublicationRolloutGateReceipt;
  private authenticatedApplicationGeneration: AuthenticatedWorkingApplicationGenerationDescriptor | undefined;
  private crossRealm: CrossRealmLockCoordinator;
  private limits: HizoFSRuntimePolicy;
  private maintenanceRoots: MaintenanceRootRegistry;
  private readerPins: ReaderPinRegistry;
  private runtimeCoordination = new RuntimeCoordinationRegistry();
  private runtimeOwner: RuntimeOwnerCoordinator;
  private scope: ContainerCoordinationScope;
  private workingCandidates: WorkingCandidateCoordinator;
  private workingGenerations: WorkingGenerationCoordinator | undefined;

  constructor({ backgroundFlushTimerPort, crossRealmLockPort, lazyPublicationRollout, limits, scope }: {
    backgroundFlushTimerPort?: HizoFSBackgroundFlushTimerPort;
    crossRealmLockPort: CrossRealmLockPort;
    lazyPublicationRollout?: HizoFSLazyPublicationRolloutGateReceipt;
    limits: HizoFSRuntimePolicy;
    scope: ContainerCoordinationScope;
  }) {
    const validatedPolicy = createRuntimePolicy(limits);
    this.lazyPublicationRollout = lazyPublicationRollout
      ?? CURRENT_HIZOFS_LAZY_PUBLICATION_ROLLOUT_GATE;
    this.appliedPublicationMode = resolvePublicationModeApplied({
      lazyPublicationRollout: this.lazyPublicationRollout,
      publicationModeRequest: validatedPolicy.lazyDurability.publicationModeRequest,
      writableProfile: "development-unverified",
    });
    this.activeSegments = new ActiveSegmentRegistry({
      maxReferencesPerContainer: validatedPolicy.maxSegmentReferences,
    });
    this.backgroundFlushScheduler = new HizoFSBackgroundFlushScheduler({
      maximumDirtyAgeMilliseconds: validatedPolicy.lazyDurability.maximumDirtyAgeMilliseconds,
      requestFlush: async ({ trigger }) => await this.requestBackgroundFlush({ trigger }),
      ...(backgroundFlushTimerPort === undefined ? {} : { timerPort: backgroundFlushTimerPort }),
    });
    this.crossRealm = new CrossRealmLockCoordinator({
      lockPort: crossRealmLockPort,
      maxHeldLockNames: validatedPolicy.maxHeldLockNames,
      scopeToken: scope.token,
    });
    this.limits = validatedPolicy;
    this.maintenanceRoots = new MaintenanceRootRegistry({
      maxRegistrationsPerContainer: validatedPolicy.maxMaintenanceRootRegistrations,
    });
    this.readerPins = new ReaderPinRegistry({
      maintenanceRoots: this.maintenanceRoots,
      maxPinsPerContainer: validatedPolicy.maxReaderPins,
    });
    this.scope = scope;
    this.workingCandidates = new WorkingCandidateCoordinator({
      acquireWorkingGenerationDependencyRoot: ({ commitReference }) => (
        this.maintenanceRoots.acquireWorkingGenerationDependencyRoot({
          commitReference,
          coordinationKey: this.scope.key,
        })
      ),
      acquireWorkingGenerationPageRoot: ({ pageReference }) => (
        this.maintenanceRoots.acquireWorkingGenerationPageRoot({
          coordinationKey: this.scope.key,
          pageReference,
        })
      ),
    });
    this.runtimeOwner = new RuntimeOwnerCoordinator({
      acquireLease: async () => await this.crossRealm.acquireRuntimeOwner(),
      isReleaseSafe: () => (
        this.workingCandidates.publicationState() === "empty"
        && this.workingGenerationHasCleanDurableHead({ allowManagementBarrier: false })
      ),
      tryAcquireLease: async () => await this.crossRealm.tryAcquireRuntimeOwner(),
    });
  }

  private workingGenerationSnapshot(): WorkingGenerationCoordinatorSnapshot | undefined {
    return this.workingGenerations?.snapshot();
  }

  lazyDurabilityDiagnostics(): ContainerRuntimeLazyDurabilityDiagnostics {
    const generation = this.workingGenerationSnapshot();
    return Object.freeze({
      acceptedGeneration: generation?.workingGeneration.generationNumber.toString(10) ?? null,
      backgroundFlush: this.backgroundFlushScheduler.snapshot(),
      candidatePublicationState: this.workingCandidates.publicationState(),
      dirtyMetadataBytes: generation?.dirtyResources.dirtyMetadataBytes ?? 0,
      dirtyMutationCount: generation?.dirtyResources.acceptedMutationCount ?? 0,
      durableGeneration: generation?.durableGeneration.generationNumber.toString(10) ?? null,
      flushState: generation?.flushState ?? "idle",
      managementBarrierActive: generation?.managementBarrierActive ?? false,
      lazyPublicationRollout: this.lazyPublicationRollout,
      mutationAdmissionActive: (generation?.dirtyResources.pendingAdmissionCount ?? 0) !== 0,
      appliedPublicationMode: this.appliedPublicationMode,
      requestedPublicationMode: this.limits.lazyDurability.publicationModeRequest,
      stagedCommitMaterializationHeadroomBytes:
        generation?.dirtyResources.stagedCommitMaterializationHeadroomBytes ?? 0,
      syncWaiters: generation?.syncWaiterCount ?? 0,
      unpublishedPhysicalBytes: generation?.dirtyResources.unpublishedPhysicalBytes ?? 0,
    });
  }

  private workingGenerationHasCleanDurableHead({ allowManagementBarrier }: {
    allowManagementBarrier: boolean;
  }): boolean {
    const snapshot = this.workingGenerationSnapshot();
    if (snapshot === undefined) return true;
    return snapshot.flushState === "idle"
      && (allowManagementBarrier || !snapshot.managementBarrierActive)
      && snapshot.syncWaiterCount === 0
      && snapshot.dirtyResources.acceptedMutationCount === 0
      && snapshot.dirtyResources.dirtyMetadataBytes === 0
      && snapshot.dirtyResources.pendingAdmissionCount === 0
      && snapshot.dirtyResources.stagedCommitMaterializationHeadroomBytes === 0
      && snapshot.dirtyResources.unpublishedPhysicalBytes === 0
      && sameWorkingGenerationIdentity({
        left: snapshot.durableGeneration,
        right: snapshot.workingGeneration,
      });
  }

  private requireAuthenticatedApplicationGeneration(): AuthenticatedWorkingApplicationGenerationDescriptor {
    const current = this.authenticatedApplicationGeneration;
    if (current === undefined) {
      throw new TypeError("authenticated application generation is not attached to this runtime");
    }
    return current;
  }

  private requireWorkingGenerations(): WorkingGenerationCoordinator {
    const coordinator = this.workingGenerations;
    if (coordinator === undefined) {
      throw new TypeError("working generation coordinator is not initialized for this runtime");
    }
    return coordinator;
  }

  attachAuthenticatedApplicationGeneration({
    durableAuthority,
    writableProfile = "development-unverified",
  }: {
    durableAuthority: AuthenticatedDurableApplicationGenerationAuthority;
    writableProfile?: HizoFSWritableDurabilityProfile;
  }): ContainerRuntimeAuthenticatedApplicationGeneration {
    const appliedPublicationMode = resolvePublicationModeApplied({
      lazyPublicationRollout: this.lazyPublicationRollout,
      publicationModeRequest: this.limits.lazyDurability.publicationModeRequest,
      writableProfile,
    });
    const current = this.authenticatedApplicationGeneration;
    if (current === undefined) {
      this.appliedPublicationMode = appliedPublicationMode;
      const initial = createAuthenticatedApplicationGenerationDescriptor({
        commit: durableAuthority.commit,
        commitReference: durableAuthority.commitReference,
        durableAuthority,
        workingIdentity: createWorkingGenerationIdentity({
          authorityEpoch: createWorkingGenerationAuthorityEpoch(),
          generationNumber: createWorkingGenerationNumber({ value: 0n }),
          mutationId: durableAuthority.commit.mutationId,
        }),
      });
      this.authenticatedApplicationGeneration = initial;
      this.workingGenerations = new WorkingGenerationCoordinator({
        initialDurableGeneration: initial.workingIdentity,
        policy: this.limits.lazyDurability,
      });
    } else if (!sameDurableGenerationIdentity({
      left: current.durableAuthority.identity,
      right: durableAuthority.identity,
    })) {
      throw new TypeError("authenticated durable authority conflicts with the runtime generation authority");
    } else if (this.appliedPublicationMode !== appliedPublicationMode) {
      throw new TypeError("applied publication mode conflicts with the runtime publication mode receipt");
    }

    return Object.freeze({
      capture: () => this.requireAuthenticatedApplicationGeneration(),
      captureSyncTarget: () => this.requireWorkingGenerations().captureSyncTarget(),
      isSyncTargetDurable: ({ target }) => this.requireWorkingGenerations().isSyncTargetDurable({ target }),
      publicationModeApplied: () => this.appliedPublicationMode,
      openAcceptedMutationAdmission: ({
        dirtyMetadataBytes,
        expectedBase,
        unpublishedPhysicalBytes,
      }) => this.openAcceptedMutationAdmission({
        dirtyMetadataBytes,
        expectedBase,
        unpublishedPhysicalBytes,
      }),
      openImmediateMutationAdmission: <Candidate extends object>({
        dirtyMetadataBytes,
        expectedBase,
        unpublishedPhysicalBytes,
      }: {
        dirtyMetadataBytes: number;
        expectedBase: AuthenticatedApplicationGenerationDescriptor;
        unpublishedPhysicalBytes: number;
      }) => this.openImmediateMutationAdmission<Candidate>({
        dirtyMetadataBytes,
        expectedBase,
        unpublishedPhysicalBytes,
      }),
      openManagementCleanHeadBarrier: ({ writerOwnership }) => this.openManagementCleanHeadBarrierInternal({ writerOwnership }),
      requestExplicitFlush: () => {
        this.backgroundFlushScheduler.prepareExplicitFlush();
        return this.requestRuntimeFlush({ acquireWriterOwnership: true, managementBarrier: undefined });
      },
      refreshDurableAuthority: ({ durableAuthority: refreshed, expectedWorkingIdentity }) => (
        this.refreshAuthenticatedDurableAuthority({
          durableAuthority: refreshed,
          expectedWorkingIdentity,
        })
      ),
      waitForInFlightPublication: async () => {
        const operation = this.flushOperation;
        if (operation === undefined) return false;
        await operation;
        return true;
      },
      waitForSyncTarget: async ({ target }) => await this.requireWorkingGenerations().waitForSyncTarget({ target }),
    });
  }

  private async acquireInternalWriterOwnership(): Promise<ContainerRuntimeInternalWriterOwnership> {
    const crossRealmWriter = await this.crossRealm.acquireWriter();
    let localWriter: RuntimeWriterLease | undefined;
    try {
      localWriter = this.runtimeCoordination.acquireWriter({ coordinationKey: this.scope.key });
    } catch (cause: unknown) {
      try {
        crossRealmWriter.release();
        await crossRealmWriter.released;
      } catch (cleanupCause: unknown) {
        throw new AggregateError([cause, cleanupCause], "runtime writer ownership acquisition and cleanup both failed");
      }
      throw cause;
    }
    let active = true;
    return Object.freeze({
      release: async () => {
        if (!active) return;
        active = false;
        const failures: unknown[] = [];
        try {
          localWriter?.release();
        } catch (cause: unknown) {
          failures.push(cause);
        }
        try {
          crossRealmWriter.release();
        } catch (cause: unknown) {
          failures.push(cause);
        }
        try {
          await crossRealmWriter.released;
        } catch (cause: unknown) {
          failures.push(cause);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "runtime writer ownership release failed");
      },
      runPublication: async <Value>({ operation }: { operation: () => Promise<Value> }): Promise<Value> => {
        if (!active) throw new TypeError("runtime writer ownership is already released");
        return await localWriter.runPublication({ operation: async () => await crossRealmWriter.runPublication({
          operation,
        }) });
      },
    });
  }

  private openManagementCleanHeadBarrierInternal({ writerOwnership = "acquire" }: {
    writerOwnership?: ContainerRuntimeManagementWriterOwnership;
  } = {}): ContainerRuntimeManagementCleanHeadBarrier {
    this.backgroundFlushScheduler.prepareExplicitFlush();
    let managementBarrier: WorkingGenerationManagementBarrier | undefined;
    let active = true;
    const requireActive = (): void => {
      if (!active) throw new TypeError("runtime management clean-head barrier is already released");
    };
    const ensureManagementBarrier = (): WorkingGenerationManagementBarrier => {
      managementBarrier ??= this.requireWorkingGenerations().openManagementBarrier();
      return managementBarrier;
    };
    const flushUnderOwnedWriter = async (): Promise<AuthenticatedApplicationGenerationDescriptor> => {
      const barrier = ensureManagementBarrier();
      await this.requestRuntimeFlush({ managementBarrier: barrier });
      const current = this.requireAuthenticatedApplicationGeneration();
      if (!sameWorkingGenerationIdentity({
        left: current.workingIdentity,
        right: barrier.target,
      })) {
        throw new TypeError("management clean-head barrier target changed while mutation admission was closed");
      }
      return requireMaterializedApplicationGenerationDescriptor({ descriptor: current });
    };
    return Object.freeze({
      flushAndCaptureCleanGeneration: async () => {
        requireActive();
        switch (writerOwnership) {
        case "caller_owned": return await flushUnderOwnedWriter();
        case "acquire": {
          // WHY: management settlement can materialize a staged Commit through
          // the same Segment writer owner used by prepared/foreground writes.
          // Acquire the ordinary writer gate before mutation admission is
          // fenced, so an existing prepared writer can finish instead of being
          // trapped behind a barrier that needs its Segment lease.
          const ownership = await this.acquireInternalWriterOwnership();
          let primary: unknown | undefined;
          let result: AuthenticatedApplicationGenerationDescriptor | undefined;
          try {
            result = await ownership.runPublication({ operation: flushUnderOwnedWriter });
          } catch (cause: unknown) {
            primary = cause;
          }
          try {
            await ownership.release();
          } catch (cleanupCause: unknown) {
            if (primary !== undefined) {
              throw new AggregateError([primary, cleanupCause], "management clean-head flush and writer cleanup both failed");
            }
            throw cleanupCause;
          }
          if (primary !== undefined) throw primary;
          if (result === undefined) throw new TypeError("management clean-head flush completed without a generation");
          return result;
        }
        default: return writerOwnership satisfies never;
        }
      },
      release: () => {
        requireActive();
        managementBarrier?.close();
        active = false;
      },
    });
  }

  private failBackgroundDurability({ cause }: { cause: unknown }): void {
    this.requireWorkingGenerations().markDurabilityStalled({ cause });
    this.backgroundFlushScheduler.markStalled();
  }

  private notifyBackgroundFlushForegroundIdle(): void {
    try {
      this.backgroundFlushScheduler.notifyForegroundIdle();
    } catch (cause: unknown) {
      // WHY: a deferred background publication owns a previously accepted
      // dirty generation. If rearming its timer fails as foreground authority
      // becomes idle, losing the trigger would leave that generation dirty
      // but apparently healthy. Fail-stop the durability state instead.
      this.failBackgroundDurability({ cause });
      throw cause;
    }
  }

  private async requestBackgroundFlush({ trigger }: {
    trigger: HizoFSBackgroundFlushTrigger;
  }): Promise<void> {
    try {
      await this.requestRuntimeFlush({ acquireWriterOwnership: true, managementBarrier: undefined });
    } catch (cause: unknown) {
      if (cause instanceof WorkingGenerationCoordinatorError && cause.code === "working_authority_busy") {
        this.backgroundFlushScheduler.deferAfterForegroundBusy({ trigger });
        if ((this.workingGenerationSnapshot()?.dirtyResources.pendingAdmissionCount ?? 0) === 0) {
          // The foreground admission may have closed before this async catch ran.
          // Rechecking after registering the deferral prevents a lost wake-up.
          this.notifyBackgroundFlushForegroundIdle();
        }
        return;
      }
      // WHY: background publication is fire-and-forget, so a failure before
      // runFlush() opens a generation flush capability has no foreground
      // caller that can own it. Move that failure into the same fail-stopped
      // durability state used by publication failures. Existing reads remain
      // valid, while new mutations fail closed until explicit sync retries.
      this.failBackgroundDurability({ cause });
      throw cause;
    }
  }

  private requestRuntimeFlush({ acquireWriterOwnership = false, managementBarrier }: {
    acquireWriterOwnership?: boolean;
    managementBarrier: WorkingGenerationManagementBarrier | undefined;
  }): Promise<void> {
    const existing = this.flushOperation;
    if (existing !== undefined) return existing;
    const operation = (async () => {
      const runFlush = async (): Promise<void> => {
        const coordinator = this.requireWorkingGenerations();
        const snapshot = coordinator.snapshot();
        const current = this.requireAuthenticatedApplicationGeneration();
        if (!sameWorkingGenerationIdentity({
          left: current.workingIdentity,
          right: snapshot.workingGeneration,
        })) {
          throw new TypeError("explicit flush runtime descriptor does not match the working generation");
        }
        const flush = managementBarrier === undefined
          ? coordinator.openFlush()
          : managementBarrier.openFlush();
        if (sameWorkingGenerationIdentity({
          left: snapshot.durableGeneration,
          right: snapshot.workingGeneration,
        })) {
          flush.complete({ durableGeneration: flush.target });
          this.backgroundFlushScheduler.markDurable();
          return;
        }

        let publication;
        try {
          publication = this.workingCandidates.openCurrentPublication<ContainerRuntimeSelectedCandidatePublisher>();
        } catch (cause: unknown) {
          flush.fail({ cause });
          throw cause;
        }
        const failOutcomeUnknown = ({ cause }: { cause: unknown }): never => {
          const failures: unknown[] = [cause];
          try {
            publication.retainOutcomeUnknown({ cause });
          } catch (cleanupCause: unknown) {
            failures.push(cleanupCause);
          }
          try {
            flush.fail({ cause });
          } catch (cleanupCause: unknown) {
            failures.push(cleanupCause);
          }
          this.backgroundFlushScheduler.markStalled();
          if (failures.length === 1) throw cause;
          throw new AggregateError(failures, "selected candidate publication and outcome retention both failed");
        };
        if (
          !sameWorkingGenerationIdentity({ left: publication.workingIdentity, right: flush.target })
          || !sameWorkingGenerationIdentity({ left: publication.workingIdentity, right: current.workingIdentity })
          || !sameDurableGenerationIdentity({
            left: publication.durableBaseIdentity,
            right: current.durableAuthority.identity,
          })
        ) {
          return failOutcomeUnknown({
            cause: new TypeError("selected candidate publication authority does not match the runtime generation"),
          });
        }

        let outcome: ContainerRuntimeSelectedCandidatePublicationOutcome;
        try {
          outcome = await publication.candidate.publish({
            onCandidateMaterialized: ({ candidateDurableIdentity }) => {
              publication.bindMaterializedCandidate({ candidateDurableIdentity });
            },
            onMaterializationAppendAttempt: ({ frameBytes }) => (
              flush.beginStagedCommitMaterializationAttempt({ frameBytes })
            ),
          });
        } catch (cause: unknown) {
          return failOutcomeUnknown({ cause });
        }
        switch (outcome.type) {
        case "not_published": {
          if (!sameDurableGenerationIdentity({
            left: outcome.refreshedDurableAuthority.identity,
            right: publication.durableBaseIdentity,
          })) {
            return failOutcomeUnknown({
              cause: new AggregateError(
                [outcome.cause],
                "not-published outcome returned a conflicting durable authority",
              ),
            });
          }
          this.authenticatedApplicationGeneration = (() => {
            switch (current.workingRootAuthority.type) {
            case "materialized_commit":
              return createAuthenticatedApplicationGenerationDescriptor({
                commit: current.commit,
                commitReference: current.workingRootAuthority.commitReference,
                durableAuthority: outcome.refreshedDurableAuthority,
                workingIdentity: current.workingIdentity,
              });
            case "direct_working_pages":
              return createAuthenticatedStagedApplicationGenerationDescriptor({
                commit: current.commit,
                durableAuthority: outcome.refreshedDurableAuthority,
                workingIdentity: current.workingIdentity,
              });
            default: return current.workingRootAuthority satisfies never;
            }
          })();
          const failures: unknown[] = [];
          try {
            publication.restoreInstalled();
          } catch (cleanupCause: unknown) {
            failures.push(cleanupCause);
          }
          try {
            flush.fail({ cause: outcome.cause });
          } catch (cleanupCause: unknown) {
            failures.push(cleanupCause);
          }
          this.backgroundFlushScheduler.markStalled();
          if (failures.length > 0) {
            throw new AggregateError(
              [outcome.cause, ...failures],
              "not-published selected candidate cleanup failed",
            );
          }
          throw outcome.cause;
        }
        case "outcome_unknown": return failOutcomeUnknown({ cause: outcome.cause });
        case "published": {
          if (
            !sameWorkingGenerationIdentity({
              left: outcome.durableSuccessor.workingIdentity,
              right: publication.workingIdentity,
            })
            || !sameDurableGenerationIdentity({
              left: outcome.durableSuccessor.durableAuthority.identity,
              right: publication.requireCandidateDurableIdentity(),
            })
          ) {
            return failOutcomeUnknown({
              cause: new TypeError("published selected candidate does not match its retained runtime authority"),
            });
          }
          this.authenticatedApplicationGeneration = outcome.durableSuccessor;
          flush.complete({ durableGeneration: publication.workingIdentity });
          publication.completePublished();
          this.backgroundFlushScheduler.markDurable();
          return;
        }
        default: return outcome satisfies never;
        }
      };
      if (!acquireWriterOwnership) {
        await runFlush();
        return;
      }

      // WHY: Commit materialization uses the same physical Segment writer
      // owner as foreground mutations. Own the ordinary container writer gate
      // before entering flush so foreground and flush-time Segment leases can
      // never overlap, including across realms.
      const ownership = await this.acquireInternalWriterOwnership();
      let primary: unknown | undefined;
      try {
        await ownership.runPublication({ operation: runFlush });
      } catch (cause: unknown) {
        primary = cause;
      }
      try {
        await ownership.release();
      } catch (cleanupCause: unknown) {
        if (primary !== undefined) {
          throw new AggregateError([primary, cleanupCause], "runtime flush and writer ownership cleanup both failed");
        }
        throw cleanupCause;
      }
      if (primary !== undefined) throw primary;
    })();
    const tracked = operation.finally(() => {
      if (this.flushOperation === tracked) this.flushOperation = undefined;
    });
    this.flushOperation = tracked;
    return tracked;
  }

  private openAcceptedMutationAdmission({ dirtyMetadataBytes, expectedBase, unpublishedPhysicalBytes }: {
    dirtyMetadataBytes: number;
    expectedBase: AuthenticatedWorkingApplicationGenerationDescriptor;
    unpublishedPhysicalBytes: number;
  }): ContainerRuntimeAcceptedMutationAdmission {
    // A queued flush may be waiting behind the caller's already-owned writer.
    // Do not wait for or reject on flushOperation here: a prepared writable
    // must be able to finish and release that writer, otherwise publication
    // and the foreground operation can wait on each other forever. Once the
    // queued flush actually owns the writer, WorkingGenerationCoordinator's
    // flush authority closes mutation admission normally.
    const current = this.requireAuthenticatedApplicationGeneration();
    if (
      !sameWorkingGenerationIdentity({ left: current.workingIdentity, right: expectedBase.workingIdentity })
      || !sameDurableGenerationIdentity({
        left: current.durableAuthority.identity,
        right: expectedBase.durableAuthority.identity,
      })
    ) {
      throw new TypeError("mutation base does not match the runtime application generation");
    }
    const coordinator = this.requireWorkingGenerations();
    const generationAdmission = coordinator.openMutationAdmission({ dirtyMetadataBytes, unpublishedPhysicalBytes });
    let candidateAdmission: WorkingCandidateAdmission<ContainerRuntimeSelectedCandidatePublisher>;
    try {
      candidateAdmission = this.workingCandidates.openAdmission({
        durableBaseIdentity: current.durableAuthority.identity,
        operationLabel: "accepted runtime mutation",
      });
    } catch (cause: unknown) {
      generationAdmission.rollback();
      throw cause;
    }
    let active = true;
    return Object.freeze({
      commitAcceptedStagedSuccessor: ({ publisher, successor }) => {
        if (!active) throw new TypeError("runtime accepted mutation admission is already closed");
        if (!sameDurableGenerationIdentity({
          left: successor.durableAuthority.identity,
          right: current.durableAuthority.identity,
        })) {
          throw new TypeError("accepted staged mutation successor must retain the current durable authority");
        }
        if (
          successor.workingIdentity.authorityEpoch !== current.workingIdentity.authorityEpoch
          || successor.workingIdentity.generationNumber !== current.workingIdentity.generationNumber + 1n
        ) {
          throw new TypeError("accepted staged mutation successor is not the exact next runtime generation");
        }
        let generationAccepted = false;
        try {
          const roots = successor.workingRootAuthority;
          candidateAdmission.installStaged({
            candidate: publisher,
            releaseCandidate: ({ disposition }) => {
              switch (disposition) {
              case "discarded": publisher.abandon(); return;
              case "confirmed_not_published":
              case "confirmed_published": publisher.completeOutcomeUnknownResolution({ outcome: disposition }); return;
              default: return disposition satisfies never;
              }
            },
            workingIdentity: successor.workingIdentity,
            workingPageReferences: roots.nestedSubvolumeTableRootHomeRef === null
              ? [roots.rootInodeTableRootHomeRef]
              : [roots.rootInodeTableRootHomeRef, roots.nestedSubvolumeTableRootHomeRef],
          });
          generationAdmission.accept({ workingGeneration: successor.workingIdentity });
          generationAccepted = true;
          // WHY: once the coordinator accepts this successor it is the working
          // authority. Bind the matching runtime descriptor and candidate
          // ownership before a fallible scheduler side effect so timer re-arm
          // failure cannot split the coordinator from the accepted runtime.
          this.authenticatedApplicationGeneration = successor;
          candidateAdmission.retainInstalled();
          this.notifyBackgroundFlushForegroundIdle();
          const dirtyResources = coordinator.snapshot().dirtyResources;
          const policy = this.limits.lazyDurability;
          this.backgroundFlushScheduler.markDirty({
            resourcePressure: dirtyResources.acceptedMutationCount >= policy.maximumAcceptedMutationsPerDirtyEpoch
              || dirtyResources.dirtyMetadataBytes >= policy.maximumDirtyMetadataBytes
              || dirtyResources.unpublishedPhysicalBytes >= policy.maximumUnpublishedPhysicalBytes,
          });
          active = false;
        } catch (cause: unknown) {
          active = false;
          if (generationAccepted) {
            const failures: unknown[] = [cause];
            try {
              const flush = coordinator.openFlush();
              flush.fail({ cause });
            } catch (cleanupCause: unknown) {
              failures.push(cleanupCause);
            }
            this.backgroundFlushScheduler.markStalled();
            if (failures.length === 1) throw cause;
            throw new AggregateError(
              failures,
              "accepted staged runtime mutation committed but fail-closed finalization failed",
            );
          }
          const cleanupFailures: unknown[] = [];
          try {
            candidateAdmission.resolve({ outcome: "discarded" });
          } catch (cleanupCause: unknown) {
            cleanupFailures.push(cleanupCause);
          }
          try {
            generationAdmission.rollback();
          } catch (cleanupCause: unknown) {
            cleanupFailures.push(cleanupCause);
          }
          if (cleanupFailures.length > 0) {
            throw new AggregateError(
              [cause, ...cleanupFailures],
              "accepted staged runtime mutation and rollback both failed",
            );
          }
          throw cause;
        }
      },
      commitAcceptedSuccessor: ({ publisher, successor }) => {
        if (!active) throw new TypeError("runtime accepted mutation admission is already closed");
        if (!sameDurableGenerationIdentity({
          left: successor.durableAuthority.identity,
          right: current.durableAuthority.identity,
        })) {
          throw new TypeError("accepted mutation successor must retain the current durable authority");
        }
        if (
          successor.workingIdentity.authorityEpoch !== current.workingIdentity.authorityEpoch
          || successor.workingIdentity.generationNumber !== current.workingIdentity.generationNumber + 1n
        ) {
          throw new TypeError("accepted mutation successor is not the exact next runtime generation");
        }
        let generationAccepted = false;
        try {
          candidateAdmission.install({
            candidate: publisher,
            candidateDurableIdentity: {
              commitReference: successor.commitReference,
              commitSequence: successor.commit.commitSequence,
              mutationId: successor.commit.mutationId,
            },
            releaseCandidate: ({ disposition }) => {
              switch (disposition) {
              case "discarded": publisher.abandon(); return;
              case "confirmed_not_published":
              case "confirmed_published": publisher.completeOutcomeUnknownResolution({ outcome: disposition }); return;
              default: return disposition satisfies never;
              }
            },
            workingIdentity: successor.workingIdentity,
          });
          generationAdmission.accept({ workingGeneration: successor.workingIdentity });
          generationAccepted = true;
          // WHY: once the coordinator accepts this successor it is the working
          // authority. Bind the matching runtime descriptor and candidate
          // ownership before a fallible scheduler side effect so timer re-arm
          // failure cannot split the coordinator from the accepted runtime.
          this.authenticatedApplicationGeneration = successor;
          candidateAdmission.retainInstalled();
          this.notifyBackgroundFlushForegroundIdle();
          const dirtyResources = coordinator.snapshot().dirtyResources;
          const policy = this.limits.lazyDurability;
          this.backgroundFlushScheduler.markDirty({
            resourcePressure: dirtyResources.acceptedMutationCount >= policy.maximumAcceptedMutationsPerDirtyEpoch
              || dirtyResources.dirtyMetadataBytes >= policy.maximumDirtyMetadataBytes
              || dirtyResources.unpublishedPhysicalBytes >= policy.maximumUnpublishedPhysicalBytes,
          });
          active = false;
        } catch (cause: unknown) {
          active = false;
          if (generationAccepted) {
            const failures: unknown[] = [cause];
            try {
              const flush = coordinator.openFlush();
              flush.fail({ cause });
            } catch (cleanupCause: unknown) {
              failures.push(cleanupCause);
            }
            this.backgroundFlushScheduler.markStalled();
            if (failures.length === 1) throw cause;
            throw new AggregateError(
              failures,
              "accepted runtime mutation committed but fail-closed finalization failed",
            );
          }
          const cleanupFailures: unknown[] = [];
          try {
            candidateAdmission.resolve({ outcome: "discarded" });
          } catch (cleanupCause: unknown) {
            cleanupFailures.push(cleanupCause);
          }
          try {
            generationAdmission.rollback();
          } catch (cleanupCause: unknown) {
            cleanupFailures.push(cleanupCause);
          }
          if (cleanupFailures.length > 0) {
            throw new AggregateError(
              [cause, ...cleanupFailures],
              "accepted runtime mutation and rollback both failed",
            );
          }
          throw cause;
        }
      },
      replaceResourceReservation: ({ dirtyMetadataBytes, unpublishedPhysicalBytes }) => {
        if (!active) throw new TypeError("runtime accepted mutation admission is already closed");
        generationAdmission.replaceResourceReservation({ dirtyMetadataBytes, unpublishedPhysicalBytes });
      },
      reserveStagedCommitMaterializationHeadroom: ({ bytes }) => {
        if (!active) throw new TypeError("runtime accepted mutation admission is already closed");
        generationAdmission.reserveStagedCommitMaterializationHeadroom({ bytes });
      },
      rollback: () => {
        if (!active) return;
        active = false;
        const failures: unknown[] = [];
        try {
          candidateAdmission.closeWithoutCandidate();
        } catch (cause: unknown) {
          failures.push(cause);
        }
        try {
          generationAdmission.rollback();
          this.notifyBackgroundFlushForegroundIdle();
        } catch (cause: unknown) {
          failures.push(cause);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, "runtime accepted mutation rollback failed");
        }
      },
    });
  }

  private openImmediateMutationAdmission<Candidate extends object>({
    dirtyMetadataBytes,
    expectedBase,
    unpublishedPhysicalBytes,
  }: {
    dirtyMetadataBytes: number;
    expectedBase: AuthenticatedApplicationGenerationDescriptor;
    unpublishedPhysicalBytes: number;
  }): ContainerRuntimeImmediateMutationAdmission<Candidate> {
    const current = this.requireAuthenticatedApplicationGeneration();
    if (
      !sameWorkingGenerationIdentity({ left: current.workingIdentity, right: expectedBase.workingIdentity })
      || !sameDurableGenerationIdentity({
        left: current.durableAuthority.identity,
        right: expectedBase.durableAuthority.identity,
      })
    ) {
      throw new TypeError("mutation base does not match the runtime application generation");
    }
    const coordinator = this.requireWorkingGenerations();
    const generationAdmission = coordinator.openMutationAdmission({ dirtyMetadataBytes, unpublishedPhysicalBytes });
    let candidateAdmission: WorkingCandidateAdmission<Candidate>;
    try {
      candidateAdmission = this.workingCandidates.openAdmission<Candidate>({
        durableBaseIdentity: current.durableAuthority.identity,
        operationLabel: "immediate runtime mutation",
      });
    } catch (cause: unknown) {
      generationAdmission.rollback();
      throw cause;
    }
    let active = true;
    let candidateInstalled = false;
    let durableCommitted = false;
    const assertActive = (): void => {
      if (!active) throw new TypeError("runtime mutation admission is already closed");
    };
    const closeCandidate = ({ outcome }: { outcome: "discarded" | "published" }): void => {
      if (candidateInstalled) {
        try {
          candidateAdmission.resolve({ outcome });
        } finally {
          candidateInstalled = false;
        }
      } else {
        candidateAdmission.closeWithoutCandidate();
      }
    };
    return Object.freeze({
      commitDurableSuccessor: ({ successor }) => {
        assertActive();
        if (!candidateInstalled) {
          throw new TypeError("immediate mutation must install its runtime candidate before durable commit");
        }
        if (!sameDurableGenerationIdentity({
          left: successor.durableAuthority.identity,
          right: {
            commitReference: successor.commitReference,
            commitSequence: successor.commit.commitSequence,
            mutationId: successor.commit.mutationId,
          },
        })) {
          throw new TypeError("immediate mutation successor is not durably published");
        }
        if (!candidateAdmission.matchesWorkingIdentity({ workingIdentity: successor.workingIdentity })) {
          throw new TypeError("durable successor does not match the selected runtime candidate");
        }
        generationAdmission.accept({ workingGeneration: successor.workingIdentity });
        // WHY: this successor is already durably published. Any deferred
        // background trigger became obsolete at that authority gate; rearming
        // it here adds a fallible timer side effect between generation accept
        // and durable-state convergence. markDurable() clears that deferred
        // scheduler state after the coordinator advances.
        const flush = coordinator.openFlush();
        flush.complete({ durableGeneration: successor.workingIdentity });
        this.authenticatedApplicationGeneration = successor;
        this.backgroundFlushScheduler.markDurable();
        durableCommitted = true;
      },
      installSelectedCandidate: ({ candidate, successor }) => {
        assertActive();
        if (candidateInstalled || durableCommitted) {
          throw new TypeError("immediate mutation cannot replace its selected runtime candidate");
        }
        if (!sameDurableGenerationIdentity({
          left: successor.durableAuthority.identity,
          right: current.durableAuthority.identity,
        })) {
          throw new TypeError("immediate mutation candidate must retain the current durable authority");
        }
        if (
          successor.workingIdentity.authorityEpoch !== current.workingIdentity.authorityEpoch
          || successor.workingIdentity.generationNumber !== current.workingIdentity.generationNumber + 1n
        ) {
          throw new TypeError("immediate mutation candidate is not the exact next runtime generation");
        }
        candidateAdmission.install({
          candidate,
          candidateDurableIdentity: {
            commitReference: successor.commitReference,
            commitSequence: successor.commit.commitSequence,
            mutationId: successor.commit.mutationId,
          },
          releaseCandidate: () => undefined,
          workingIdentity: successor.workingIdentity,
        });
        candidateInstalled = true;
      },
      releasePublishedCandidate: () => {
        assertActive();
        if (!durableCommitted) {
          throw new TypeError("immediate mutation candidate cannot be released before durable commit");
        }
        try {
          closeCandidate({ outcome: "published" });
        } finally {
          active = false;
        }
      },
      replaceResourceReservation: ({ dirtyMetadataBytes, unpublishedPhysicalBytes }) => {
        assertActive();
        if (durableCommitted) {
          throw new TypeError("durably committed runtime mutation cannot replace its resource reservation");
        }
        generationAdmission.replaceResourceReservation({ dirtyMetadataBytes, unpublishedPhysicalBytes });
      },
      retainSelectedCandidateOutcomeUnknown: ({ cause }) => {
        assertActive();
        if (!candidateInstalled || durableCommitted) {
          throw new TypeError("immediate mutation has no unresolved selected candidate to retain");
        }
        candidateAdmission.retainOutcomeUnknown({ cause });
        candidateInstalled = false;
        active = false;
        try {
          generationAdmission.rollback();
          this.notifyBackgroundFlushForegroundIdle();
        } catch (cleanupCause: unknown) {
          throw new AggregateError(
            [cause, cleanupCause],
            "outcome-unknown immediate mutation retained its candidate but failed to close generation admission",
          );
        }
      },
      rollback: () => {
        if (!active) return;
        const failures: unknown[] = [];
        try {
          closeCandidate({ outcome: durableCommitted ? "published" : "discarded" });
        } catch (cause: unknown) {
          failures.push(cause);
        }
        if (!durableCommitted) {
          try {
            generationAdmission.rollback();
            this.notifyBackgroundFlushForegroundIdle();
          } catch (cause: unknown) {
            failures.push(cause);
          }
        }
        active = false;
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, "runtime immediate mutation rollback failed");
        }
      },
      selectCandidateForPublication: () => {
        assertActive();
        if (!candidateInstalled || durableCommitted) {
          throw new TypeError("immediate mutation has no selected runtime candidate to publish");
        }
        return candidateAdmission.selectCandidateForPublication();
      },
    });
  }

  private refreshAuthenticatedDurableAuthority({ durableAuthority, expectedWorkingIdentity }: {
    durableAuthority: AuthenticatedDurableApplicationGenerationAuthority;
    expectedWorkingIdentity: WorkingGenerationIdentity;
  }): AuthenticatedApplicationGenerationDescriptor {
    const current = this.requireAuthenticatedApplicationGeneration();
    if (!sameWorkingGenerationIdentity({ left: current.workingIdentity, right: expectedWorkingIdentity })) {
      throw new TypeError("durable authority refresh base does not match the runtime working generation");
    }
    if (!this.workingGenerationHasCleanDurableHead({ allowManagementBarrier: true })) {
      throw new TypeError("cannot refresh durable authority while the runtime has dirty generation state");
    }
    if (!sameDurableGenerationIdentity({
      left: current.durableAuthority.identity,
      right: durableAuthority.identity,
    })) {
      throw new TypeError("durable authority refresh changed the persisted generation identity");
    }
    const materialized = requireMaterializedApplicationGenerationDescriptor({ descriptor: current });
    const refreshed = createAuthenticatedApplicationGenerationDescriptor({
      commit: materialized.commit,
      commitReference: materialized.commitReference,
      durableAuthority,
      workingIdentity: materialized.workingIdentity,
    });
    this.authenticatedApplicationGeneration = refreshed;
    return refreshed;
  }

  private beginSessionOpen(): void {
    switch (this.hostLifecycleState) {
    case "active":
      this.sessionOpenCount += 1;
      return;
    case "disposing":
      throw new ContainerRuntimeHostLifecycleError({
        code: "runtime_host_disposal_in_progress",
        message: "HizoFS runtime host disposal is in progress",
      });
    case "disposed":
      throw new ContainerRuntimeHostLifecycleError({
        code: "runtime_host_disposed",
        message: "HizoFS runtime host has been disposed",
      });
    default: return this.hostLifecycleState satisfies never;
    }
  }

  private finishSessionOpen(): void {
    if (this.sessionOpenCount < 1) throw new Error("runtime host session-open accounting became inconsistent");
    this.sessionOpenCount -= 1;
  }

  private hostDisposalBlocker({ allowFlushableDirtyState = false }: {
    allowFlushableDirtyState?: boolean;
  } = {}): ContainerRuntimeHostDisposalBlocker | undefined {
    if (this.flushOperation !== undefined) return "explicit_flush_in_flight";
    if (this.sessionOpenCount > 0) return "session_open_in_flight";
    if (this.runtimeOwner.attachmentCount() > 0) return "session_attached";
    if (this.workingGenerationSnapshot()?.managementBarrierActive === true) return "management_barrier_active";
    const publicationState = this.workingCandidates.publicationState();
    switch (publicationState) {
    case "empty": break;
    case "installed":
      if (allowFlushableDirtyState) break;
      return "working_candidate_not_empty";
    case "outcome_unknown":
    case "poisoned":
    case "publishing": return "working_candidate_not_empty";
    default: return publicationState satisfies never;
    }
    if (!this.workingGenerationHasCleanDurableHead({ allowManagementBarrier: false })) {
      const generation = this.workingGenerationSnapshot();
      if (
        !allowFlushableDirtyState
        || publicationState !== "installed"
        || (generation?.dirtyResources.pendingAdmissionCount ?? 0) !== 0
      ) {
        return "working_generation_not_durable";
      }
    }
    const runtimeCoordinationState = this.runtimeCoordination.activityState({ coordinationKey: this.scope.key });
    switch (runtimeCoordinationState) {
    case "active": return "runtime_coordination_active";
    case "idle": break;
    default: return runtimeCoordinationState satisfies never;
    }
    const activeSegmentState = this.activeSegments.activityState({ coordinationKey: this.scope.key });
    switch (activeSegmentState) {
    case "active": return "active_segment_resource";
    case "idle": break;
    default: return activeSegmentState satisfies never;
    }
    const readerPinState = this.readerPins.activityState({ coordinationKey: this.scope.key });
    switch (readerPinState) {
    case "active": return "maintenance_root_resource";
    case "idle": break;
    default: return readerPinState satisfies never;
    }
    const maintenanceRootState = this.maintenanceRoots.activityState({ coordinationKey: this.scope.key });
    switch (maintenanceRootState) {
    case "active": {
      const flushableCandidateRoot = allowFlushableDirtyState
        ? this.workingCandidates.retainedInstalledCandidateCommitReference()
        : undefined;
      if (
        flushableCandidateRoot !== undefined
        && this.maintenanceRoots.isSoleWorkingGenerationDependencyRoot({
          commitReference: flushableCandidateRoot,
          coordinationKey: this.scope.key,
        })
      ) {
        break;
      }
      const flushableWorkingPageRoots = allowFlushableDirtyState
        ? this.workingCandidates.retainedInstalledWorkingPageReferences()
        : undefined;
      if (
        flushableWorkingPageRoots !== undefined
        && this.maintenanceRoots.isExactSoleWorkingGenerationPageRoots({
          coordinationKey: this.scope.key,
          pageReferences: flushableWorkingPageRoots,
        })
      ) {
        break;
      }
      return "maintenance_root_resource";
    }
    case "idle": break;
    default: return maintenanceRootState satisfies never;
    }
    const ownerState = this.runtimeOwner.state();
    switch (ownerState) {
    case "idle":
    case "owned": return undefined;
    case "acquiring": return "runtime_owner_acquiring";
    case "failed": return "runtime_owner_failed";
    case "releasing": return "runtime_owner_releasing";
    default: return ownerState satisfies never;
    }
  }

  private async disposeIfIdleAndSafeInternal({ flushBeforeDispose }: {
    flushBeforeDispose: boolean;
  }): Promise<ContainerRuntimeHostDisposalResult> {
    switch (this.hostLifecycleState) {
    case "disposed": return Object.freeze({ status: "disposed" });
    case "active":
    case "disposing": break;
    default: return this.hostLifecycleState satisfies never;
    }
    const existing = this.disposal;
    if (existing !== undefined) return await existing;
    this.hostLifecycleState = "disposing";
    const disposal = (async (): Promise<ContainerRuntimeHostDisposalResult> => {
      const initialBlocker = this.hostDisposalBlocker({
        allowFlushableDirtyState: flushBeforeDispose,
      });
      if (initialBlocker !== undefined) {
        return Object.freeze({ blocker: initialBlocker, status: "retained" });
      }
      if (
        flushBeforeDispose
        && (
          this.workingCandidates.publicationState() === "installed"
          || !this.workingGenerationHasCleanDurableHead({ allowManagementBarrier: false })
        )
      ) {
        await this.requestRuntimeFlush({ acquireWriterOwnership: true, managementBarrier: undefined });
      }
      const postFlushBlocker = this.hostDisposalBlocker();
      if (postFlushBlocker !== undefined) {
        return Object.freeze({ blocker: postFlushBlocker, status: "retained" });
      }
      await this.runtimeOwner.releaseIfIdleAndSafe();
      const finalBlocker = this.hostDisposalBlocker();
      if (finalBlocker !== undefined) {
        return Object.freeze({ blocker: finalBlocker, status: "retained" });
      }
      return Object.freeze({ status: "disposed" });
    })();
    this.disposal = disposal;
    try {
      const result = await disposal;
      switch (result.status) {
      case "disposed": this.hostLifecycleState = "disposed"; break;
      case "retained": this.hostLifecycleState = "active"; break;
      default: return result satisfies never;
      }
      return result;
    } catch (cause: unknown) {
      this.hostLifecycleState = "active";
      throw cause;
    } finally {
      this.disposal = undefined;
    }
  }

  openManagementCleanHeadBarrier({ writerOwnership }: {
    writerOwnership?: ContainerRuntimeManagementWriterOwnership;
  }): ContainerRuntimeManagementCleanHeadBarrier {
    switch (this.hostLifecycleState) {
    case "active": return this.openManagementCleanHeadBarrierInternal({ writerOwnership });
    case "disposing":
      throw new ContainerRuntimeHostLifecycleError({
        code: "runtime_host_disposal_in_progress",
        message: "HizoFS runtime host disposal is in progress",
      });
    case "disposed":
      throw new ContainerRuntimeHostLifecycleError({
        code: "runtime_host_disposed",
        message: "HizoFS runtime host has been disposed",
      });
    default: return this.hostLifecycleState satisfies never;
    }
  }

  async disposeIfIdleAndSafe(): Promise<ContainerRuntimeHostDisposalResult> {
    return await this.disposeIfIdleAndSafeInternal({ flushBeforeDispose: false });
  }

  async flushAndDisposeIfIdleAndSafe(): Promise<ContainerRuntimeHostDisposalResult> {
    return await this.disposeIfIdleAndSafeInternal({ flushBeforeDispose: true });
  }

  async openSessionWithAuthorityHandshake<Captured, Verified>({
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
    this.beginSessionOpen();
    try {
      return await openRuntimeSessionWithAuthorityHandshake({
        acquireSessionOwner: async () => await this.runtimeOwner.attach(),
        captureAuthority,
        coordinator: this.crossRealm,
        createSession: ({ captured, sessionOwner, verified }) => {
          const resources = createSessionResources({ captured, verified });
          const { releaseResources, ...unhandledResources } = resources;
          unhandledResources satisfies Record<PropertyKey, never>;
          return this.createSession({
            releaseResources: async () => await this.releaseSessionResourcesAndRuntimeOwner({
              releaseResources,
              runtimeOwnerAttachment: sessionOwner,
            }),
          });
        },
        recheckAuthority,
        releaseSessionOwner: async ({ sessionOwner }) => await sessionOwner.release(),
        verifyCapturedAuthority,
      });
    } finally {
      this.finishSessionOpen();
    }
  }

  async tryOpenSessionWithAuthorityHandshake<Captured, Verified>({
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
    this.beginSessionOpen();
    try {
      return await tryOpenRuntimeSessionWithAuthorityHandshake({
        captureAuthority,
        coordinator: this.crossRealm,
        createSession: ({ captured, sessionOwner, verified }) => {
          const resources = createSessionResources({ captured, verified });
          const { releaseResources, ...unhandledResources } = resources;
          unhandledResources satisfies Record<PropertyKey, never>;
          return this.createSession({
            releaseResources: async () => await this.releaseSessionResourcesAndRuntimeOwner({
              releaseResources,
              runtimeOwnerAttachment: sessionOwner,
            }),
          });
        },
        recheckAuthority,
        releaseSessionOwner: async ({ sessionOwner }) => await sessionOwner.release(),
        tryAcquireSessionOwner: async () => await this.runtimeOwner.tryAttach(),
        verifyCapturedAuthority,
      });
    } finally {
      this.finishSessionOpen();
    }
  }

  private async releaseSessionResourcesAndRuntimeOwner({ releaseResources, runtimeOwnerAttachment }: {
    releaseResources: () => Promise<void>;
    runtimeOwnerAttachment: RuntimeOwnerAttachment;
  }): Promise<void> {
    const failures: unknown[] = [];
    try {
      await releaseResources();
    } catch (cause: unknown) {
      failures.push(cause);
    }
    try {
      await runtimeOwnerAttachment.release();
    } catch (cause: unknown) {
      failures.push(cause);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "session resources and runtime-owner attachment cleanup both failed");
    }
  }

  private createSession({ releaseResources }: {
    releaseResources: () => Promise<void>;
  }): ContainerRuntimeSession {
    return new ContainerRuntimeSession({
      activeSegments: this.activeSegments,
      captureInFlightPublication: () => this.flushOperation,
      coordinationKey: this.scope.key,
      crossRealm: this.crossRealm,
      limits: this.limits,
      readerPins: this.readerPins,
      releaseResources,
      runtimeCoordination: this.runtimeCoordination,
    });
  }

  openWorkingCandidateAdmission<Candidate extends object>({ durableBaseIdentity, operationLabel }: {
    durableBaseIdentity: DurableGenerationIdentity;
    operationLabel: string;
  }): WorkingCandidateAdmission<Candidate> {
    return this.workingCandidates.openAdmission<Candidate>({
      durableBaseIdentity,
      operationLabel,
    });
  }

  workingCandidatePublicationState(): WorkingCandidateCoordinatorPublicationState {
    return this.workingCandidates.publicationState();
  }

  resolveWorkingCandidateOutcomeUnknownAgainstDurableAuthority({ observedDurableIdentity }: {
    observedDurableIdentity: DurableGenerationIdentity;
  }): WorkingCandidateOutcomeUnknownResolution {
    return this.workingCandidates.resolveOutcomeUnknownAgainstDurableAuthority({
      observedDurableIdentity,
    });
  }

  resolveWorkingCandidateOutcomeUnknownAgainstAuthenticatedDurableAuthority({ observedDurableAuthority }: {
    observedDurableAuthority: AuthenticatedDurableApplicationGenerationAuthority;
  }): WorkingCandidateOutcomeUnknownResolution {
    const current = this.requireAuthenticatedApplicationGeneration();
    const resolution = this.workingCandidates.resolveOutcomeUnknownAgainstDurableAuthority({
      observedDurableIdentity: observedDurableAuthority.identity,
    });
    switch (resolution) {
    case "confirmed_published": {
      const commitPayloadMatches = sameFileSystemCommitPayloadFields({
        left: current.commit,
        right: observedDurableAuthority.commit,
      });
      const physicalIdentityMatches = (() => {
        switch (current.workingRootAuthority.type) {
        case "direct_working_pages": return true;
        case "materialized_commit": return sameDurableGenerationIdentity({
          left: {
            commitReference: current.workingRootAuthority.commitReference,
            commitSequence: current.commit.commitSequence,
            mutationId: current.commit.mutationId,
          },
          right: observedDurableAuthority.identity,
        });
        default: return current.workingRootAuthority satisfies never;
        }
      })();
      if (!commitPayloadMatches || !physicalIdentityMatches) {
        throw new TypeError("confirmed published authority does not match the runtime working generation");
      }
      this.requireWorkingGenerations().confirmCurrentWorkingGenerationDurable();
      this.authenticatedApplicationGeneration = createAuthenticatedApplicationGenerationDescriptor({
        commit: current.commit,
        commitReference: observedDurableAuthority.commitReference,
        durableAuthority: observedDurableAuthority,
        workingIdentity: current.workingIdentity,
      });
      this.backgroundFlushScheduler.markDurable();
      return resolution;
    }
    case "confirmed_not_published": {
      const workingIdentity = createWorkingGenerationIdentity({
        authorityEpoch: createWorkingGenerationAuthorityEpoch(),
        generationNumber: createWorkingGenerationNumber({ value: 0n }),
        mutationId: observedDurableAuthority.commit.mutationId,
      });
      this.authenticatedApplicationGeneration = createAuthenticatedApplicationGenerationDescriptor({
        commit: observedDurableAuthority.commit,
        commitReference: observedDurableAuthority.commitReference,
        durableAuthority: observedDurableAuthority,
        workingIdentity,
      });
      this.workingGenerations = new WorkingGenerationCoordinator({
        initialDurableGeneration: workingIdentity,
        policy: this.limits.lazyDurability,
      });
      this.backgroundFlushScheduler.markDurable();
      return resolution;
    }
    default: return resolution satisfies never;
    }
  }

  async resolveWorkingCandidateOutcomeUnknown({ observedDurableIdentity }: {
    observedDurableIdentity: DurableGenerationIdentity;
  }): Promise<WorkingCandidateOutcomeUnknownResolution> {
    const resolution = this.resolveWorkingCandidateOutcomeUnknownAgainstDurableAuthority({
      observedDurableIdentity,
    });
    await this.runtimeOwner.releaseIfIdleAndSafe();
    return resolution;
  }

  async beginCleanHeadMaintenanceRootCapture(): Promise<ContainerRuntimeMaintenanceRootCapture> {
    const managementBarrier = this.openManagementCleanHeadBarrier({});
    let capture: ContainerRuntimeMaintenanceRootCapture | undefined;
    try {
      await managementBarrier.flushAndCaptureCleanGeneration();
      capture = await this.beginMaintenanceRootCapture();
      let active = true;
      return Object.freeze({
        inspectorPinnedRoots: capture.inspectorPinnedRoots,
        maintenanceRootEpoch: capture.maintenanceRootEpoch,
        readerPinnedRoots: capture.readerPinnedRoots,
        release: () => {
          if (!active) return;
          active = false;
          // Keep local mutation admission fenced until the cross-realm and
          // local maintenance gates have both stopped protecting this snapshot.
          releaseAllNow({ releases: [
            () => capture?.release(),
            () => managementBarrier.release(),
          ] });
        },
        released: capture.released,
        sourceSegmentPinnedRoots: capture.sourceSegmentPinnedRoots,
        unknownFeatureRoots: capture.unknownFeatureRoots,
        workingGenerationDependencyRoots: capture.workingGenerationDependencyRoots,
        workingGenerationPageRoots: capture.workingGenerationPageRoots,
      });
    } catch (cause: unknown) {
      const cleanupFailures: unknown[] = [];
      try {
        capture?.release();
      } catch (cleanupCause: unknown) {
        cleanupFailures.push(cleanupCause);
      }
      try {
        if (capture !== undefined) await capture.released;
      } catch (cleanupCause: unknown) {
        cleanupFailures.push(cleanupCause);
      }
      try {
        managementBarrier.release();
      } catch (cleanupCause: unknown) {
        // A failed flush intentionally keeps mutation admission fenced. The
        // cleanup failure is retained with the primary maintenance failure.
        cleanupFailures.push(cleanupCause);
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [cause, ...cleanupFailures],
          "clean-head maintenance capture and cleanup both failed",
        );
      }
      throw cause;
    }
  }

  async beginMaintenanceRootCapture(): Promise<ContainerRuntimeMaintenanceRootCapture> {
    const crossRealmCapture = await this.crossRealm.beginMaintenance();
    let localMaintenance: RuntimeMaintenanceLease | undefined;
    let localRoots: RuntimeMaintenanceRootCapture | undefined;
    try {
      localMaintenance = this.runtimeCoordination.beginMaintenance({ coordinationKey: this.scope.key });
      localRoots = this.maintenanceRoots.captureRoots({ coordinationKey: this.scope.key });
      const unique = new Map<string, HomeRecordReference>();
      for (const reference of [
        ...crossRealmCapture.pinnedCommitReferences,
        ...localRoots.rootSets.readerPinnedRoots,
      ]) {
        unique.set(referenceIdentity({ reference }), reference);
      }
      let active = true;
      return {
        inspectorPinnedRoots: localRoots.rootSets.inspectorPinnedRoots,
        maintenanceRootEpoch: localRoots.maintenanceRootEpoch,
        readerPinnedRoots: [...unique.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, reference]) => reference),
        release: () => {
          if (!active) return;
          active = false;
          releaseAllNow({ releases: [
            () => localRoots?.release(),
            () => localMaintenance?.release(),
            () => crossRealmCapture.release(),
          ] });
        },
        released: crossRealmCapture.released,
        sourceSegmentPinnedRoots: localRoots.rootSets.sourceSegmentPinnedRoots,
        unknownFeatureRoots: localRoots.rootSets.unknownFeatureRoots,
        workingGenerationDependencyRoots: localRoots.rootSets.workingGenerationDependencyRoots,
        workingGenerationPageRoots: localRoots.rootSets.workingGenerationPageRoots,
      };
    } catch (cause: unknown) {
      try {
        releaseAllNow({ releases: [
          () => localRoots?.release(),
          () => localMaintenance?.release(),
          () => crossRealmCapture.release(),
        ] });
        await crossRealmCapture.released;
      } catch (cleanupCause: unknown) {
        throw new AggregateError([cause, cleanupCause], "maintenance capture and cleanup both failed");
      }
      throw cause;
    }
  }

  acquireInspectorPinnedRoot({ commitReference }: {
    commitReference: HomeRecordReference;
  }): RuntimeMaintenanceRootRegistration {
    return this.maintenanceRoots.acquireInspectorPinnedRoot({
      commitReference,
      coordinationKey: this.scope.key,
    });
  }

  acquireSourceSegmentPinnedRoot({ commitReference }: {
    commitReference: HomeRecordReference;
  }): RuntimeMaintenanceRootRegistration {
    return this.maintenanceRoots.acquireSourceSegmentPinnedRoot({
      commitReference,
      coordinationKey: this.scope.key,
    });
  }

  acquireUnknownFeatureRoot({ commitReference }: {
    commitReference: HomeRecordReference;
  }): RuntimeMaintenanceRootRegistration {
    return this.maintenanceRoots.acquireUnknownFeatureRoot({
      commitReference,
      coordinationKey: this.scope.key,
    });
  }

  acquireWorkingGenerationDependencyRoot({ commitReference }: {
    commitReference: HomeRecordReference;
  }): RuntimeMaintenanceRootRegistration {
    return this.maintenanceRoots.acquireWorkingGenerationDependencyRoot({
      commitReference,
      coordinationKey: this.scope.key,
    });
  }

  acquireWorkingGenerationPageRoot({ pageReference }: {
    pageReference: HomeRecordReference;
  }): import("@/00-storage/service/hizofs/runtime/maintenance-root-registry").RuntimeMaintenancePageRootRegistration {
    return this.maintenanceRoots.acquireWorkingGenerationPageRoot({
      pageReference,
      coordinationKey: this.scope.key,
    });
  }

  async beginSegmentDeletion({ segmentId }: {
    segmentId: SegmentId;
  }): Promise<ActiveSegmentDeletionLease> {
    return await this.activeSegments.beginDeletion({
      coordinationKey: this.scope.key,
      segmentId,
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
