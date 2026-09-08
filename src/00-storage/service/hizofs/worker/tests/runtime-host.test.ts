import { describe, expect, it, vi } from "vitest";
import type {
  HizoFSApplicationMutationPort,
  HizoFSApplicationSessionNamespace,
} from "@/00-storage/service/hizofs/api";
import { createTestingWorkingCandidateIdentities } from "@/00-storage/service/hizofs/runtime/testing/working-generation-identity-fixture";
import {
  createBrowserHizoFSWorkerRuntimeHost,
  HizoFSWorkerRuntimeHost,
  TEST_ONLY,
} from "@/00-storage/service/hizofs/worker/runtime-host";
import { createContainerCoordinationScope, parseContainerCoordinationScopeToken } from "@/00-storage/service/hizofs/runtime/container-coordination-scope";
import { InMemoryCrossRealmLockPort } from "@/00-storage/service/hizofs/runtime/testing/in-memory-cross-realm-lock-port";
import type { CrossRealmLockMode, CrossRealmLockPort } from "@/00-storage/service/hizofs/runtime/cross-realm-lock-coordinator";
import { createTestingHomeRecordReference } from "@/00-storage/service/hizofs/runtime/testing/home-record-reference-fixture";
import { createTestingAuthenticatedDurableApplicationGenerationAuthority } from "@/00-storage/service/hizofs/runtime/testing/authenticated-application-generation-fixture";
import {
  DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
  type HizoFSLazyDurabilityPolicy,
} from "@/00-storage/service/hizofs/runtime/runtime-policy";

