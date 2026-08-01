import {
  encodeBase64UrlUnpadded,
  encodeHomeRecordReference,
  type DirectoryLeafEntry,
  type HomeRecordReference,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import type { ContainerCoordinationKey } from "@/00-storage/service/hizofs/filesystem/container-coordination-key";
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
import { createRuntimePolicy, type HizoFSRuntimePolicy } from "@/00-storage/service/hizofs/runtime/runtime-policy";
import { openRuntimeSessionWithAuthorityHandshake } from "@/00-storage/service/hizofs/runtime/session-open-handshake";
import {
  SessionLifecycle,
  type SessionChildRegistration,
  type SessionLifecycleState,
  type SessionOperationAuthority,
} from "@/00-storage/service/hizofs/runtime/session-lifecycle";


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
  writerDependencyRoots: readonly HomeRecordReference[];
}>;

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
  #active = true;
  #crossRealmPin: CrossRealmReaderPin;
  #localPin: ReaderPin;
  #registration: SessionChildRegistration | undefined;

  constructor({ crossRealmPin, localPin, session, ownedBySession }: {
    crossRealmPin: CrossRealmReaderPin;
    localPin: ReaderPin;
    ownedBySession: boolean;
    session: SessionLifecycle;
  }) {
    this.#crossRealmPin = crossRealmPin;
    this.#localPin = localPin;
    if (ownedBySession) {
      this.#registration = session.registerChild({ child: {
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
    return this.#localPin.commitReference;
  }

  get released(): Promise<void> {
    return Promise.all([this.#localPin.released, this.#crossRealmPin.released]).then(() => undefined);
  }

  release(): void {
    if (!this.#active) return;
    this.#active = false;
    const registration = this.#registration;
    void this.released.then(
      () => registration?.releaseOwnership(),
      () => registration?.releaseOwnership(),
    );
    this.#registration = undefined;
    releaseAllNow({ releases: [
      () => this.#localPin.release(),
      () => this.#crossRealmPin.release(),
    ] });
  }
}

class OwnedSegmentReference {
  #active = true;
  #reference: ActiveSegmentReference;
  #registration: SessionChildRegistration;

  constructor({ reference, session }: {
    reference: ActiveSegmentReference;
    session: SessionLifecycle;
  }) {
    this.#reference = reference;
    this.#registration = session.registerChild({ child: {
      close: async () => this.release(),
      revoke: () => undefined,
    } });
  }

  release(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#reference.release();
    this.#registration.releaseOwnership();
  }
}

export class ContainerRuntimeWriter {
  #active = true;
  #busy = false;
  #closePromise: Promise<void> | undefined;
  #crossRealmWriter: CrossRealmWriterLease;
  #localWriter: RuntimeWriterLease;
  #registration: SessionChildRegistration;
  #revoked = false;
  #session: SessionLifecycle;

  constructor({ crossRealmWriter, localWriter, session }: {
    crossRealmWriter: CrossRealmWriterLease;
    localWriter: RuntimeWriterLease;
    session: SessionLifecycle;
  }) {
    this.#crossRealmWriter = crossRealmWriter;
    this.#localWriter = localWriter;
    this.#session = session;
    this.#registration = session.registerChild({ child: {
      close: async () => await this.#closeOwned(),
      revoke: () => {
        this.#revoked = true;
      },
    } });
  }

  #assertUsable(): void {
    if (!this.#active || this.#revoked) {
      throw new ContainerRuntimeWriterError({
        code: "capability_closed",
        message: "writer capability is closed or revoked by its owner session",
      });
    }
    if (this.#busy) {
      throw new ContainerRuntimeWriterError({
        code: "operation_in_progress",
        message: "writer mutation is already in progress",
      });
    }
  }

  async runPublication<T>({ operation }: {
    operation: ({ authority }: { authority: SessionOperationAuthority }) => Promise<T>;
  }): Promise<T> {
    this.#assertUsable();
    this.#busy = true;
    try {
      return await this.#session.runOperation({ operation: async ({ authority }) => {
        authority.assertPublicationAllowed();
        return await this.#localWriter.runPublication({ operation: async () => {
          return await this.#crossRealmWriter.runPublication({ operation: async () => {
            authority.assertPublicationAllowed();
            return await operation({ authority });
          } });
        } });
      } });
    } finally {
      this.#busy = false;
    }
  }

  async #closeOwned(): Promise<void> {
    if (this.#closePromise !== undefined) return await this.#closePromise;
    if (this.#busy) {
      throw new ContainerRuntimeWriterError({
        code: "operation_in_progress",
        message: "writer cannot release ownership while an operation is active",
      });
    }
    this.#active = false;
    this.#closePromise = (async () => {
      const failures: unknown[] = [];
      try {
        releaseAllNow({ releases: [
          () => this.#localWriter.release(),
          () => this.#crossRealmWriter.release(),
        ] });
      } catch (cause: unknown) {
        failures.push(cause);
      }
      try {
        await this.#crossRealmWriter.released;
      } catch (cause: unknown) {
        failures.push(cause);
      }
      this.#registration.releaseOwnership();
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "writer ownership release failed");
    })();
    return await this.#closePromise;
  }

  async close(): Promise<void> {
    await this.#closeOwned();
  }
}

