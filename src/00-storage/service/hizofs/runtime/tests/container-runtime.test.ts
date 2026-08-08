import { describe, expect, it, vi } from "vitest";
import {
  createCommitSequence,
  createFeatureBits,
  createFileSystemCommitPayload,
  createHomeRecordReference,
  createInodeNumber,
  createPublicationSequence,
  createSubvolumeId,
  createUInt64,
  createUnlockSequence,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseMutationId,
  parsePublicationId,
  parseSegmentId,
  type OpenedSuperblockCopies,
} from "@/00-storage/service/hizofs/00-format";
import {
  createAuthenticatedApplicationGenerationDescriptor,
  createAuthenticatedDurableApplicationGenerationAuthority,
  createAuthenticatedStagedApplicationGenerationDescriptor,
  requireMaterializedApplicationGenerationDescriptor,
} from "@/00-storage/service/hizofs/runtime/authenticated-application-generation";
import {
  createDurableGenerationIdentity,
  createSuccessorWorkingGenerationIdentity,
  createWorkingGenerationAuthorityEpoch,
  createWorkingGenerationIdentity,
  createWorkingGenerationNumber,
} from "@/00-storage/service/hizofs/runtime/application-generation-identity";
import type { HizoFSBackgroundFlushTimerPort } from "@/00-storage/service/hizofs/runtime/background-flush-scheduler";
import { ContainerRuntime } from "@/00-storage/service/hizofs/runtime/container-runtime";
import { CrossRealmLockCoordinator, type CrossRealmLockMode, type CrossRealmLockPort } from "@/00-storage/service/hizofs/runtime/cross-realm-lock-coordinator";
import { createContainerCoordinationScope, parseContainerCoordinationScopeToken } from "@/00-storage/service/hizofs/runtime/container-coordination-scope";
import { InMemoryCrossRealmLockPort } from "@/00-storage/service/hizofs/runtime/testing/in-memory-cross-realm-lock-port";

import { DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY } from "@/00-storage/service/hizofs/runtime/runtime-policy";
function commitReference({ offset }: { offset: bigint }) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    segmentId: parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 1) }),
  } });
}

function candidateIdentities() {
  const baseReference = commitReference({ offset: 64n });
  const baseMutationId = parseMutationId({ bytes: new Uint8Array(16).fill(1) });
  const baseWorking = createWorkingGenerationIdentity({
    authorityEpoch: createWorkingGenerationAuthorityEpoch(),
    generationNumber: createWorkingGenerationNumber({ value: 0n }),
    mutationId: baseMutationId,
  });
  const successorReference = commitReference({ offset: 160n });
  const successorMutationId = parseMutationId({ bytes: new Uint8Array(16).fill(2) });
  return {
    candidateDurable: createDurableGenerationIdentity({
      commitReference: successorReference,
      commitSequence: createCommitSequence({ value: 8n }),
      mutationId: successorMutationId,
    }),
    durable: createDurableGenerationIdentity({
      commitReference: baseReference,
      commitSequence: createCommitSequence({ value: 7n }),
      mutationId: baseMutationId,
    }),
    successor: createSuccessorWorkingGenerationIdentity({
      mutationId: successorMutationId,
      previous: baseWorking,
    }),
  };
}

const RUNTIME_SCOPE_TOKEN = parseContainerCoordinationScopeToken({ value: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE" });

function runtime({
  backgroundFlushTimerPort,
  crossRealmLockPort = new InMemoryCrossRealmLockPort(),
  maximumAcceptedMutationsPerDirtyEpoch = DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY.maximumAcceptedMutationsPerDirtyEpoch,
}: {
  backgroundFlushTimerPort?: HizoFSBackgroundFlushTimerPort;
  crossRealmLockPort?: CrossRealmLockPort;
  maximumAcceptedMutationsPerDirtyEpoch?: number;
} = {}) {
  return new ContainerRuntime({
    ...(backgroundFlushTimerPort === undefined ? {} : { backgroundFlushTimerPort }),
    crossRealmLockPort,
    limits: {
      lazyDurability: {
        ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
        maximumAcceptedMutationsPerDirtyEpoch,
      },
      maxDirectoryIteratorEntries: 32,
      maxHeldLockNames: 64,
      maxMaintenanceRootRegistrations: 64,
      maxReaderPins: 16,
      maxSegmentReferences: 16,
    },
    scope: createContainerCoordinationScope({
      token: RUNTIME_SCOPE_TOKEN,
    }),
  });
}


function inodeTableReference({ offset }: { offset: bigint }) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 17) }),
  } });
}

function authenticatedGenerationFixture() {
  const commitReferenceValue = commitReference({ offset: 64n });
  const mutationId = parseMutationId({ bytes: new Uint8Array(16).fill(1) });
  const commit = createFileSystemCommitPayload({ payload: {
    commitSequence: createCommitSequence({ value: 7n }),
    mutationId,
    nestedSubvolumeTableRootHomeRef: null,
    nextInodeNumber: createInodeNumber({ value: 2n }),
    nextSubvolumeId: createSubvolumeId({ value: 2n }),
    rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
    rootInodeTableRootHomeRef: inodeTableReference({ offset: 128n }),
  } });
  const logicalState = Object.freeze({
    activeCommitHomeRef: commitReferenceValue,
    activeCommitSequence: commit.commitSequence,
    activeMutationId: mutationId,
    fallbackCommitHomeRef: null,
    minimumUnlockSequence: createUnlockSequence({ value: 1n }),
    relocationIndexRootPhysicalRef: null,
    requiredFeatureBits: createFeatureBits({ value: 0n }),
  });
  const superblock: OpenedSuperblockCopies = Object.freeze({
    authenticatedLogicalStates: Object.freeze([logicalState, logicalState]),
    copyState: "normal",
    historicalRootFeatureState: "supported_or_absent",
    logicalState,
    maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: 1n }),
    selectedCopy: 0,
    selectedPublicationId: parsePublicationId({ bytes: new Uint8Array(16).fill(3) }),
    selectedPublicationSequence: createPublicationSequence({ value: 1n }),
  });
  return createAuthenticatedDurableApplicationGenerationAuthority({
    commit,
    commitReference: commitReferenceValue,
    superblock,
  });
}

function successorDescriptor({ base }: {
  base: ReturnType<ReturnType<ContainerRuntime["attachAuthenticatedApplicationGeneration"]>["capture"]>;
}) {
  const materializedBase = requireMaterializedApplicationGenerationDescriptor({ descriptor: base });
  const successorCommitReference = commitReference({ offset: materializedBase.commitReference.byteOffset + 4_096n });
  const mutationId = parseMutationId({ bytes: new Uint8Array(16).fill(19) });
  const commit = createFileSystemCommitPayload({ payload: {
    ...materializedBase.commit,
    commitSequence: createCommitSequence({ value: materializedBase.commit.commitSequence + 1n }),
    mutationId,
  } });
  const logicalState = Object.freeze({
    ...materializedBase.superblock.logicalState,
    activeCommitHomeRef: successorCommitReference,
    activeCommitSequence: commit.commitSequence,
    activeMutationId: mutationId,
    fallbackCommitHomeRef: materializedBase.durableAuthority.commitReference,
  });
  const superblock: OpenedSuperblockCopies = Object.freeze({
    ...materializedBase.superblock,
    authenticatedLogicalStates: Object.freeze([logicalState, logicalState]),
    logicalState,
  });
  return createAuthenticatedApplicationGenerationDescriptor({
    commit,
    commitReference: successorCommitReference,
    durableAuthority: createAuthenticatedDurableApplicationGenerationAuthority({
      commit,
      commitReference: successorCommitReference,
      superblock,
    }),
    workingIdentity: createSuccessorWorkingGenerationIdentity({
      mutationId,
      previous: materializedBase.workingIdentity,
    }),
  });
}