function host({
  crossRealmLockPort = new InMemoryCrossRealmLockPort(),
  lazyDurability = DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
}: {
  crossRealmLockPort?: CrossRealmLockPort;
  lazyDurability?: HizoFSLazyDurabilityPolicy;
} = {}) {
  return new HizoFSWorkerRuntimeHost({
    crossRealmLockPort,
    policy: {
      lazyDurability,
      maxHeldLockNames: 64,
      maxMaintenanceRootRegistrations: 64,
      maxReaderPins: 16,
      maxSegmentReferences: 16,
    },
    scope: createContainerCoordinationScope({
      token: parseContainerCoordinationScopeToken({ value: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM" }),
    }),
  });
}

function minimalApplicationResources({ releaseResources = async () => undefined }: {
  releaseResources?: () => Promise<void>;
} = {}) {
  const namespace: HizoFSApplicationSessionNamespace = {
    list: async () => [],
    listBounded: async () => ({ entries: [], truncated: false }),
    readFile: async () => new Uint8Array(),
    readlink: async () => "target",
    stat: async () => ({
      createdAt: null,
      inodeNumber: 1n as never,
      inodeRevision: 1n as never,
      kind: "directory",
      modifiedAt: null,
    }),
  };
  return {
    mutationPort: {} as HizoFSApplicationMutationPort,
    namespace,
    releaseResources,
    syncDurability: "demonstrated" as const,
  };
}

class ObservedReaderPinPort implements CrossRealmLockPort {
  private inner = new InMemoryCrossRealmLockPort();
  readerPinAcquired = false;

  constructor(private readonly failReaderPin = false) {}

  async acquire({ mode, name }: { mode: CrossRealmLockMode; name: string }) {
    if (name.includes("/reader-pin/") && this.failReaderPin) {
      throw new Error("reader pin acquisition failed");
    }
    const lease = await this.inner.acquire({ mode, name });
    if (name.includes("/reader-pin/")) this.readerPinAcquired = true;
    return lease;
  }

  async queryHeldLockNames(): Promise<readonly string[]> {
    return await this.inner.queryHeldLockNames();
  }
}

function browserRequest(): LockManager["request"] {
  const request = async <T>(
    _name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    maybeCallback?: LockGrantedCallback<T>,
  ): Promise<Awaited<T>> => {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    if (callback === undefined) throw new Error("browser lock callback is required");
    return await callback({} as Lock);
  };
  return request as LockManager["request"];
}

describe("HizoFS worker runtime host", () => {
  it("owns an opened runtime session without importing lower storage owners", async () => {
    const releaseResources = vi.fn(async () => undefined);
    const value = host();
    const session = await value.openSession({
      captureAuthority: async () => ({ revision: 1 }),
      createSessionResources: () => ({ releaseResources }),
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => "verified",
    });
    expect(session.state()).toBe("open");
    await session.close();
    expect(releaseResources).toHaveBeenCalledOnce();
  });


  it("serializes independently constructed runtime hosts through one runtime-owner lease", async () => {
    const crossRealmLockPort = new InMemoryCrossRealmLockPort();
    const firstHost = host({ crossRealmLockPort });
    const secondHost = host({ crossRealmLockPort });
    const open = async ({ value }: { value: HizoFSWorkerRuntimeHost }) => await value.openSession({
      captureAuthority: async () => ({ revision: 1 }),
      createSessionResources: () => ({ releaseResources: async () => undefined }),
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => "verified",
    });
    const firstSession = await open({ value: firstHost });
    let secondOpened = false;
    const secondOpening = open({ value: secondHost }).then(session => {
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

  it("returns busy without queueing when another runtime host owns the container", async () => {
    const crossRealmLockPort = new InMemoryCrossRealmLockPort();
    const firstHost = host({ crossRealmLockPort });
    const secondHost = host({ crossRealmLockPort });
    const firstSession = await firstHost.openSession({
      captureAuthority: async () => ({ revision: 1 }),
      createSessionResources: () => ({ releaseResources: async () => undefined }),
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => "verified",
    });

    const secondSession = await secondHost.tryOpenSession({
      captureAuthority: async () => ({ revision: 1 }),
      createSessionResources: () => ({ releaseResources: async () => undefined }),
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => "verified",
    });

    expect(secondSession).toBeUndefined();
    await firstSession.close();
  });

  it("projects non-blocking owner contention as a stable typed busy error", async () => {
    const crossRealmLockPort = new InMemoryCrossRealmLockPort();
    const firstHost = host({ crossRealmLockPort });
    const secondHost = host({ crossRealmLockPort });
    const firstSession = await firstHost.openSession({
      captureAuthority: async () => ({ revision: 1 }),
      createSessionResources: () => ({ releaseResources: async () => undefined }),
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => "verified",
    });

    await expect(secondHost.openSession({
      captureAuthority: async () => ({ revision: 1 }),
      createSessionResources: () => ({ releaseResources: async () => undefined }),
      recheckAuthority: async () => undefined,
      runtimeOwnerPolicy: "reject_if_busy",
      verifyCapturedAuthority: async () => "verified",
    })).rejects.toMatchObject({ code: "runtime_owner_busy" });
    await firstSession.close();
  });

  it("rejects a busy application-session open before resource construction", async () => {
    const crossRealmLockPort = new InMemoryCrossRealmLockPort();
    const firstHost = host({ crossRealmLockPort });
    const secondHost = host({ crossRealmLockPort });
    const firstSession = await firstHost.openSession({
      captureAuthority: async () => ({ revision: 1 }),
      createSessionResources: () => ({ releaseResources: async () => undefined }),
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => "verified",
    });
    const createApplicationSessionResources = vi.fn(() => {
      throw new Error("busy application open must not construct resources");
    });

    await expect(secondHost.openApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      createApplicationSessionResources,
      recheckAuthority: async () => undefined,
      runtimeOwnerPolicy: "reject_if_busy",
      verifyCapturedAuthority: async () => "verified",
    })).rejects.toMatchObject({ code: "runtime_owner_busy" });
    expect(createApplicationSessionResources).not.toHaveBeenCalled();
    await firstSession.close();
  });

  it("resolves an outcome-unknown runtime from authenticated durable authority before reopening", async () => {
    const crossRealmLockPort = new InMemoryCrossRealmLockPort();
    const value = host({ crossRealmLockPort });
    const identities = createTestingWorkingCandidateIdentities();
    const firstSession = await value.openApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      createApplicationSessionResources: ({ openWorkingCandidateAdmission }) => {
        const admission = openWorkingCandidateAdmission({
          durableBaseIdentity: identities.durable,
          operationLabel: "outcome-unknown runtime host mutation",
        });
        admission.install({
          candidate: Object.freeze({}),
          candidateDurableIdentity: identities.candidateDurable,
          releaseCandidate: () => undefined,
          workingIdentity: identities.working,
        });
        admission.retainOutcomeUnknown({ cause: new Error("publication outcome unknown") });
        return minimalApplicationResources();
      },
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => ({ durableIdentity: identities.durable }),
    });

    await firstSession.close();
    expect(value.workingCandidatePublicationState()).toBe("outcome_unknown");
    expect((await crossRealmLockPort.queryHeldLockNames()).filter(name => name.includes("/runtime-owner/")))
      .toHaveLength(1);

    const createRecoveredResources = vi.fn(() => minimalApplicationResources());
    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({
      blocker: "working_candidate_not_empty",
      status: "retained",
    });
    const recoveredSession = await value.openApplicationSession({
      captureAuthority: async () => ({ revision: 2 }),
      createApplicationSessionResources: createRecoveredResources,
      observeAuthenticatedDurableIdentity: ({ verified }) => verified.durableIdentity,
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => ({ durableIdentity: identities.durable }),
    });

    expect(createRecoveredResources).toHaveBeenCalledOnce();
    expect(value.workingCandidatePublicationState()).toBe("empty");
    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({
      blocker: "session_attached",
      status: "retained",
    });
    await recoveredSession.close();
    expect((await crossRealmLockPort.queryHeldLockNames()).filter(name => name.includes("/runtime-owner/")))
      .toEqual([]);
    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({ status: "disposed" });
  });

  it("retains outcome-unknown ownership when authenticated durable authority conflicts", async () => {
    const crossRealmLockPort = new InMemoryCrossRealmLockPort();
    const value = host({ crossRealmLockPort });
    const identities = createTestingWorkingCandidateIdentities();
    const firstSession = await value.openApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      createApplicationSessionResources: ({ openWorkingCandidateAdmission }) => {
        const admission = openWorkingCandidateAdmission({
          durableBaseIdentity: identities.durable,
          operationLabel: "conflicting outcome-unknown runtime host mutation",
        });
        admission.install({
          candidate: Object.freeze({}),
          candidateDurableIdentity: identities.candidateDurable,
          releaseCandidate: () => undefined,
          workingIdentity: identities.working,
        });
        admission.retainOutcomeUnknown({ cause: new Error("publication outcome unknown") });
        return minimalApplicationResources();
      },
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => ({ durableIdentity: identities.durable }),
    });
    await firstSession.close();

    const createConflictingResources = vi.fn(() => minimalApplicationResources());
    await expect(value.openApplicationSession({
      captureAuthority: async () => ({ revision: 2 }),
      createApplicationSessionResources: createConflictingResources,
      observeAuthenticatedDurableIdentity: ({ verified }) => verified.durableIdentity,
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => ({ durableIdentity: identities.conflictingDurable }),
    })).rejects.toMatchObject({ code: "outcome_resolution_conflict" });

    expect(createConflictingResources).not.toHaveBeenCalled();
    expect(value.workingCandidatePublicationState()).toBe("outcome_unknown");
    expect((await crossRealmLockPort.queryHeldLockNames()).filter(name => name.includes("/runtime-owner/")))
      .toHaveLength(1);

    const recoveredSession = await value.openApplicationSession({
      captureAuthority: async () => ({ revision: 3 }),
      createApplicationSessionResources: () => minimalApplicationResources(),
      observeAuthenticatedDurableIdentity: ({ verified }) => verified.durableIdentity,
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => ({ durableIdentity: identities.durable }),
    });
    await recoveredSession.close();
    expect(value.workingCandidatePublicationState()).toBe("empty");
    expect((await crossRealmLockPort.queryHeldLockNames()).filter(name => name.includes("/runtime-owner/")))
      .toEqual([]);
    const nextHost = host({ crossRealmLockPort });
    const nextSession = await nextHost.openSession({
      captureAuthority: async () => ({ revision: 4 }),
      createSessionResources: () => ({ releaseResources: async () => undefined }),
      recheckAuthority: async () => undefined,
      runtimeOwnerPolicy: "reject_if_busy",
      verifyCapturedAuthority: async () => "verified",
    });
    await nextSession.close();
  });

  it("delegates management clean-head barrier acquisition to the container runtime", async () => {
    const value = host();
    const barrier = value.openManagementCleanHeadBarrier({});

    await expect(barrier.flushAndCaptureCleanGeneration()).rejects.toThrowError(
      "working generation coordinator is not initialized for this runtime",
    );
    barrier.release();
  });

  it("delegates graceful flush-and-dispose to the container runtime", async () => {
    const value = host();

    await expect(value.flushAndDisposeIfIdleAndSafe()).resolves.toEqual({ status: "disposed" });
    await expect(value.openSession({
      captureAuthority: async () => ({ revision: 1 }),
      createSessionResources: () => ({ releaseResources: async () => undefined }),
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => "verified",
    })).rejects.toMatchObject({ code: "runtime_host_disposed" });
  });

  it("delegates safe host disposal to the container runtime", async () => {
    const value = host();

    await expect(value.disposeIfIdleAndSafe()).resolves.toEqual({ status: "disposed" });
    await expect(value.openSession({
      captureAuthority: async () => ({ revision: 1 }),
      createSessionResources: () => ({ releaseResources: async () => undefined }),
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => "verified",
    })).rejects.toMatchObject({ code: "runtime_host_disposed" });
  });

  it("creates the worker runtime from the browser LockManager contract", async () => {
    const value = createBrowserHizoFSWorkerRuntimeHost({
      lockManager: {
        query: async () => ({ held: [] }),
        request: browserRequest(),
      },
      policy: {
        lazyDurability: DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
        maxHeldLockNames: 64,
        maxMaintenanceRootRegistrations: 64,
        maxReaderPins: 16,
        maxSegmentReferences: 16,
      },
      scope: createContainerCoordinationScope({
        token: parseContainerCoordinationScopeToken({ value: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM" }),
      }),
    });
    const session = await value.openSession({
      captureAuthority: async () => ({ revision: 1 }),
      createSessionResources: () => ({ releaseResources: async () => undefined }),
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => "verified",
    });
    await session.close();
  });

  it("opens a Naidan application session over the runtime authority handshake", async () => {
    const releaseResources = vi.fn(async () => undefined);
    const mutations: string[] = [];
    const mutationPort: HizoFSApplicationMutationPort = {
      async cloneFile({ authority }) {
        mutations.push("clone");
        authority.markCandidateAccepted();
        authority.markCommitPointCrossed();
      },
      async createDirectory({ authority }) {
        mutations.push("mkdir");
        authority.markCandidateAccepted();
        authority.markCommitPointCrossed();
      },
      async createFile({ authority }) {
        mutations.push("create-file");
        authority.markCandidateAccepted();
        authority.markCommitPointCrossed();
      },
      async createSymlink({ authority }) {
        mutations.push("symlink");
        authority.markCandidateAccepted();
        authority.markCommitPointCrossed();
      },
      async ensureDirectory({ authority }) {
        mutations.push("ensure-directory");
        authority.markCandidateAccepted();
        authority.markCommitPointCrossed();
      },
      async ensureFile({ authority }) {
        mutations.push("ensure-file");
        authority.markCandidateAccepted();
        authority.markCommitPointCrossed();
      },
      async moveEntry({ authority }) {
        mutations.push("move");
        authority.markCandidateAccepted();
        authority.markCommitPointCrossed();
      },
      async openWritable() {
        return {
          async abort() {
            mutations.push("abort");
          },
          async commit({ authority }) {
            mutations.push("commit");
            authority.markCandidateAccepted();
            authority.markCommitPointCrossed();
          },
          async truncate() {
            mutations.push("truncate");
          },
          async write() {
            mutations.push("write");
            return "returned_to_caller";
          },
        };
      },
      async removeEntry({ authority }) {
        mutations.push("remove");
        authority.markCandidateAccepted();
        authority.markCommitPointCrossed();
      },
    };
    const value = host();
    const recheckAuthority = vi.fn(async () => undefined);
    const session = await value.openApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      createApplicationSessionResources: () => ({
        mutationPort,
        namespace: {
          list: async () => [],
          listBounded: async () => ({ entries: [], truncated: false }),
          readFile: async () => new Uint8Array(),
          readlink: async () => "target",
          stat: async () => ({
            createdAt: null,
            inodeNumber: 1n as never,
            inodeRevision: 1n as never,
            kind: "directory",
            modifiedAt: null,
          }),
        },
        releaseResources,
        syncDurability: "demonstrated",
      }),
      recheckAuthority,
      rootName: "application-root",
      verifyCapturedAuthority: async () => "verified",
    });

    expect(session.root.name).toBe("application-root");
    await expect(session.root.stat()).resolves.toEqual({
      createdAt: undefined,
      modifiedAt: undefined,
      size: 0,
    });
    await session.root.createSymlink({ name: "link", target: "target" });
    expect(mutations).toEqual(["symlink"]);
    await session.sync();
    expect(recheckAuthority).toHaveBeenCalledTimes(2);
    await session.close();
    expect(releaseResources).toHaveBeenCalledOnce();
    await expect(session.root.stat()).rejects.toThrow("HizoFS application session is closed");
  });

  it("pins one immutable generation for a read snapshot and releases it on snapshot close", async () => {
    const releaseResources = vi.fn(async () => undefined);
    const mutationPort = {} as HizoFSApplicationMutationPort;
    const value = host();
    const session = await value.openApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      createApplicationSessionResources: () => ({
        createReadSnapshotResources: () => ({
          commitReference: createTestingHomeRecordReference(),
          mutationPort,
          namespace: {
            list: async () => [],
            listBounded: async () => ({ entries: [], truncated: false }),
            readFile: async () => new Uint8Array([7]),
            readlink: async () => "snapshot-target",
            stat: async () => ({
              createdAt: null,
              inodeNumber: 1n as never,
              inodeRevision: 1n as never,
              kind: "directory" as const,
              modifiedAt: null,
            }),
          },
        }),
        mutationPort,
        namespace: {
          list: async () => [],
          listBounded: async () => ({ entries: [], truncated: false }),
          readFile: async () => new Uint8Array([9]),
          readlink: async () => "live-target",
          stat: async () => ({
            createdAt: null,
            inodeNumber: 1n as never,
            inodeRevision: 1n as never,
            kind: "directory" as const,
            modifiedAt: null,
          }),
        },
        releaseResources,
        syncDurability: "demonstrated",
      }),
      recheckAuthority: async () => undefined,
      rootName: "application-root",
      verifyCapturedAuthority: async () => "verified",
    });

    const snapshot = await session.createReadSnapshot?.();
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) throw new Error("read snapshot was not created");
    const whilePinned = await value.beginMaintenanceRootCapture();
    expect(whilePinned.readerPinnedRoots).toHaveLength(1);
    whilePinned.release();
    await whilePinned.released;

    await session.close();
    expect(releaseResources).not.toHaveBeenCalled();
    await expect(snapshot.root.stat()).resolves.toEqual({
      createdAt: undefined,
      modifiedAt: undefined,
      size: 0,
    });
    await expect(snapshot.root.removeEntry({ name: "blocked", recursive: false }))
      .rejects.toThrow("HizoFS read snapshot cannot acquire a writer");
    const afterParentClose = await value.beginMaintenanceRootCapture();
    expect(afterParentClose.readerPinnedRoots).toHaveLength(1);
    afterParentClose.release();
    await afterParentClose.released;

    await snapshot.close();
    expect(releaseResources).toHaveBeenCalledOnce();
    const afterSnapshotClose = await value.beginMaintenanceRootCapture();
    expect(afterSnapshotClose.readerPinnedRoots).toEqual([]);
    afterSnapshotClose.release();
    await afterSnapshotClose.released;
  });

  it.each(["exhaustion", "early_return", "owner_close"] as const)("releases the directory iterator snapshot on %s", async completion => {
    const crossRealmLockPort = new InMemoryCrossRealmLockPort();
    const releaseResources = vi.fn(async () => undefined);
    const value = host({ crossRealmLockPort });
    type NamespaceInodeNumber = Awaited<ReturnType<HizoFSApplicationSessionNamespace["stat"]>>["inodeNumber"];
    const listAfterBounded = vi.fn<NonNullable<HizoFSApplicationSessionNamespace["listAfterBounded"]>>(async () => ({
      entries: [
        { inodeKind: "file", inodeNumber: 2n as NamespaceInodeNumber, name: "first", targetType: "inode" },
        { inodeKind: "file", inodeNumber: 3n as NamespaceInodeNumber, name: "second", targetType: "inode" },
      ],
      truncated: false,
    }));
    const createReadSnapshotResources = vi.fn(() => ({
      commitReference: createTestingHomeRecordReference(),
      mutationPort: {} as HizoFSApplicationMutationPort,
      namespace: { ...minimalApplicationResources().namespace, listAfterBounded },
    }));
    const session = await value.openApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      createApplicationSessionResources: () => ({
        ...minimalApplicationResources({ releaseResources }),
        createReadSnapshotResources,
      }),
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => "verified",
    });
    const iterator = session.root.entries()[Symbol.asyncIterator]();
    if (iterator.return === undefined) throw new Error("directory iterator must support early return");

    expect(createReadSnapshotResources).not.toHaveBeenCalled();
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: ["first", { kind: "file" }] });
    expect(createReadSnapshotResources).toHaveBeenCalledOnce();
    expect(listAfterBounded).toHaveBeenCalledOnce();
    const whileIterating = await value.beginMaintenanceRootCapture();
    expect(whileIterating.readerPinnedRoots).toHaveLength(1);
    whileIterating.release();
    await whileIterating.released;
    expect((await crossRealmLockPort.queryHeldLockNames()).some(name => name.includes("/reader-pin/"))).toBe(true);

    switch (completion) {
    case "exhaustion":
      await expect(iterator.next()).resolves.toMatchObject({ done: false, value: ["second", { kind: "file" }] });
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
      expect(releaseResources).not.toHaveBeenCalled();
      break;
    case "early_return":
      await iterator.return();
      await iterator.return();
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
      expect(releaseResources).not.toHaveBeenCalled();
      await expect(session.root.stat()).resolves.toMatchObject({ size: 0 });
      break;
    case "owner_close":
      await session.close();
      expect(releaseResources).toHaveBeenCalledOnce();
      break;
    default: completion satisfies never;
    }

    expect(listAfterBounded).toHaveBeenCalledOnce();
    const afterIteration = await value.beginMaintenanceRootCapture();
    expect(afterIteration.readerPinnedRoots).toEqual([]);
    afterIteration.release();
    await afterIteration.released;
    expect((await crossRealmLockPort.queryHeldLockNames()).some(name => name.includes("/reader-pin/"))).toBe(false);
    if (completion === "owner_close") {
      await expect(iterator.next()).rejects.toThrow("closed");
      await expect(session.root.stat()).rejects.toThrow("closed");
      await iterator.return();
      expect(listAfterBounded).toHaveBeenCalledOnce();
    }
    await session.close();
    await session.close();
    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it("keeps maintenance behind read-snapshot capture until the captured generation is pinned", async () => {
    const value = host();
    const captureStarted = Promise.withResolvers<void>();
    const continueCapture = Promise.withResolvers<void>();
    const session = await value.openApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      createApplicationSessionResources: () => ({
        ...minimalApplicationResources(),
        createReadSnapshotResources: async () => {
          captureStarted.resolve();
          await continueCapture.promise;
          return {
            commitReference: createTestingHomeRecordReference(),
            mutationPort: {} as HizoFSApplicationMutationPort,
            namespace: minimalApplicationResources().namespace,
          };
        },
      }),
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => "verified",
    });

    const snapshotPromise = session.createReadSnapshot?.();
    if (snapshotPromise === undefined) throw new Error("read snapshot is unavailable");
    await captureStarted.promise;
    let maintenanceResolved = false;
    const maintenancePromise = value.beginMaintenanceRootCapture().then(capture => {
      maintenanceResolved = true;
      return capture;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(maintenanceResolved).toBe(false);

    continueCapture.resolve();
    const snapshot = await snapshotPromise;
    const maintenance = await maintenancePromise;
    expect(maintenance.readerPinnedRoots).toHaveLength(1);
    maintenance.release();
    await maintenance.released;
    await snapshot.close();
    await session.close();
  });

  it("keeps snapshot preparation active until the reader pin is acquired", async () => {
    const crossRealmLockPort = new ObservedReaderPinPort();
    const releasePreparation = vi.fn(() => {
      expect(crossRealmLockPort.readerPinAcquired).toBe(true);
    });
    const value = host({ crossRealmLockPort });
    const session = await value.openApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      createApplicationSessionResources: () => ({
        ...minimalApplicationResources(),
        createReadSnapshotResources: () => ({
          commitReference: createTestingHomeRecordReference(),
          mutationPort: {} as HizoFSApplicationMutationPort,
          namespace: minimalApplicationResources().namespace,
          releasePreparation,
        }),
      }),
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => "verified",
    });

    const snapshot = await session.createReadSnapshot?.();
    expect(snapshot).toBeDefined();
    expect(releasePreparation).toHaveBeenCalledOnce();
    await snapshot?.close();
    await session.close();
  });

  it("releases snapshot preparation when reader-pin acquisition fails", async () => {
    const releasePreparation = vi.fn(() => undefined);
    const value = host({ crossRealmLockPort: new ObservedReaderPinPort(true) });
    const session = await value.openApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      createApplicationSessionResources: () => ({
        ...minimalApplicationResources(),
        createReadSnapshotResources: () => ({
          commitReference: createTestingHomeRecordReference(),
          mutationPort: {} as HizoFSApplicationMutationPort,
          namespace: minimalApplicationResources().namespace,
          releasePreparation,
        }),
      }),
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => "verified",
    });

    await expect(session.createReadSnapshot?.()).rejects.toThrow("reader pin acquisition failed");
    expect(releasePreparation).toHaveBeenCalledOnce();
    await session.close();
  });

  it("preserves the primary runtime-session failure after successful cleanup", async () => {
    const primaryFailure = new Error("session wrapper failed");
    const close = vi.fn(async () => undefined);

    await expect(TEST_ONLY.closeRuntimeSessionAfterFailure({
      cause: primaryFailure,
      message: "wrapper and cleanup failed",
      session: { close },
    })).rejects.toBe(primaryFailure);

    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves primary and cleanup failures when runtime-session cleanup also fails", async () => {
    const primaryFailure = new Error("session wrapper failed");
    const closeFailure = new Error("session close failed");
    const result = TEST_ONLY.closeRuntimeSessionAfterFailure({
      cause: primaryFailure,
      message: "wrapper and cleanup failed",
      session: {
        close: async () => {
          throw closeFailure;
        },
      },
    });

    await expect(result).rejects.toBeInstanceOf(AggregateError);
    await expect(result).rejects.toMatchObject({ errors: [primaryFailure, closeFailure] });
  });

  it("exposes maintenance root capture through the runtime owner", async () => {
    const value = host();
    const capture = await value.beginMaintenanceRootCapture();
    expect(capture.maintenanceRootEpoch).toBe(0);
    expect(capture.readerPinnedRoots).toEqual([]);
    expect(capture.inspectorPinnedRoots).toEqual([]);
    expect(capture.sourceSegmentPinnedRoots).toEqual([]);
    expect(capture.unknownFeatureRoots).toEqual([]);
    expect(capture.workingGenerationDependencyRoots).toEqual([]);
    capture.release();
    await capture.released;
  });

  it("exposes the exact segment-deletion gate without importing format into the host", async () => {
    const value = host();
    const segmentId = new Uint8Array(16).fill(7) as Parameters<
      HizoFSWorkerRuntimeHost["beginSegmentDeletion"]
    >[0]["segmentId"];
    const lease = await value.beginSegmentDeletion({ segmentId });
    lease.release();
  });

  it.each(["automatic", "immediate"] as const)("rejects sync without demonstrated durability in %s mode", async (publicationModeRequest) => {
    const releaseResources = vi.fn(async () => undefined);
    const recheckAuthority = vi.fn(async () => undefined);
    const durableAuthority = createTestingAuthenticatedDurableApplicationGenerationAuthority();
    const value = host({
      lazyDurability: { ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY, publicationModeRequest },
    });
    const session = await value.openApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      createApplicationSessionResources: () => ({
        mutationPort: {} as HizoFSApplicationMutationPort,
        namespace: {
          list: async () => [],
          listBounded: async () => ({ entries: [], truncated: false }),
          readFile: async () => new Uint8Array(),
          readlink: async () => "target",
          stat: async () => ({
            createdAt: null,
            inodeNumber: 1n as never,
            inodeRevision: 1n as never,
            kind: "directory" as const,
            modifiedAt: null,
          }),
        },
        releaseResources,
        syncDurability: "not-demonstrated",
      }),
      observeAuthenticatedDurableAuthority: ({ verified }) => verified.durableAuthority,
      recheckAuthority,
      rootName: "application-root",
      verifyCapturedAuthority: async () => ({ durableAuthority }),
    });

    await expect(session.sync()).rejects.toMatchObject({
      code: "durability_not_demonstrated",
      implementation: "hizofs",
      retryable: false,
    });
    expect(recheckAuthority).toHaveBeenCalledOnce();
    await session.close();
    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it("closes a captured candidate admission factory when application resource construction fails", async () => {
    const resourceFailure = new Error("resource construction failed");
    let openAfterFailure: (() => unknown) | undefined;
    const value = host();

    await expect(value.openApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      createApplicationSessionResources: ({ openWorkingCandidateAdmission }) => {
        openAfterFailure = () => openWorkingCandidateAdmission({
          durableBaseIdentity: null as never,
          operationLabel: "leaked failed-open mutation",
        });
        throw resourceFailure;
      },
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => "verified",
    })).rejects.toBe(resourceFailure);

    expect(openAfterFailure).toBeDefined();
    expect(() => openAfterFailure?.()).toThrowError(expect.objectContaining({
      code: "admission_closed",
    }));
  });

  it("closes the session-scoped working-candidate admission factory with application resources", async () => {
    const releaseResources = vi.fn(async () => undefined);
    let openAfterClose: (() => unknown) | undefined;
    const value = host();
    const session = await value.openApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      createApplicationSessionResources: ({ openWorkingCandidateAdmission }) => {
        openAfterClose = () => openWorkingCandidateAdmission({
          durableBaseIdentity: null as never,
          operationLabel: "late mutation",
        });
        return {
          mutationPort: {} as HizoFSApplicationMutationPort,
          namespace: {
            list: async () => [],
            listBounded: async () => ({ entries: [], truncated: false }),
            readFile: async () => new Uint8Array(),
            readlink: async () => "target",
            stat: async () => ({
              createdAt: null,
              inodeNumber: 1n as never,
              inodeRevision: 1n as never,
              kind: "directory" as const,
              modifiedAt: null,
            }),
          },
          releaseResources,
          syncDurability: "demonstrated" as const,
        };
      },
      recheckAuthority: async () => undefined,
      rootName: "application-root",
      verifyCapturedAuthority: async () => "verified",
    });

    await session.close();
    expect(releaseResources).toHaveBeenCalledOnce();
    expect(openAfterClose).toBeDefined();
    expect(() => openAfterClose?.()).toThrowError(expect.objectContaining({
      code: "admission_closed",
    }));
  });

  it("projects sync authority recheck loss into the generic typed boundary", async () => {
    const releaseResources = vi.fn(async () => undefined);
    const authorityLoss = new Error("authority changed");
    const recheckAuthority = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(authorityLoss);
    const value = host();
    const session = await value.openApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      createApplicationSessionResources: () => ({
        mutationPort: {} as HizoFSApplicationMutationPort,
        namespace: {
          list: async () => [],
          listBounded: async () => ({ entries: [], truncated: false }),
          readFile: async () => new Uint8Array(),
          readlink: async () => "target",
          stat: async () => ({
            createdAt: null,
            inodeNumber: 1n as never,
            inodeRevision: 1n as never,
            kind: "directory" as const,
            modifiedAt: null,
          }),
        },
        releaseResources,
        syncDurability: "demonstrated",
      }),
      recheckAuthority,
      rootName: "application-root",
      verifyCapturedAuthority: async () => "verified",
    });

    await expect(session.sync()).rejects.toMatchObject({
      cause: authorityLoss,
      code: "authority_epoch_lost",
      implementation: "hizofs",
      retryable: false,
    });
    await session.close();
    expect(releaseResources).toHaveBeenCalledOnce();
  });
  it("exercises accepted-only success through the real worker application boundary", async () => {
    const durableAuthority = createTestingAuthenticatedDurableApplicationGenerationAuthority();
    let appliedMode: string | undefined;
    const mutationPort = {
      async createSymlink({ authority }: Parameters<HizoFSApplicationMutationPort["createSymlink"]>[0]) {
        authority.markCandidateAccepted();
      },
    } as HizoFSApplicationMutationPort;
    const value = host();
    const session = await value.openApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      createApplicationSessionResources: ({ authenticatedGeneration }) => {
        appliedMode = authenticatedGeneration?.publicationModeApplied();
        return {
          ...minimalApplicationResources(),
          mutationPort,
        };
      },
      observeAuthenticatedDurableAuthority: ({ verified }) => verified.durableAuthority,
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => ({ durableAuthority }),
    });

    expect(appliedMode).toBe("lazy_publication");
    await expect(session.root.createSymlink({ name: "accepted", target: "target" })).resolves.toMatchObject({
      kind: "symlink",
      name: "accepted",
    });
    await session.close();
  });

  it("requires durable publication for explicitly immediate mutations", async () => {
    const durableAuthority = createTestingAuthenticatedDurableApplicationGenerationAuthority();
    const mutationPort = {
      async createSymlink({ authority }: Parameters<HizoFSApplicationMutationPort["createSymlink"]>[0]) {
        authority.markCandidateAccepted();
      },
    } as HizoFSApplicationMutationPort;
    const session = await host({
      lazyDurability: {
        ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
        publicationModeRequest: "immediate",
      },
    }).openApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      createApplicationSessionResources: () => ({
        ...minimalApplicationResources(),
        mutationPort,
      }),
      observeAuthenticatedDurableAuthority: ({ verified }) => verified.durableAuthority,
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => ({ durableAuthority }),
    });

    await expect(session.root.createSymlink({ name: "unpublished", target: "target" }))
      .rejects.toMatchObject({ code: "commit_point_not_crossed" });
    await session.close();
  });

  it("maps publication timing to the required mutation success condition", () => {
    expect(TEST_ONLY.mutationSuccessConditionFromPublicationMode({
      mode: "immediate_publication",
    })).toBe("durable_publication");
    expect(TEST_ONLY.mutationSuccessConditionFromPublicationMode({
      mode: "lazy_publication",
    })).toBe("working_candidate_acceptance");
  });

});
