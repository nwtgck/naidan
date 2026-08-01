import { describe, expect, it, vi } from "vitest";
import type { HizoFSApplicationMutationPort } from "@/00-storage/service/hizofs/api";
import {
  createBrowserHizoFSWorkerRuntimeHost,
  HizoFSWorkerRuntimeHost,
  TEST_ONLY,
} from "@/00-storage/service/hizofs/worker/runtime-host";
import { createContainerCoordinationScope, parseContainerCoordinationScopeToken } from "@/00-storage/service/hizofs/runtime/container-coordination-scope";
import { InMemoryCrossRealmLockPort } from "@/00-storage/service/hizofs/runtime/testing/in-memory-cross-realm-lock-port";
import { createTestingHomeRecordReference } from "@/00-storage/service/hizofs/runtime/testing/home-record-reference-fixture";

function host() {
  return new HizoFSWorkerRuntimeHost({
    crossRealmLockPort: new InMemoryCrossRealmLockPort(),
    policy: {
      maxDirectoryIteratorEntries: 32,
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

function browserRequest(): LockManager["request"] {
  const request = async <T>(
    _name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    maybeCallback?: LockGrantedCallback<T>,
  ): Promise<Awaited<T>> => {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    if (callback === undefined) throw new Error("browser lock callback is required");
    return await callback(null);
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

  it("creates the worker runtime from the browser LockManager contract", async () => {
    const value = createBrowserHizoFSWorkerRuntimeHost({
      lockManager: {
        query: async () => ({ held: [] }),
        request: browserRequest(),
      },
      policy: {
        maxDirectoryIteratorEntries: 32,
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

  it("returns a narrow read API whose close drains the runtime session", async () => {
    const releaseResources = vi.fn(async () => undefined);
    const value = host();
    const api = await value.openReadApi({
      captureAuthority: async () => ({ revision: 1 }),
      createReadSessionResources: () => ({
        namespace: {
          readFile: async () => new Uint8Array([9]),
          readlink: async () => "target",
          stat: async () => ({
            createdAt: null,
            fileSize: 9_007_199_254_740_993n as never,
            inodeNumber: 1n as never,
            inodeRevision: 1n as never,
            kind: "file",
            modifiedAt: null,
          }),
        },
        releaseResources,
      }),
      recheckAuthority: async () => undefined,
      verifyCapturedAuthority: async () => "verified",
    });
    await expect(api.stat({ pathComponents: ["large"] })).resolves.toMatchObject({
      kind: "file",
      size: 9_007_199_254_740_993n,
    });
    await api.close();
    expect(releaseResources).toHaveBeenCalledOnce();
    await expect(api.readFile({ pathComponents: ["large"] })).rejects.toMatchObject({
      code: "capability_closed",
    });
  });


  it("opens a Naidan application session over the runtime authority handshake", async () => {
    const releaseResources = vi.fn(async () => undefined);
    const mutations: string[] = [];
    const mutationPort: HizoFSApplicationMutationPort = {
      async cloneFile({ authority }) {
        mutations.push("clone");
        authority.markCommitPointCrossed();
      },
      async createDirectory({ authority }) {
        mutations.push("mkdir");
        authority.markCommitPointCrossed();
      },
      async createFile({ authority }) {
        mutations.push("create-file");
        authority.markCommitPointCrossed();
      },
      async createSymlink({ authority }) {
        mutations.push("symlink");
        authority.markCommitPointCrossed();
      },
      async moveEntry({ authority }) {
        mutations.push("move");
        authority.markCommitPointCrossed();
      },
      async openWritable() {
        return {
          async abort() {
            mutations.push("abort");
          },
          async commit({ authority }) {
            mutations.push("commit");
            authority.markCommitPointCrossed();
          },
          async truncate() {
            mutations.push("truncate");
          },
          async write() {
            mutations.push("write");
          },
        };
      },
      async removeEntry({ authority }) {
        mutations.push("remove");
        authority.markCommitPointCrossed();
      },
    };
    const value = host();
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
      }),
      recheckAuthority: async () => undefined,
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
    await session.close();
    expect(releaseResources).toHaveBeenCalledOnce();
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
    await expect(snapshot.root.stat()).resolves.toEqual({
      createdAt: undefined,
      modifiedAt: undefined,
      size: 0,
    });
    await expect(snapshot.root.removeEntry({ name: "blocked", recursive: false }))
      .rejects.toThrow("HizoFS read snapshot cannot acquire a writer");

    await snapshot.close();
    const afterSnapshotClose = await value.beginMaintenanceRootCapture();
    expect(afterSnapshotClose.readerPinnedRoots).toEqual([]);
    afterSnapshotClose.release();
    await afterSnapshotClose.released;
    await session.close();
    expect(releaseResources).toHaveBeenCalledOnce();
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
    expect(capture.writerDependencyRoots).toEqual([]);
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
});