function unpublishedSuccessorDescriptor({ base, mutationByte, offset }: {
  base: ReturnType<ReturnType<ContainerRuntime["attachAuthenticatedApplicationGeneration"]>["capture"]>;
  mutationByte: number;
  offset: bigint;
}) {
  const materializedBase = requireMaterializedApplicationGenerationDescriptor({ descriptor: base });
  const successorCommitReference = commitReference({ offset });
  const mutationId = parseMutationId({ bytes: new Uint8Array(16).fill(mutationByte) });
  const commit = createFileSystemCommitPayload({ payload: {
    ...materializedBase.commit,
    commitSequence: createCommitSequence({ value: materializedBase.durableAuthority.commit.commitSequence + 1n }),
    mutationId,
  } });
  return createAuthenticatedApplicationGenerationDescriptor({
    commit,
    commitReference: successorCommitReference,
    durableAuthority: materializedBase.durableAuthority,
    workingIdentity: createSuccessorWorkingGenerationIdentity({
      mutationId,
      previous: materializedBase.workingIdentity,
    }),
  });
}

function stagedSuccessorDescriptor({ base, mutationByte }: {
  base: ReturnType<ReturnType<ContainerRuntime["attachAuthenticatedApplicationGeneration"]>["capture"]>;
  mutationByte: number;
}) {
  const materializedBase = requireMaterializedApplicationGenerationDescriptor({ descriptor: base });
  const mutationId = parseMutationId({ bytes: new Uint8Array(16).fill(mutationByte) });
  const commit = createFileSystemCommitPayload({ payload: {
    ...materializedBase.commit,
    commitSequence: createCommitSequence({ value: materializedBase.durableAuthority.commit.commitSequence + 1n }),
    mutationId,
    rootInodeTableRootHomeRef: inodeTableReference({ offset: 320n + (BigInt(mutationByte) * 8n) }),
  } });
  return createAuthenticatedStagedApplicationGenerationDescriptor({
    commit,
    durableAuthority: materializedBase.durableAuthority,
    workingIdentity: createSuccessorWorkingGenerationIdentity({
      mutationId,
      previous: materializedBase.workingIdentity,
    }),
  });
}

function publishedDescriptorFromStaged({ commitReference: materializedCommitReference, staged }: {
  commitReference: ReturnType<typeof commitReference>;
  staged: ReturnType<typeof stagedSuccessorDescriptor>;
}) {
  const logicalState = Object.freeze({
    ...staged.superblock.logicalState,
    activeCommitHomeRef: materializedCommitReference,
    activeCommitSequence: staged.commit.commitSequence,
    activeMutationId: staged.commit.mutationId,
    fallbackCommitHomeRef: staged.durableAuthority.commitReference,
  });
  const superblock: OpenedSuperblockCopies = Object.freeze({
    ...staged.superblock,
    authenticatedLogicalStates: Object.freeze([logicalState, logicalState]),
    logicalState,
  });
  return createAuthenticatedApplicationGenerationDescriptor({
    commit: staged.commit,
    commitReference: materializedCommitReference,
    durableAuthority: createAuthenticatedDurableApplicationGenerationAuthority({
      commit: staged.commit,
      commitReference: materializedCommitReference,
      superblock,
    }),
    workingIdentity: staged.workingIdentity,
  });
}

function publishedDescriptorFromWorking({ working }: {
  working: ReturnType<typeof unpublishedSuccessorDescriptor>;
}) {
  const logicalState = Object.freeze({
    ...working.superblock.logicalState,
    activeCommitHomeRef: working.commitReference,
    activeCommitSequence: working.commit.commitSequence,
    activeMutationId: working.commit.mutationId,
    fallbackCommitHomeRef: working.durableAuthority.commitReference,
  });
  const superblock: OpenedSuperblockCopies = Object.freeze({
    ...working.superblock,
    authenticatedLogicalStates: Object.freeze([logicalState, logicalState]),
    logicalState,
  });
  return createAuthenticatedApplicationGenerationDescriptor({
    commit: working.commit,
    commitReference: working.commitReference,
    durableAuthority: createAuthenticatedDurableApplicationGenerationAuthority({
      commit: working.commit,
      commitReference: working.commitReference,
      superblock,
    }),
    workingIdentity: working.workingIdentity,
  });
}

class DelayedReaderPinReleasePort implements CrossRealmLockPort {
  private completion = Promise.withResolvers<void>();
  private inner = new InMemoryCrossRealmLockPort();

  async acquire({ mode, name }: {
    mode: CrossRealmLockMode;
    name: string;
  }) {
    const lease = await this.inner.acquire({ mode, name });
    if (!name.includes("/reader-pin/")) return lease;
    return {
      release: () => lease.release(),
      released: Promise.all([lease.released, this.completion.promise]).then(() => undefined),
    };
  }

  completeReaderPinRelease(): void {
    this.completion.resolve();
  }

  async queryHeldLockNames(): Promise<readonly string[]> {
    return await this.inner.queryHeldLockNames();
  }
}

async function openSession({ value }: { value: ContainerRuntime }) {
  return await value.openSessionWithAuthorityHandshake({
    captureAuthority: async () => ({ revision: 1 }),
    createSessionResources: () => ({ releaseResources: async () => undefined }),
    recheckAuthority: async () => undefined,
    verifyCapturedAuthority: async () => "verified",
  });
}


