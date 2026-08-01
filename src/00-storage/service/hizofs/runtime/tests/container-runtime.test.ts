import { describe, expect, it } from "vitest";
import {
  createHomeRecordReference,
  createUInt64,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";
import { ContainerRuntime } from "@/00-storage/service/hizofs/runtime/container-runtime";
import type { CrossRealmLockMode, CrossRealmLockPort } from "@/00-storage/service/hizofs/runtime/cross-realm-lock-coordinator";
import { createContainerCoordinationScope, parseContainerCoordinationScopeToken } from "@/00-storage/service/hizofs/runtime/container-coordination-scope";
import { InMemoryCrossRealmLockPort } from "@/00-storage/service/hizofs/runtime/testing/in-memory-cross-realm-lock-port";

function commitReference({ offset }: { offset: bigint }) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    segmentId: parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 1) }),
  } });
}

function runtime({ crossRealmLockPort = new InMemoryCrossRealmLockPort() }: {
  crossRealmLockPort?: CrossRealmLockPort;
} = {}) {
  return new ContainerRuntime({
    crossRealmLockPort,
    limits: {
      maxDirectoryIteratorEntries: 32,
      maxHeldLockNames: 64,
      maxMaintenanceRootRegistrations: 64,
      maxReaderPins: 16,
      maxSegmentReferences: 16,
    },
    scope: createContainerCoordinationScope({
      token: parseContainerCoordinationScopeToken({ value: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE" }),
    }),
  });
}

class DelayedReaderPinReleasePort implements CrossRealmLockPort {
  #completion = Promise.withResolvers<void>();
  #inner = new InMemoryCrossRealmLockPort();

  async acquire({ mode, name }: {
    mode: CrossRealmLockMode;
    name: string;
  }) {
    const lease = await this.#inner.acquire({ mode, name });
    if (!name.includes("/reader-pin/")) return lease;
    return {
      release: () => lease.release(),
      released: Promise.all([lease.released, this.#completion.promise]).then(() => undefined),
    };
  }

  completeReaderPinRelease(): void {
    this.#completion.resolve();
  }

  async queryHeldLockNames(): Promise<readonly string[]> {
    return await this.#inner.queryHeldLockNames();
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("container runtime", () => {
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

});