export class ContainerRuntimeSession {
  #activeSegments: ActiveSegmentRegistry;
  #coordinationKey: ContainerCoordinationKey;
  #crossRealm: CrossRealmLockCoordinator;
  #lifecycle: SessionLifecycle;
  #limits: HizoFSRuntimePolicy;
  #readerPins: ReaderPinRegistry;
  #runtimeCoordination: RuntimeCoordinationRegistry;

  constructor({
    activeSegments,
    coordinationKey,
    crossRealm,
    limits,
    readerPins,
    releaseResources,
    runtimeCoordination,
  }: {
    activeSegments: ActiveSegmentRegistry;
    coordinationKey: ContainerCoordinationKey;
    crossRealm: CrossRealmLockCoordinator;
    limits: HizoFSRuntimePolicy;
    readerPins: ReaderPinRegistry;
    releaseResources: () => Promise<void>;
    runtimeCoordination: RuntimeCoordinationRegistry;
  }) {
    this.#activeSegments = activeSegments;
    this.#coordinationKey = coordinationKey;
    this.#crossRealm = crossRealm;
    this.#limits = limits;
    this.#readerPins = readerPins;
    this.#runtimeCoordination = runtimeCoordination;
    this.#lifecycle = new SessionLifecycle({ releaseResources });
  }

  state(): SessionLifecycleState {
    return this.#lifecycle.state();
  }

  async close(): Promise<void> {
    await this.#lifecycle.close();
  }

  async runReadOperation<T>({ operation }: {
    operation: () => Promise<T>;
  }): Promise<T> {
    return await this.#lifecycle.runOperation({ operation: async () => await operation() });
  }

  async #acquireReaderPin({ commitReference, ownedBySession }: {
    commitReference: HomeRecordReference;
    ownedBySession: boolean;
  }): Promise<OwnedReaderPin> {
    return await this.#lifecycle.runOperation({ operation: async ({ authority }) => {
      const crossRealmPin = await this.#crossRealm.acquireReaderPin({ commitReference });
      let localPin: ReaderPin | undefined;
      try {
        localPin = this.#readerPins.acquire({
          commitReference,
          coordinationKey: this.#coordinationKey,
        });
        authority.assertCapabilityReturnAllowed();
        return new OwnedReaderPin({
          crossRealmPin,
          localPin,
          ownedBySession,
          session: this.#lifecycle,
        });
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

  async acquireReaderPin({ commitReference }: {
    commitReference: HomeRecordReference;
  }): Promise<ContainerRuntimeReaderPin> {
    return await this.#acquireReaderPin({ commitReference, ownedBySession: true });
  }

  async createDirectoryIterator({ entries, generation }: {
    entries: readonly DirectoryLeafEntry[];
    generation: CapturedDirectoryGeneration;
  }): Promise<CapturedDirectoryIterator> {
    const pin = await this.#acquireReaderPin({
      commitReference: generation.commitReference,
      ownedBySession: false,
    });
    try {
      return new CapturedDirectoryIterator({
        entries,
        generation,
        maxEntries: this.#limits.maxDirectoryIteratorEntries,
        pin,
        session: this.#lifecycle,
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
    return await this.#lifecycle.runOperation({ operation: async ({ authority }) => {
      const crossRealmWriter = await this.#crossRealm.acquireWriter();
      let localWriter: RuntimeWriterLease | undefined;
      try {
        localWriter = this.#runtimeCoordination.acquireWriter({
          coordinationKey: this.#coordinationKey,
        });
        authority.assertCapabilityReturnAllowed();
        return new ContainerRuntimeWriter({ crossRealmWriter, localWriter, session: this.#lifecycle });
      } catch (cause: unknown) {
        const acquiredLocalWriter = localWriter;
        const releases = acquiredLocalWriter === undefined
          ? [() => crossRealmWriter.release()]
          : [() => acquiredLocalWriter.release(), () => crossRealmWriter.release()];
        try {
          releaseAllNow({ releases });
          await crossRealmWriter.released;
        } catch (cleanupCause: unknown) {
          throw new AggregateError([cause, cleanupCause], "writer acquisition and cleanup both failed");
        }
        throw cause;
      }
    } });
  }

  async acquireSegmentReference({ kind, segmentId }: {
    kind: ActiveSegmentReferenceKind;
    segmentId: SegmentId;
  }): Promise<Readonly<{ release: () => void }>> {
    return await this.#lifecycle.runOperation({ operation: async ({ authority }) => {
      const reference = this.#activeSegments.acquire({
        coordinationKey: this.#coordinationKey,
        kind,
        segmentId,
      });
      try {
        authority.assertCapabilityReturnAllowed();
        return new OwnedSegmentReference({ reference, session: this.#lifecycle });
      } catch (cause: unknown) {
        reference.release();
        throw cause;
      }
    } });
  }
}