async function tryOpenSession({ value }: { value: ContainerRuntime }) {
  return await value.tryOpenSessionWithAuthorityHandshake({
    captureAuthority: async () => ({ revision: 1 }),
    createSessionResources: () => ({ releaseResources: async () => undefined }),
    recheckAuthority: async () => undefined,
    verifyCapturedAuthority: async () => "verified",
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function controlledBackgroundFlushTimers() {
  const scheduled: Array<{
    callback: () => void;
    cancelled: boolean;
    delayMilliseconds: number;
  }> = [];
  const port: HizoFSBackgroundFlushTimerPort = {
    schedule: ({ callback, delayMilliseconds }) => {
      const entry = { callback, cancelled: false, delayMilliseconds };
      scheduled.push(entry);
      return { cancel: () => {
        entry.cancelled = true;
      } };
    },
  };
  return { port, scheduled };
}

describe("container runtime", () => {

  it("owns one authenticated generation authority across runtime attachments", async () => {
    const value = runtime();
    const durableAuthority = authenticatedGenerationFixture();
    const first = value.attachAuthenticatedApplicationGeneration({ durableAuthority });
    const second = value.attachAuthenticatedApplicationGeneration({ durableAuthority });
    const base = requireMaterializedApplicationGenerationDescriptor({ descriptor: first.capture() });
    expect(second.capture()).toBe(base);

    const admission = first.openImmediateMutationAdmission({
      dirtyMetadataBytes: 0,
      expectedBase: base,
      unpublishedPhysicalBytes: 0,
    });
    const successor = successorDescriptor({ base });
    const working = createAuthenticatedApplicationGenerationDescriptor({
      commit: successor.commit,
      commitReference: successor.commitReference,
      durableAuthority: base.durableAuthority,
      workingIdentity: successor.workingIdentity,
    });
    admission.installSelectedCandidate({ candidate: Object.freeze({}), successor: working });
    admission.selectCandidateForPublication();
    admission.commitDurableSuccessor({ successor });
    admission.releasePublishedCandidate();

    expect(first.capture()).toBe(successor);
    expect(second.capture()).toBe(successor);
    const firstFlush = first.requestExplicitFlush();
    const secondFlush = second.requestExplicitFlush();
    expect(secondFlush).toBe(firstFlush);
    await expect(firstFlush).resolves.toBeUndefined();
    await expect(first.waitForSyncTarget({ target: successor.workingIdentity })).resolves.toBeUndefined();
    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({ status: "disposed" });
  });


  it("owns immediate mutation candidate selection in the runtime admission", async () => {
    const value = runtime();
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = requireMaterializedApplicationGenerationDescriptor({ descriptor: authority.capture() });
    const candidate = Object.freeze({ label: "immediate candidate" });
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 29, offset: 36_928n });
    const admission = authority.openImmediateMutationAdmission<typeof candidate>({
      dirtyMetadataBytes: 0,
      expectedBase: base,
      unpublishedPhysicalBytes: 0,
    });

    admission.installSelectedCandidate({ candidate, successor: working });
    expect(admission.selectCandidateForPublication()).toBe(candidate);
    expect(value.workingCandidatePublicationState()).toBe("publishing");

    const published = publishedDescriptorFromWorking({ working });
    admission.commitDurableSuccessor({ successor: published });
    expect(authority.capture()).toBe(published);
    expect(value.workingCandidatePublicationState()).toBe("publishing");
    admission.releasePublishedCandidate();
    expect(value.workingCandidatePublicationState()).toBe("empty");
    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({ status: "disposed" });
  });

  it("rolls back or retains an immediate runtime candidate with its generation admission", async () => {
    const discardedRuntime = runtime();
    const discardedAuthority = discardedRuntime.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const discardedBase = requireMaterializedApplicationGenerationDescriptor({ descriptor: discardedAuthority.capture() });
    const discardedAdmission = discardedAuthority.openImmediateMutationAdmission<object>({
      dirtyMetadataBytes: 1,
      expectedBase: discardedBase,
      unpublishedPhysicalBytes: 1,
    });
    discardedAdmission.installSelectedCandidate({
      candidate: Object.freeze({}),
      successor: unpublishedSuccessorDescriptor({ base: discardedBase, mutationByte: 30, offset: 41_024n }),
    });
    discardedAdmission.rollback();
    expect(discardedAuthority.capture()).toBe(discardedBase);
    expect(discardedRuntime.workingCandidatePublicationState()).toBe("empty");
    await expect(discardedRuntime.disposeIfIdleAndSafe()).resolves.toEqual({ status: "disposed" });

    const retainedRuntime = runtime();
    const retainedAuthority = retainedRuntime.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const retainedBase = requireMaterializedApplicationGenerationDescriptor({ descriptor: retainedAuthority.capture() });
    const retainedAdmission = retainedAuthority.openImmediateMutationAdmission<object>({
      dirtyMetadataBytes: 1,
      expectedBase: retainedBase,
      unpublishedPhysicalBytes: 1,
    });
    retainedAdmission.installSelectedCandidate({
      candidate: Object.freeze({}),
      successor: unpublishedSuccessorDescriptor({ base: retainedBase, mutationByte: 31, offset: 45_120n }),
    });
    retainedAdmission.selectCandidateForPublication();
    retainedAdmission.retainSelectedCandidateOutcomeUnknown({ cause: new Error("publication unresolved") });
    expect(retainedAuthority.capture()).toBe(retainedBase);
    expect(retainedRuntime.workingCandidatePublicationState()).toBe("outcome_unknown");
    await expect(retainedRuntime.disposeIfIdleAndSafe()).resolves.toEqual({
      blocker: "working_candidate_not_empty",
      status: "retained",
    });
  });

  it("transfers exact measured resources through runtime admission before commit", () => {
    const value = runtime();
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = requireMaterializedApplicationGenerationDescriptor({ descriptor: authority.capture() });
    const admission = authority.openImmediateMutationAdmission({
      dirtyMetadataBytes: 0,
      expectedBase: base,
      unpublishedPhysicalBytes: 0,
    });

    admission.replaceResourceReservation({
      dirtyMetadataBytes: 123,
      unpublishedPhysicalBytes: 456,
    });
    expect(value.lazyDurabilityDiagnostics()).toMatchObject({
      dirtyMetadataBytes: 123,
      mutationAdmissionActive: true,
      unpublishedPhysicalBytes: 456,
    });

    admission.rollback();
    expect(value.lazyDurabilityDiagnostics()).toMatchObject({
      dirtyMetadataBytes: 0,
      mutationAdmissionActive: false,
      unpublishedPhysicalBytes: 0,
    });
  });

  it("reports bounded lazy-durability state without exposing persisted authority identifiers", async () => {
    const { port } = controlledBackgroundFlushTimers();
    const value = runtime({ backgroundFlushTimerPort: port });
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
      writableProfile: "release-qualified",
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 27, offset: 32_832n });
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 123,
      expectedBase: base,
      unpublishedPhysicalBytes: 456,
    });
    admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => ({
          durableSuccessor: publishedDescriptorFromWorking({ working }),
          type: "published" as const,
        }),
      }),
      successor: working,
    });

    expect(value.lazyDurabilityDiagnostics()).toMatchObject({
      acceptedGeneration: "1",
      appliedPublicationMode: "lazy_publication_development",
      candidatePublicationState: "installed",
      dirtyMetadataBytes: 123,
      dirtyMutationCount: 1,
      durableGeneration: "0",
      flushState: "idle",
      mutationAdmissionActive: false,
      lazyPublicationRollout: {
        developmentActivationQualified: true,
        missingDevelopmentActivationGates: [],
        missingReleaseQualificationGates: [
          "fault_campaign",
        ],
        releaseQualified: false,
      },
      requestedPublicationMode: "automatic",
      syncWaiters: 0,
      unpublishedPhysicalBytes: 456,
    });
    await authority.requestExplicitFlush();
    expect(value.lazyDurabilityDiagnostics()).toMatchObject({
      acceptedGeneration: "1",
      candidatePublicationState: "empty",
      dirtyMetadataBytes: 0,
      dirtyMutationCount: 0,
      durableGeneration: "1",
      unpublishedPhysicalBytes: 0,
    });
  });

  it("publishes only the latest accepted runtime candidate during explicit flush", async () => {
    const value = runtime();
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const first = unpublishedSuccessorDescriptor({ base, mutationByte: 20, offset: 4_160n });
    let firstPublicationCount = 0;
    const abandonFirstPublication = vi.fn();
    const firstAdmission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 128,
      expectedBase: base,
      unpublishedPhysicalBytes: 256,
    });
    firstAdmission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: abandonFirstPublication,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => {
          firstPublicationCount += 1;
          return { durableSuccessor: publishedDescriptorFromWorking({ working: first }), type: "published" as const };
        },
      }),
      successor: first,
    });

    const second = unpublishedSuccessorDescriptor({
      base: first,
      mutationByte: 21,
      offset: 8_256n,
    });
    let secondPublicationCount = 0;
    const abandonSecondPublication = vi.fn();
    const completeSecondPublication = vi.fn();
    const secondAdmission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 64,
      expectedBase: first,
      unpublishedPhysicalBytes: 96,
    });
    secondAdmission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: abandonSecondPublication,
        completeOutcomeUnknownResolution: completeSecondPublication,
        publish: async () => {
          secondPublicationCount += 1;
          return { durableSuccessor: publishedDescriptorFromWorking({ working: second }), type: "published" as const };
        },
      }),
      successor: second,
    });

    expect(authority.capture()).toBe(second);
    const waiter = authority.waitForSyncTarget({ target: second.workingIdentity });
    let resolved = false;
    void waiter.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    await authority.requestExplicitFlush();
    await waiter;
    expect(firstPublicationCount).toBe(0);
    expect(secondPublicationCount).toBe(1);
    expect(abandonFirstPublication).toHaveBeenCalledOnce();
    expect(abandonSecondPublication).not.toHaveBeenCalled();
    expect(completeSecondPublication).toHaveBeenCalledOnce();
    expect(completeSecondPublication).toHaveBeenCalledWith({ outcome: "confirmed_published" });
    expect(authority.capture().durableAuthority.identity).toEqual(
      publishedDescriptorFromWorking({ working: second }).durableAuthority.identity,
    );
    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({ status: "disposed" });
  });

  it("publishes the retained latest candidate when the coordinator-owned dirty-age timer fires", async () => {
    const { port, scheduled } = controlledBackgroundFlushTimers();
    const value = runtime({ backgroundFlushTimerPort: port });
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 25, offset: 24_640n });
    let publicationCount = 0;
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => {
          publicationCount += 1;
          return { durableSuccessor: publishedDescriptorFromWorking({ working }), type: "published" as const };
        },
      }),
      successor: working,
    });

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      cancelled: false,
      delayMilliseconds: DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY.maximumDirtyAgeMilliseconds,
    });
    const durable = authority.waitForSyncTarget({ target: working.workingIdentity });
    scheduled[0]!.callback();
    await durable;
    expect(publicationCount).toBe(1);
    expect(authority.capture().durableAuthority.identity).toEqual(
      publishedDescriptorFromWorking({ working }).durableAuthority.identity,
    );
  });

  it("queues resource-pressure publication before the next foreground writer", async () => {
    const { port, scheduled } = controlledBackgroundFlushTimers();
    const value = runtime({
      backgroundFlushTimerPort: port,
      maximumAcceptedMutationsPerDirtyEpoch: 1,
    });
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 24, offset: 23_616n });
    const publicationStarted = deferred<void>();
    const finishPublication = deferred<void>();
    const session = await openSession({ value });
    const currentWriter = await session.acquireWriter();
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });

    // Queue the next foreground writer *before* resource pressure is observed.
    // The runtime must still yield that already-queued writer to publication
    // after it acquires the lock; relying only on FIFO enqueue order would let
    // this writer overtake the dirty-epoch boundary.
    let nextWriterAcquired = false;
    const nextWriterPromise = session.acquireWriter().then(writer => {
      nextWriterAcquired = true;
      return writer;
    });
    await Promise.resolve();

    admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => {
          publicationStarted.resolve();
          await finishPublication.promise;
          return { durableSuccessor: publishedDescriptorFromWorking({ working }), type: "published" as const };
        },
      }),
      successor: working,
    });

    // Resource pressure is an admission boundary, so it must start publication
    // immediately rather than depending on a zero-delay timer task.
    expect(scheduled).toHaveLength(0);
    expect(value.lazyDurabilityDiagnostics()).toMatchObject({
      backgroundFlush: { backgroundFlushInFlight: true },
      dirtyMutationCount: 1,
    });

    await currentWriter.close();
    await publicationStarted.promise;
    await new Promise(resolve => globalThis.setTimeout(resolve, 0));
    expect(nextWriterAcquired).toBe(false);

    finishPublication.resolve();
    const nextWriter = await nextWriterPromise;
    expect(nextWriterAcquired).toBe(true);
    expect(value.lazyDurabilityDiagnostics().dirtyMutationCount).toBe(0);
    const refreshed = authority.capture();
    const nextAdmission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: refreshed,
      unpublishedPhysicalBytes: 1,
    });
    nextAdmission.rollback();
    await nextWriter.close();
    await session.close();
  });

  it("serializes background publication behind foreground runtime writer ownership", async () => {
    const { port, scheduled } = controlledBackgroundFlushTimers();
    const value = runtime({ backgroundFlushTimerPort: port });
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 25, offset: 24_640n });
    let publicationCount = 0;
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => {
          publicationCount += 1;
          return { durableSuccessor: publishedDescriptorFromWorking({ working }), type: "published" as const };
        },
      }),
      successor: working,
    });

    const session = await openSession({ value });
    const writer = await session.acquireWriter();
    scheduled[0]!.callback();
    await new Promise(resolve => globalThis.setTimeout(resolve, 0));
    expect(publicationCount).toBe(0);

    await writer.close();
    await new Promise(resolve => globalThis.setTimeout(resolve, 0));
    expect(publicationCount).toBe(1);
    await session.close();
  });

  it("blocks the next foreground runtime writer while background publication owns writer authority", async () => {
    const { port, scheduled } = controlledBackgroundFlushTimers();
    const value = runtime({ backgroundFlushTimerPort: port });
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 27, offset: 26_624n });
    const publicationStarted = deferred<void>();
    const finishPublication = deferred<void>();
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => {
          publicationStarted.resolve();
          await finishPublication.promise;
          return { durableSuccessor: publishedDescriptorFromWorking({ working }), type: "published" as const };
        },
      }),
      successor: working,
    });

    const session = await openSession({ value });
    scheduled[0]!.callback();
    await publicationStarted.promise;
    let foregroundWriterAcquired = false;
    const foregroundWriter = session.acquireWriter().then(writer => {
      foregroundWriterAcquired = true;
      return writer;
    });
    await new Promise(resolve => globalThis.setTimeout(resolve, 0));
    expect(foregroundWriterAcquired).toBe(false);

    finishPublication.resolve();
    const writer = await foregroundWriter;
    expect(foregroundWriterAcquired).toBe(true);
    await writer.close();
    await session.close();
  });

  it("serializes explicit flush behind foreground runtime writer ownership", async () => {
    const value = runtime();
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 28, offset: 30_720n });
    let publicationCount = 0;
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => {
          publicationCount += 1;
          return { durableSuccessor: publishedDescriptorFromWorking({ working }), type: "published" as const };
        },
      }),
      successor: working,
    });

    const session = await openSession({ value });
    const writer = await session.acquireWriter();
    const flush = authority.requestExplicitFlush();
    await new Promise(resolve => globalThis.setTimeout(resolve, 0));
    expect(publicationCount).toBe(0);

    await writer.close();
    await flush;
    expect(publicationCount).toBe(1);
    await session.close();
  });

  it("blocks the next foreground runtime writer while explicit flush owns writer authority", async () => {
    const value = runtime();
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 29, offset: 32_704n });
    const publicationStarted = deferred<void>();
    const finishPublication = deferred<void>();
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => {
          publicationStarted.resolve();
          await finishPublication.promise;
          return { durableSuccessor: publishedDescriptorFromWorking({ working }), type: "published" as const };
        },
      }),
      successor: working,
    });

    const session = await openSession({ value });
    const flush = authority.requestExplicitFlush();
    await publicationStarted.promise;
    let foregroundWriterAcquired = false;
    const foregroundWriter = session.acquireWriter().then(writer => {
      foregroundWriterAcquired = true;
      return writer;
    });
    await new Promise(resolve => globalThis.setTimeout(resolve, 0));
    expect(foregroundWriterAcquired).toBe(false);

    finishPublication.resolve();
    await flush;
    const writer = await foregroundWriter;
    expect(foregroundWriterAcquired).toBe(true);
    await writer.close();
    await session.close();
  });

  it("defers background publication while a foreground mutation admission owns generation authority", async () => {
    const { port, scheduled } = controlledBackgroundFlushTimers();
    const value = runtime({ backgroundFlushTimerPort: port });
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 26, offset: 28_736n });
    let publicationCount = 0;
    const first = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    first.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => {
          publicationCount += 1;
          return { durableSuccessor: publishedDescriptorFromWorking({ working }), type: "published" as const };
        },
      }),
      successor: working,
    });
    const foreground = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: working,
      unpublishedPhysicalBytes: 1,
    });

    scheduled[0]!.callback();
    await new Promise(resolve => globalThis.setTimeout(resolve, 0));
    expect(publicationCount).toBe(0);
    expect(scheduled).toHaveLength(1);

    foreground.rollback();
    await new Promise(resolve => globalThis.setTimeout(resolve, 0));
    expect(scheduled).toHaveLength(2);
    const durable = authority.waitForSyncTarget({ target: working.workingIdentity });
    scheduled[1]!.callback();
    await durable;
    expect(publicationCount).toBe(1);
  });

  it("keeps an accepted candidate and stalls durability when background timer scheduling fails", async () => {
    const schedulingFailure = new Error("background timer scheduling failed");
    const value = runtime({
      backgroundFlushTimerPort: {
        schedule: () => {
          throw schedulingFailure;
        },
      },
    });
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 24, offset: 20_544n });
    let publicationCount = 0;
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });

    expect(() => admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => {
          publicationCount += 1;
          return { durableSuccessor: publishedDescriptorFromWorking({ working }), type: "published" as const };
        },
      }),
      successor: working,
    })).toThrow(schedulingFailure);
    expect(authority.capture()).toBe(working);
    expect(value.workingCandidatePublicationState()).toBe("installed");
    expect(() => authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: working,
      unpublishedPhysicalBytes: 1,
    })).toThrowError(expect.objectContaining({ code: "durability_stalled" }));

    await expect(authority.requestExplicitFlush()).resolves.toBeUndefined();
    expect(publicationCount).toBe(1);
    await expect(authority.waitForSyncTarget({ target: working.workingIdentity })).resolves.toBeUndefined();
  });

  it("keeps a staged accepted generation commitless until flush materializes its exact candidate", async () => {
    const value = runtime();
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const staged = stagedSuccessorDescriptor({ base, mutationByte: 42 });
    const materializedCommitReference = commitReference({ offset: 88_128n });
    const published = publishedDescriptorFromStaged({
      commitReference: materializedCommitReference,
      staged,
    });
    const materializationCallbacks: unknown[] = [];
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    admission.reserveStagedCommitMaterializationHeadroom({ bytes: 5 });
    admission.commitAcceptedStagedSuccessor({
      publisher: Object.freeze({
        abandon: vi.fn(),
        completeOutcomeUnknownResolution: vi.fn(),
        publish: async ({ onCandidateMaterialized, onMaterializationAppendAttempt }) => {
          const materializationAttempt = onMaterializationAppendAttempt({ frameBytes: 5 });
          const candidateDurableIdentity = createDurableGenerationIdentity({
            commitReference: materializedCommitReference,
            commitSequence: staged.commit.commitSequence,
            mutationId: staged.commit.mutationId,
          });
          onCandidateMaterialized({ candidateDurableIdentity });
          materializationAttempt.completeReusableCandidate();
          materializationCallbacks.push(candidateDurableIdentity);
          return { durableSuccessor: published, type: "published" as const };
        },
      }),
      successor: staged,
    });

    expect(value.lazyDurabilityDiagnostics()).toMatchObject({
      dirtyMetadataBytes: 6,
      stagedCommitMaterializationHeadroomBytes: 5,
      unpublishedPhysicalBytes: 6,
    });
    const accepted = authority.capture();
    expect("commitReference" in accepted).toBe(false);
    expect(accepted.workingRootAuthority).toEqual(staged.workingRootAuthority);
    expect(materializationCallbacks).toEqual([]);

    await expect(authority.requestExplicitFlush()).resolves.toBeUndefined();
    expect(materializationCallbacks).toHaveLength(1);
    const durable = requireMaterializedApplicationGenerationDescriptor({ descriptor: authority.capture() });
    expect(durable.commitReference).toEqual(materializedCommitReference);
    expect(durable.workingIdentity).toEqual(staged.workingIdentity);
    expect(value.lazyDurabilityDiagnostics()).toMatchObject({
      dirtyMetadataBytes: 0,
      stagedCommitMaterializationHeadroomBytes: 0,
      unpublishedPhysicalBytes: 0,
    });
  });

  it("retains materialized Commit and staged page roots when staged publication becomes outcome-unknown", async () => {
    const value = runtime();
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const staged = stagedSuccessorDescriptor({ base, mutationByte: 43 });
    const materializedCommitReference = commitReference({ offset: 88_224n });
    const failure = new Error("staged Superblock publication outcome is unknown");
    const completeOutcomeUnknownResolution = vi.fn();
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    admission.commitAcceptedStagedSuccessor({
      publisher: Object.freeze({
        abandon: vi.fn(),
        completeOutcomeUnknownResolution,
        publish: async ({ onCandidateMaterialized }) => {
          onCandidateMaterialized({
            candidateDurableIdentity: createDurableGenerationIdentity({
              commitReference: materializedCommitReference,
              commitSequence: staged.commit.commitSequence,
              mutationId: staged.commit.mutationId,
            }),
          });
          return { cause: failure, type: "outcome_unknown" as const };
        },
      }),
      successor: staged,
    });

    await expect(authority.requestExplicitFlush()).rejects.toBe(failure);
    expect(value.workingCandidatePublicationState()).toBe("outcome_unknown");
    const capture = await value.beginMaintenanceRootCapture();
    try {
      expect(capture.writerDependencyRoots).toEqual([materializedCommitReference]);
      expect(capture.writerWorkingPageRoots).toEqual([
        staged.workingRootAuthority.rootInodeTableRootHomeRef,
      ]);
    } finally {
      capture.release();
      await capture.released;
    }
    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({
      blocker: "working_candidate_not_empty",
      status: "retained",
    });
    await expect(authority.requestExplicitFlush()).rejects.toMatchObject({ code: "coordinator_poisoned" });
    expect(completeOutcomeUnknownResolution).not.toHaveBeenCalled();
  });

  it("retains a not-published candidate for an explicit single-flight retry", async () => {
    const value = runtime();
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 22, offset: 12_352n });
    const failure = new Error("first publication did not cross the commit point");
    let attempt = 0;
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => {
          attempt += 1;
          if (attempt === 1) {
            return {
              cause: failure,
              refreshedDurableAuthority: base.durableAuthority,
              type: "not_published" as const,
            };
          }
          return { durableSuccessor: publishedDescriptorFromWorking({ working }), type: "published" as const };
        },
      }),
      successor: working,
    });

    await expect(authority.requestExplicitFlush()).rejects.toBe(failure);
    expect(authority.capture().workingIdentity).toEqual(working.workingIdentity);
    await expect(authority.requestExplicitFlush()).resolves.toBeUndefined();
    expect(attempt).toBe(2);
    await expect(authority.waitForSyncTarget({ target: working.workingIdentity })).resolves.toBeUndefined();
  });

  it("retains an outcome-unknown selected candidate and fails closed", async () => {
    const value = runtime();
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 23, offset: 16_448n });
    const failure = new Error("publication authority could not be resolved");
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => ({ cause: failure, type: "outcome_unknown" as const }),
      }),
      successor: working,
    });

    await expect(authority.requestExplicitFlush()).rejects.toBe(failure);
    await expect(authority.requestExplicitFlush()).rejects.toMatchObject({ code: "coordinator_poisoned" });
    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({
      blocker: "working_candidate_not_empty",
      status: "retained",
    });
  });

  it("waits for foreground writer ownership before fencing a management clean-head flush", async () => {
    const value = runtime();
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 34, offset: 63_616n });
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => ({
          durableSuccessor: publishedDescriptorFromWorking({ working }),
          type: "published" as const,
        }),
      }),
      successor: working,
    });

    const session = await openSession({ value });
    const writer = await session.acquireWriter();
    const barrier = authority.openManagementCleanHeadBarrier({});
    let settled = false;
    const settlement = barrier.flushAndCaptureCleanGeneration().then(descriptor => {
      settled = true;
      return descriptor;
    });
    await new Promise(resolve => globalThis.setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(value.lazyDurabilityDiagnostics().managementBarrierActive).toBe(false);

    await writer.close();
    await expect(settlement).resolves.toMatchObject({ workingIdentity: working.workingIdentity });
    expect(value.lazyDurabilityDiagnostics().managementBarrierActive).toBe(true);
    barrier.release();
    await session.close();
  });

  it("holds a clean durable head across a management authority switch", async () => {
    const value = runtime();
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 35, offset: 65_600n });
    let publicationAttempts = 0;
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => {
          publicationAttempts += 1;
          return { durableSuccessor: publishedDescriptorFromWorking({ working }), type: "published" as const };
        },
      }),
      successor: working,
    });

    const barrier = authority.openManagementCleanHeadBarrier({});
    expect(value.lazyDurabilityDiagnostics().managementBarrierActive).toBe(false);

    await expect(barrier.flushAndCaptureCleanGeneration()).resolves.toMatchObject({
      workingIdentity: working.workingIdentity,
    });
    expect(value.lazyDurabilityDiagnostics().managementBarrierActive).toBe(true);
    const cleanHead = authority.capture();
    expect(() => authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: cleanHead,
      unpublishedPhysicalBytes: 1,
    })).toThrowError(expect.objectContaining({ code: "management_barrier_active" }));
    await expect(authority.requestExplicitFlush()).rejects.toMatchObject({ code: "management_barrier_active" });
    expect(authority.refreshDurableAuthority({
      durableAuthority: authority.capture().durableAuthority,
      expectedWorkingIdentity: working.workingIdentity,
    }).workingIdentity).toEqual(working.workingIdentity);
    expect(publicationAttempts).toBe(1);
    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({
      blocker: "management_barrier_active",
      status: "retained",
    });

    barrier.release();
    expect(value.lazyDurabilityDiagnostics().managementBarrierActive).toBe(false);
    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({ status: "disposed" });
  });

  it("publishes the working head before active-head maintenance captures roots", async () => {
    const value = runtime();
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 37, offset: 73_792n });
    let publicationAttempts = 0;
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => {
          publicationAttempts += 1;
          return { durableSuccessor: publishedDescriptorFromWorking({ working }), type: "published" as const };
        },
      }),
      successor: working,
    });

    const capture = await value.beginCleanHeadMaintenanceRootCapture();
    expect(publicationAttempts).toBe(1);
    expect(authority.capture().durableAuthority.commitReference).toEqual(working.commitReference);
    expect(capture.writerDependencyRoots).toEqual([]);
    expect(() => authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: requireMaterializedApplicationGenerationDescriptor({ descriptor: authority.capture() }),
      unpublishedPhysicalBytes: 1,
    })).toThrowError(expect.objectContaining({ code: "management_barrier_active" }));

    capture.release();
    await capture.released;
    const nextAdmission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: requireMaterializedApplicationGenerationDescriptor({ descriptor: authority.capture() }),
      unpublishedPhysicalBytes: 1,
    });
    nextAdmission.rollback();
  });

  it("fails closed when active-head maintenance cannot publish the working head", async () => {
    const value = runtime();
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 38, offset: 77_888n });
    const failure = new Error("maintenance clean-head publication failed");
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => ({
          cause: failure,
          refreshedDurableAuthority: base.durableAuthority,
          type: "not_published" as const,
        }),
      }),
      successor: working,
    });

    await expect(value.beginCleanHeadMaintenanceRootCapture()).rejects.toBeInstanceOf(AggregateError);
    expect(value.lazyDurabilityDiagnostics().managementBarrierActive).toBe(true);
    const cleanHead = authority.capture();
    expect(() => authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: cleanHead,
      unpublishedPhysicalBytes: 1,
    })).toThrowError(expect.objectContaining({ code: "management_barrier_active" }));
  });

  it("keeps the management barrier after a not-published flush until retry succeeds", async () => {
    const value = runtime();
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 36, offset: 69_696n });
    const failure = new Error("management flush did not publish");
    let publicationAttempts = 0;
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => {
          publicationAttempts += 1;
          if (publicationAttempts === 1) {
            return {
              cause: failure,
              refreshedDurableAuthority: base.durableAuthority,
              type: "not_published" as const,
            };
          }
          return { durableSuccessor: publishedDescriptorFromWorking({ working }), type: "published" as const };
        },
      }),
      successor: working,
    });

    const barrier = authority.openManagementCleanHeadBarrier({});
    await expect(barrier.flushAndCaptureCleanGeneration()).rejects.toBe(failure);
    expect(() => barrier.release()).toThrowError(expect.objectContaining({ code: "management_head_not_clean" }));
    await expect(barrier.flushAndCaptureCleanGeneration()).resolves.toMatchObject({
      workingIdentity: working.workingIdentity,
    });
    barrier.release();
    expect(publicationAttempts).toBe(2);
  });

  it("flushes the retained selected candidate before graceful host disposal", async () => {
    const value = runtime();
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 32, offset: 49_216n });
    let publicationAttempts = 0;
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => {
          publicationAttempts += 1;
          return { durableSuccessor: publishedDescriptorFromWorking({ working }), type: "published" as const };
        },
      }),
      successor: working,
    });

    await expect(value.flushAndDisposeIfIdleAndSafe()).resolves.toEqual({ status: "disposed" });
    expect(publicationAttempts).toBe(1);
    await expect(openSession({ value })).rejects.toMatchObject({ code: "runtime_host_disposed" });
  });

  it("does not flush a retained candidate while another maintenance root blocks graceful disposal", async () => {
    const value = runtime();
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 34, offset: 57_408n });
    let publicationAttempts = 0;
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => {
          publicationAttempts += 1;
          return { durableSuccessor: publishedDescriptorFromWorking({ working }), type: "published" as const };
        },
      }),
      successor: working,
    });
    const unrelatedRoot = value.acquireWriterDependencyRoot({
      commitReference: commitReference({ offset: 61_504n }),
    });

    await expect(value.flushAndDisposeIfIdleAndSafe()).resolves.toEqual({
      blocker: "maintenance_root_resource",
      status: "retained",
    });
    expect(publicationAttempts).toBe(0);

    unrelatedRoot.release();
    await expect(value.flushAndDisposeIfIdleAndSafe()).resolves.toEqual({ status: "disposed" });
    expect(publicationAttempts).toBe(1);
  });

  it("serializes graceful dirty flush disposal behind cross-realm writer ownership", async () => {
    const port = new InMemoryCrossRealmLockPort();
    const value = runtime({ crossRealmLockPort: port });
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 42, offset: 81_984n });
    let publicationCount = 0;
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => {
          publicationCount += 1;
          return { durableSuccessor: publishedDescriptorFromWorking({ working }), type: "published" as const };
        },
      }),
      successor: working,
    });

    const competingRealm = new CrossRealmLockCoordinator({
      lockPort: port,
      maxHeldLockNames: 64,
      scopeToken: RUNTIME_SCOPE_TOKEN,
    });
    const competingWriter = await competingRealm.acquireWriter();
    let disposed = false;
    const disposal = value.flushAndDisposeIfIdleAndSafe().then(result => {
      disposed = true;
      return result;
    });
    await new Promise(resolve => globalThis.setTimeout(resolve, 0));
    expect(publicationCount).toBe(0);
    expect(disposed).toBe(false);

    competingWriter.release();
    await competingWriter.released;
    await expect(disposal).resolves.toEqual({ status: "disposed" });
    expect(publicationCount).toBe(1);
  });

  it("does not auto-resolve outcome-unknown authority during graceful host disposal", async () => {
    const value = runtime();
    const authority = value.attachAuthenticatedApplicationGeneration({
      durableAuthority: authenticatedGenerationFixture(),
    });
    const base = authority.capture();
    const working = unpublishedSuccessorDescriptor({ base, mutationByte: 33, offset: 53_312n });
    const failure = new Error("publication outcome unknown");
    const admission = authority.openAcceptedMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: base,
      unpublishedPhysicalBytes: 1,
    });
    admission.commitAcceptedSuccessor({
      publisher: Object.freeze({
        abandon: () => undefined,
        completeOutcomeUnknownResolution: () => undefined,
        publish: async () => ({ cause: failure, type: "outcome_unknown" as const }),
      }),
      successor: working,
    });
    await expect(authority.requestExplicitFlush()).rejects.toBe(failure);

    await expect(value.flushAndDisposeIfIdleAndSafe()).resolves.toEqual({
      blocker: "working_candidate_not_empty",
      status: "retained",
    });
  });

  it("retains the runtime while authenticated generation admission is active", async () => {
    const value = runtime();
    const durableAuthority = authenticatedGenerationFixture();
    const authority = value.attachAuthenticatedApplicationGeneration({ durableAuthority });
    const admission = authority.openImmediateMutationAdmission({
      dirtyMetadataBytes: 1,
      expectedBase: requireMaterializedApplicationGenerationDescriptor({ descriptor: authority.capture() }),
      unpublishedPhysicalBytes: 1,
    });

    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({
      blocker: "working_generation_not_durable",
      status: "retained",
    });
    await expect(authority.requestExplicitFlush()).rejects.toMatchObject({
      code: "working_authority_busy",
    });

    admission.rollback();
    await expect(authority.requestExplicitFlush()).resolves.toBeUndefined();
    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({ status: "disposed" });
  });
  it("owns local and cross-realm reader pins as one session child", async () => {
    const value = runtime();
    const session = await openSession({ value });
    const pin = await session.acquireReaderPin({ commitReference: commitReference({ offset: 64n }) });

    const capture = await value.beginMaintenanceRootCapture();
    expect(capture.maintenanceRootEpoch).toBe(1);
    expect(capture.readerPinnedRoots).toHaveLength(1);
    capture.release();

    await session.close();
    pin.release();
    const afterClose = await value.beginMaintenanceRootCapture();
    expect(afterClose.maintenanceRootEpoch).toBe(1);
    expect(afterClose.readerPinnedRoots).toEqual([]);
    afterClose.release();
  });

  it("captures exact local maintenance owner categories under one epoch", async () => {
    const value = runtime();
    const inspector = value.acquireInspectorPinnedRoot({ commitReference: commitReference({ offset: 64n }) });
    const source = value.acquireSourceSegmentPinnedRoot({ commitReference: commitReference({ offset: 96n }) });
    const unknown = value.acquireUnknownFeatureRoot({ commitReference: commitReference({ offset: 128n }) });
    const writer = value.acquireWriterDependencyRoot({ commitReference: commitReference({ offset: 160n }) });

    const capture = await value.beginMaintenanceRootCapture();
    expect(capture.maintenanceRootEpoch).toBe(4);
    expect(capture.inspectorPinnedRoots).toHaveLength(1);
    expect(capture.sourceSegmentPinnedRoots).toHaveLength(1);
    expect(capture.unknownFeatureRoots).toHaveLength(1);
    expect(capture.writerDependencyRoots).toHaveLength(1);
    expect(capture.readerPinnedRoots).toEqual([]);
    expect(() => value.acquireUnknownFeatureRoot({ commitReference: commitReference({ offset: 192n }) }))
      .toThrowError(expect.objectContaining({ code: "registration_blocked" }));
    capture.release();
    inspector.release();
    source.release();
    unknown.release();
    writer.release();
  });

  it("does not finish session close before cross-realm reader-pin release completes", async () => {
    const port = new DelayedReaderPinReleasePort();
    const value = runtime({ crossRealmLockPort: port });
    const session = await openSession({ value });
    await session.acquireReaderPin({ commitReference: commitReference({ offset: 96n }) });

    const closing = session.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);

    port.completeReaderPinRelease();
    await closing;
    expect(closed).toBe(true);
  });

  it("revokes publication before the commit point and releases writer ownership on close", async () => {
    const value = runtime();
    const session = await openSession({ value });
    const writer = await session.acquireWriter();
    const prepared = deferred<void>();
    const resume = deferred<void>();
    const publication = writer.runPublication({ operation: async ({ authority }) => {
      prepared.resolve();
      await resume.promise;
      authority.assertPublicationAllowed();
      return "published";
    } });
    await prepared.promise;
    const closing = session.close();
    resume.resolve();
    await expect(publication).rejects.toMatchObject({ code: "publication_revoked" });
    await closing;

    const nextSession = await openSession({ value });
    await expect(nextSession.acquireWriter()).resolves.toBeDefined();
    await nextSession.close();
  });

  it("waits for outcome resolution after the commit point", async () => {
    const value = runtime();
    const session = await openSession({ value });
    const writer = await session.acquireWriter();
    const committed = deferred<void>();
    const resolution = deferred<string>();
    const publication = writer.runPublication({ operation: async ({ authority }) => {
      authority.markCommitPointCrossed();
      committed.resolve();
      return await resolution.promise;
    } });
    await committed.promise;
    const closing = session.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    resolution.resolve("converged");
    await expect(publication).resolves.toBe("converged");
    await closing;
  });

  it("blocks source segment deletion until all session-owned references are released", async () => {
    const value = runtime();
    const session = await openSession({ value });
    const segmentId = parseSegmentId({ bytes: new Uint8Array(16).fill(7) });
    await session.acquireSegmentReference({ kind: "backend_handle", segmentId });
    await session.acquireSegmentReference({ kind: "read_lease", segmentId });

    const deletionPromise = value.beginSegmentDeletion({ segmentId });
    let acquired = false;
    void deletionPromise.then(() => {
      acquired = true;
    });
    await Promise.resolve();
    expect(acquired).toBe(false);
    await session.close();
    const deletion = await deletionPromise;
    deletion.release();
  });
  it("creates a session only after capture, out-of-lock verification, and unchanged recheck", async () => {
    const value = runtime();
    const events: string[] = [];
    let released = false;
    const session = await value.openSessionWithAuthorityHandshake({
      captureAuthority: async () => {
        events.push("capture");
        return { revision: 3 };
      },
      createSessionResources: ({ captured, verified }) => {
        events.push(`resources:${captured.revision}:${String(verified)}`);
        return { releaseResources: async () => {
          released = true;
        } };
      },
      recheckAuthority: async ({ captured }) => {
        events.push(`recheck:${captured.revision}`);
      },
      verifyCapturedAuthority: async ({ captured }) => {
        events.push(`verify:${captured.revision}`);
        return "ok";
      },
    });
    expect(events).toEqual(["capture", "verify:3", "recheck:3", "resources:3:ok"]);
    await session.close();
    expect(released).toBe(true);
  });


  it("waits for an earlier admitted publication before resolving sync", async () => {
    const value = runtime();
    const session = await openSession({ value });
    const writer = await session.acquireWriter();
    const publicationStarted = deferred<void>();
    const releasePublication = deferred<void>();
    const publication = writer.runPublication({ operation: async () => {
      publicationStarted.resolve();
      await releasePublication.promise;
    } });
    await publicationStarted.promise;

    let syncResolved = false;
    const syncing = session.syncDurableState({
      assertDurabilityDemonstrated: () => undefined,
      recheckAuthority: async () => undefined,
    }).then(() => {
      syncResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(syncResolved).toBe(false);

    releasePublication.resolve();
    await publication;
    await writer.close();
    await syncing;
    expect(syncResolved).toBe(true);
    await session.close();
  });

  it("serializes a durable sync barrier through writer publication ownership", async () => {
    const value = runtime();
    const session = await openSession({ value });
    const events: string[] = [];

    await session.syncDurableState({
      assertDurabilityDemonstrated: () => {
        events.push("profile");
      },
      recheckAuthority: async () => {
        events.push("recheck");
      },
    });

    expect(events).toEqual(["profile", "recheck", "profile"]);
    const writer = await session.acquireWriter();
    await writer.close();
    await session.close();
  });

  it("owns one unpublished candidate root across runtime sessions until resolution", async () => {
    const value = runtime();
    const firstSession = await openSession({ value });
    const secondSession = await openSession({ value });
    const { candidateDurable, durable, successor } = candidateIdentities();
    const candidate = Object.freeze({ id: "runtime-candidate" });
    const admission = value.openWorkingCandidateAdmission<typeof candidate>({
      durableBaseIdentity: durable,
      operationLabel: "first runtime session mutation",
    });

    admission.install({
      candidate,
      candidateDurableIdentity: candidateDurable,
      releaseCandidate: () => undefined,
      workingIdentity: successor,
    });
    expect(value.workingCandidatePublicationState()).toBe("installed");
    const installed = await value.beginMaintenanceRootCapture();
    expect(installed.writerDependencyRoots).toEqual([candidateDurable.commitReference]);
    installed.release();
    await installed.released;
    expect(() => value.openWorkingCandidateAdmission({
      durableBaseIdentity: durable,
      operationLabel: "second runtime session mutation",
    })).toThrowError(expect.objectContaining({ code: "candidate_active" }));

    expect(admission.selectCandidateForPublication()).toBe(candidate);
    admission.resolve({ outcome: "published" });
    const cleared = await value.beginMaintenanceRootCapture();
    expect(cleared.writerDependencyRoots).toEqual([]);
    cleared.release();
    await cleared.released;
    expect(value.workingCandidatePublicationState()).toBe("empty");

    await firstSession.close();
    await secondSession.close();
  });

  it("releases writer ownership when a sync profile gate rejects", async () => {
    const value = runtime();
    const session = await openSession({ value });
    const rejection = new Error("durability unavailable");

    await expect(session.syncDurableState({
      assertDurabilityDemonstrated: () => {
        throw rejection;
      },
      recheckAuthority: async () => undefined,
    })).rejects.toBe(rejection);

    const writer = await session.acquireWriter();
    await writer.close();
    await session.close();
  });
});

describe("container runtime cross-realm owner lifetime", () => {
  it("waits for the current realm runtime to close before another runtime opens", async () => {
    const port = new InMemoryCrossRealmLockPort();
    const firstRuntime = runtime({ crossRealmLockPort: port });
    const secondRuntime = runtime({ crossRealmLockPort: port });
    const firstSession = await openSession({ value: firstRuntime });

    let secondOpened = false;
    const secondOpening = openSession({ value: secondRuntime }).then(session => {
      secondOpened = true;
      return session;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondOpened).toBe(false);

    await firstSession.close();
    const secondSession = await secondOpening;
    expect(secondOpened).toBe(true);
    await secondSession.close();
  });

  it("shares one runtime-owner lease across sessions attached to the same runtime", async () => {
    const port = new InMemoryCrossRealmLockPort();
    const value = runtime({ crossRealmLockPort: port });
    const firstSession = await openSession({ value });
    const secondSession = await openSession({ value });

    expect((await port.queryHeldLockNames()).filter(name => name.includes("/runtime-owner/"))).toHaveLength(1);
    await firstSession.close();
    expect((await port.queryHeldLockNames()).filter(name => name.includes("/runtime-owner/"))).toHaveLength(1);
    await secondSession.close();
    expect((await port.queryHeldLockNames()).filter(name => name.includes("/runtime-owner/"))).toEqual([]);
  });

  it("releases runtime ownership when the authority handshake fails before session creation", async () => {
    const port = new InMemoryCrossRealmLockPort();
    const firstRuntime = runtime({ crossRealmLockPort: port });
    const secondRuntime = runtime({ crossRealmLockPort: port });

    await expect(firstRuntime.openSessionWithAuthorityHandshake({
      captureAuthority: async () => ({ revision: 1 }),
      createSessionResources: () => ({ releaseResources: async () => undefined }),
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => {
        throw new Error("verification failed");
      },
    })).rejects.toThrow("verification failed");

    const secondSession = await openSession({ value: secondRuntime });
    await secondSession.close();
  });

  it("releases runtime ownership when session resource construction fails after owner acquisition", async () => {
    const port = new InMemoryCrossRealmLockPort();
    const firstRuntime = runtime({ crossRealmLockPort: port });
    const secondRuntime = runtime({ crossRealmLockPort: port });

    await expect(firstRuntime.openSessionWithAuthorityHandshake({
      captureAuthority: async () => ({ revision: 1 }),
      createSessionResources: () => {
        throw new Error("resource construction failed");
      },
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => "verified",
    })).rejects.toThrow("resource construction failed");

    const secondSession = await openSession({ value: secondRuntime });
    await secondSession.close();
  });

  it("releases clean runtime ownership even when session resource cleanup fails", async () => {
    const port = new InMemoryCrossRealmLockPort();
    const firstRuntime = runtime({ crossRealmLockPort: port });
    const secondRuntime = runtime({ crossRealmLockPort: port });
    const firstSession = await firstRuntime.openSessionWithAuthorityHandshake({
      captureAuthority: async () => ({ revision: 1 }),
      createSessionResources: () => ({ releaseResources: async () => {
        throw new Error("resource cleanup failed");
      } }),
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => "verified",
    });

    await expect(firstSession.close()).rejects.toThrow("session close encountered child or resource cleanup failures");
    const secondSession = await openSession({ value: secondRuntime });
    await secondSession.close();
  });

  it("retains cross-realm ownership after an outcome-unknown candidate poisons the runtime", async () => {
    const port = new InMemoryCrossRealmLockPort();
    const value = runtime({ crossRealmLockPort: port });
    const session = await openSession({ value });
    const identities = candidateIdentities();
    const admission = value.openWorkingCandidateAdmission<object>({
      durableBaseIdentity: identities.durable,
      operationLabel: "outcome-unknown mutation",
    });
    admission.install({
      candidate: Object.freeze({}),
      candidateDurableIdentity: identities.candidateDurable,
      releaseCandidate: () => undefined,
      workingIdentity: identities.successor,
    });
    admission.retainOutcomeUnknown({ cause: new Error("publication outcome unknown") });

    await session.close();
    expect((await port.queryHeldLockNames()).filter(name => name.includes("/runtime-owner/"))).toHaveLength(1);
    expect(value.workingCandidatePublicationState()).toBe("outcome_unknown");

    const conflictingDurableIdentity = createDurableGenerationIdentity({
      commitReference: commitReference({ offset: 256n }),
      commitSequence: createCommitSequence({ value: 9n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(3) }),
    });
    await expect(value.resolveWorkingCandidateOutcomeUnknown({
      observedDurableIdentity: conflictingDurableIdentity,
    })).rejects.toMatchObject({ code: "outcome_resolution_conflict" });
    expect(value.workingCandidatePublicationState()).toBe("outcome_unknown");
    expect((await port.queryHeldLockNames()).filter(name => name.includes("/runtime-owner/"))).toHaveLength(1);

    await expect(value.resolveWorkingCandidateOutcomeUnknown({
      observedDurableIdentity: identities.durable,
    })).resolves.toBe("confirmed_not_published");
    expect(value.workingCandidatePublicationState()).toBe("empty");
    expect((await port.queryHeldLockNames()).filter(name => name.includes("/runtime-owner/"))).toHaveLength(0);

    const nextRuntime = runtime({ crossRealmLockPort: port });
    const nextSession = await openSession({ value: nextRuntime });
    await nextSession.close();
  });

  it("offers a non-blocking busy boundary across independent runtimes", async () => {
    const port = new InMemoryCrossRealmLockPort();
    const firstRuntime = runtime({ crossRealmLockPort: port });
    const secondRuntime = runtime({ crossRealmLockPort: port });
    const first = await openSession({ value: firstRuntime });
    await expect(tryOpenSession({ value: secondRuntime })).resolves.toBeUndefined();
    await first.close();
    const second = await tryOpenSession({ value: secondRuntime });
    expect(second).toBeDefined();
    await second?.close();
  });


  it("disposes only after the final session closes and rejects later opens", async () => {
    const value = runtime();
    const session = await openSession({ value });

    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({
      blocker: "session_attached",
      status: "retained",
    });
    await session.close();
    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({ status: "disposed" });
    await expect(openSession({ value })).rejects.toMatchObject({ code: "runtime_host_disposed" });
  });

  it("retains a runtime host while an outcome-unknown candidate owns authority", async () => {
    const value = runtime();
    const session = await openSession({ value });
    const identities = candidateIdentities();
    const admission = value.openWorkingCandidateAdmission<object>({
      durableBaseIdentity: identities.durable,
      operationLabel: "host disposal outcome-unknown mutation",
    });
    admission.install({
      candidate: Object.freeze({}),
      candidateDurableIdentity: identities.candidateDurable,
      releaseCandidate: () => undefined,
      workingIdentity: identities.successor,
    });
    admission.retainOutcomeUnknown({ cause: new Error("publication outcome unknown") });
    await session.close();

    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({
      blocker: "working_candidate_not_empty",
      status: "retained",
    });
    await expect(value.resolveWorkingCandidateOutcomeUnknown({
      observedDurableIdentity: identities.durable,
    })).resolves.toBe("confirmed_not_published");
    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({ status: "disposed" });
  });

  it("retains a runtime host while a maintenance capture is active", async () => {
    const value = runtime();
    const capture = await value.beginMaintenanceRootCapture();

    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({
      blocker: "runtime_coordination_active",
      status: "retained",
    });
    capture.release();
    await capture.released;
    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({ status: "disposed" });
  });

  it("retains a runtime host while a maintenance root registration is active", async () => {
    const value = runtime();
    const root = value.acquireInspectorPinnedRoot({ commitReference: commitReference({ offset: 64n }) });

    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({
      blocker: "maintenance_root_resource",
      status: "retained",
    });
    root.release();
    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({ status: "disposed" });
  });

  it("retains a runtime host while a segment deletion gate is active", async () => {
    const value = runtime();
    const deletion = await value.beginSegmentDeletion({
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(4) }),
    });

    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({
      blocker: "active_segment_resource",
      status: "retained",
    });
    deletion.release();
    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({ status: "disposed" });
  });

  it("retains a runtime host while an open handshake is in flight", async () => {
    const value = runtime();
    const verification = deferred<void>();
    const opening = value.openSessionWithAuthorityHandshake({
      captureAuthority: async () => ({ revision: 1 }),
      createSessionResources: () => ({ releaseResources: async () => undefined }),
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => {
        await verification.promise;
        return "verified";
      },
    });
    await Promise.resolve();

    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({
      blocker: "session_open_in_flight",
      status: "retained",
    });
    verification.resolve();
    const session = await opening;
    await session.close();
    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({ status: "disposed" });
  });

});