export class ContainerRuntime {
  #activeSegments: ActiveSegmentRegistry;
  #crossRealm: CrossRealmLockCoordinator;
  #limits: HizoFSRuntimePolicy;
  #maintenanceRoots: MaintenanceRootRegistry;
  #readerPins: ReaderPinRegistry;
  #runtimeCoordination = new RuntimeCoordinationRegistry();
  #scope: ContainerCoordinationScope;

  constructor({ crossRealmLockPort, limits, scope }: {
    crossRealmLockPort: CrossRealmLockPort;
    limits: HizoFSRuntimePolicy;
    scope: ContainerCoordinationScope;
  }) {
    const validatedPolicy = createRuntimePolicy(limits);
    this.#activeSegments = new ActiveSegmentRegistry({
      maxReferencesPerContainer: validatedPolicy.maxSegmentReferences,
    });
    this.#crossRealm = new CrossRealmLockCoordinator({
      lockPort: crossRealmLockPort,
      maxHeldLockNames: validatedPolicy.maxHeldLockNames,
      scopeToken: scope.token,
    });
    this.#limits = validatedPolicy;
    this.#maintenanceRoots = new MaintenanceRootRegistry({
      maxRegistrationsPerContainer: validatedPolicy.maxMaintenanceRootRegistrations,
    });
    this.#readerPins = new ReaderPinRegistry({
      maintenanceRoots: this.#maintenanceRoots,
      maxPinsPerContainer: validatedPolicy.maxReaderPins,
    });
    this.#scope = scope;
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
    return await openRuntimeSessionWithAuthorityHandshake({
      captureAuthority,
      coordinator: this.#crossRealm,
      createSession: ({ captured, verified }) => {
        const resources = createSessionResources({ captured, verified });
        const { releaseResources, ...unhandledResources } = resources;
        unhandledResources satisfies Record<PropertyKey, never>;
        return this.#createSession({ releaseResources });
      },
      recheckAuthority,
      verifyCapturedAuthority,
    });
  }

  #createSession({ releaseResources }: {
    releaseResources: () => Promise<void>;
  }): ContainerRuntimeSession {
    return new ContainerRuntimeSession({
      activeSegments: this.#activeSegments,
      coordinationKey: this.#scope.key,
      crossRealm: this.#crossRealm,
      limits: this.#limits,
      readerPins: this.#readerPins,
      releaseResources,
      runtimeCoordination: this.#runtimeCoordination,
    });
  }

  async beginMaintenanceRootCapture(): Promise<ContainerRuntimeMaintenanceRootCapture> {
    const crossRealmCapture = await this.#crossRealm.beginMaintenance();
    let localMaintenance: RuntimeMaintenanceLease | undefined;
    let localRoots: RuntimeMaintenanceRootCapture | undefined;
    try {
      localMaintenance = this.#runtimeCoordination.beginMaintenance({ coordinationKey: this.#scope.key });
      localRoots = this.#maintenanceRoots.captureRoots({ coordinationKey: this.#scope.key });
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
        writerDependencyRoots: localRoots.rootSets.writerDependencyRoots,
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
    return this.#maintenanceRoots.acquireInspectorPinnedRoot({
      commitReference,
      coordinationKey: this.#scope.key,
    });
  }

  acquireSourceSegmentPinnedRoot({ commitReference }: {
    commitReference: HomeRecordReference;
  }): RuntimeMaintenanceRootRegistration {
    return this.#maintenanceRoots.acquireSourceSegmentPinnedRoot({
      commitReference,
      coordinationKey: this.#scope.key,
    });
  }

  acquireUnknownFeatureRoot({ commitReference }: {
    commitReference: HomeRecordReference;
  }): RuntimeMaintenanceRootRegistration {
    return this.#maintenanceRoots.acquireUnknownFeatureRoot({
      commitReference,
      coordinationKey: this.#scope.key,
    });
  }

  acquireWriterDependencyRoot({ commitReference }: {
    commitReference: HomeRecordReference;
  }): RuntimeMaintenanceRootRegistration {
    return this.#maintenanceRoots.acquireWriterDependencyRoot({
      commitReference,
      coordinationKey: this.#scope.key,
    });
  }

  async beginSegmentDeletion({ segmentId }: {
    segmentId: SegmentId;
  }): Promise<ActiveSegmentDeletionLease> {
    return await this.#activeSegments.beginDeletion({
      coordinationKey: this.#scope.key,
      segmentId,
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
