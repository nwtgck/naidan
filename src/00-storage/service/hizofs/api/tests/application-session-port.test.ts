import { describe, expect, it, vi } from "vitest";

import {
  createFileOffset,
  createInodeNumber,
  createInodeRevision,
  createSubvolumeId,
  createTimestampMilliseconds,
} from "@/00-storage/service/hizofs/00-format";
import {
  createRuntimeBoundHizoFSApplicationSessionPort,
  type HizoFSApplicationMutationPort,
  type HizoFSApplicationPublicationAuthority,
  type HizoFSApplicationRuntimeSession,
  type HizoFSApplicationRuntimeWriter,
} from "@/00-storage/service/hizofs/api/application-session-port";
import { captureFileWriteBytes } from "@/00-storage/service/hizofs/filesystem/file/file-write-input";
import { createHizoFSStorageFileSystemSession } from "@/00-storage/service/hizofs/api/storage-file-system-session";
import { ReadOnlyNamespaceError, type ReadOnlyNamespace } from "@/00-storage/service/hizofs/filesystem/read-only-namespace";
import type { SessionOperationAuthority } from "@/00-storage/service/hizofs/runtime/session-lifecycle";

function namespace({ includeSubvolume = false }: {
  includeSubvolume?: boolean;
} = {}): ReadOnlyNamespace {
  const createdAt = createTimestampMilliseconds({ value: 10n });
  const modifiedAt = createTimestampMilliseconds({ value: 20n });
  return {
    list: vi.fn(async () => [
      {
        inodeKind: "file" as const,
        inodeNumber: createInodeNumber({ value: 2n }),
        name: "file",
        targetType: "inode" as const,
      },
      ...(includeSubvolume ? [{
        name: "mounted",
        subvolumeId: createSubvolumeId({ value: 8n }),
        targetType: "subvolume" as const,
      }] : []),
    ]),
    listAfterBounded: vi.fn(async ({ afterName }) => ({
      entries: afterName === undefined ? [{
        inodeKind: "file" as const,
        inodeNumber: createInodeNumber({ value: 2n }),
        name: "file",
        targetType: "inode" as const,
      }] : [],
      truncated: false,
    })),
    listBounded: vi.fn(async () => ({ entries: [], truncated: false })),
    readFile: vi.fn(async ({ length = 4n, offset = 0n }) => {
      const source = new Uint8Array([1, 2, 3, 4]);
      return source.slice(Number(offset), Number(offset + length));
    }),
    readlink: vi.fn(async () => "../target"),
    stat: vi.fn(async ({ pathComponents }) => {
      const name = pathComponents.at(-1) ?? "";
      if (name === "file") {
        return {
          createdAt,
          fileSize: createFileOffset({ value: 4n }),
          inodeNumber: createInodeNumber({ value: 2n }),
          inodeRevision: createInodeRevision({ value: 1n }),
          kind: "file" as const,
          modifiedAt,
        };
      }
      if (name === "link") {
        return {
          createdAt,
          inodeNumber: createInodeNumber({ value: 3n }),
          inodeRevision: createInodeRevision({ value: 1n }),
          kind: "symlink" as const,
          modifiedAt,
          symlinkTargetByteLength: 9,
        };
      }
      return {
        createdAt,
        inodeNumber: createInodeNumber({ value: 1n }),
        inodeRevision: createInodeRevision({ value: 1n }),
        kind: "directory" as const,
        modifiedAt,
      };
    }),
  };
}

function runtime(): Readonly<{
  calls: string[];
  session: HizoFSApplicationRuntimeSession;
  writers: HizoFSApplicationRuntimeWriter[];
}> {
  const calls: string[] = [];
  const writers: HizoFSApplicationRuntimeWriter[] = [];
  const session: HizoFSApplicationRuntimeSession = {
    async acquireWriter() {
      calls.push("acquire-writer");
      let crossed = false;
      const writer: HizoFSApplicationRuntimeWriter = {
        async close() {
          calls.push("close-writer");
        },
        async runPublication<Value>({ operation }: {
          operation: ({ authority }: { authority: SessionOperationAuthority }) => Promise<Value>;
        }): Promise<Value> {
          calls.push("run-publication");
          return await operation({ authority: {
            assertCapabilityReturnAllowed: () => undefined,
            assertPublicationAllowed: () => undefined,
            commitPointCrossed: () => crossed,
            markCommitPointCrossed: () => {
              crossed = true;
              calls.push("commit-point");
            },
          } });
        },
      };
      writers.push(writer);
      return writer;
    },
    async close() {
      calls.push("close-session");
    },
    async runReadOperation<Value>({ operation }: {
      operation: () => Promise<Value>;
    }): Promise<Value> {
      calls.push("read-operation");
      return await operation();
    },
  };
  return { calls, session, writers };
}

function mutationPort({ markCommitPoint = true }: {
  markCommitPoint?: boolean;
} = {}): Readonly<{
  calls: Array<readonly [string, unknown]>;
  port: HizoFSApplicationMutationPort;
}> {
  const calls: Array<readonly [string, unknown]> = [];
  const complete = ({ authority, name, request }: {
    authority: HizoFSApplicationPublicationAuthority;
    name: string;
    request: unknown;
  }) => {
    calls.push([name, request]);
    authority.assertPublicationAllowed();
    if (markCommitPoint) {
      authority.markCandidateAccepted();
      authority.markCommitPointCrossed();
    }
  };
  const port: HizoFSApplicationMutationPort = {
    async cloneFile(request) {
      complete({ authority: request.authority, name: "clone", request });
    },
    async createDirectory(request) {
      complete({ authority: request.authority, name: "mkdir", request });
    },
    async createFile(request) {
      complete({ authority: request.authority, name: "create-file", request });
    },
    async createSymlink(request) {
      complete({ authority: request.authority, name: "symlink", request });
    },
    async ensureDirectory(request) {
      complete({ authority: request.authority, name: "ensure-directory", request });
    },
    async ensureFile(request) {
      complete({ authority: request.authority, name: "ensure-file", request });
    },
    async moveEntry(request) {
      complete({ authority: request.authority, name: "move", request });
    },
    async openExplicitBulk(request) {
      calls.push(["open-explicit-bulk", request]);
      return {
        async abort({ reason }) {
          calls.push(["abort-explicit-bulk", reason]);
        },
        async commit({ authority }) {
          complete({ authority, name: "commit-explicit-bulk", request: undefined });
        },
        async createEmptyFile({ name }) {
          calls.push(["bulk-create-empty-file", name]);
        },
      };
    },
    async openWritable(request) {
      calls.push(["open-writable", request]);
      return {
        async read({ length, offset, signal }) {
          signal?.throwIfAborted();
          calls.push(["read-writable", { length, offset }]);
          return new Uint8Array(Number(length));
        },
        async abort({ reason }) {
          calls.push(["abort", reason]);
        },
        async commit({ authority }) {
          complete({ authority, name: "commit", request: undefined });
        },
        async truncate({ size }) {
          calls.push(["truncate", size]);
        },
        async write({ data, position }) {
          calls.push(["write", { data: [...data], position }]);
          return "returned_to_caller";
        },
      };
    },
    async removeEntry(request) {
      complete({ authority: request.authority, name: "remove", request });
    },
  };
  return { calls, port };
}

function createPort({ includeSubvolume = false, markCommitPoint = true }: {
  includeSubvolume?: boolean;
  markCommitPoint?: boolean;
} = {}) {
  const runtimeState = runtime();
  const mutations = mutationPort({ markCommitPoint });
  const sync = vi.fn(async () => undefined);
  return {
    mutations,
    port: createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      mutationPort: mutations.port,
      namespace: namespace({ includeSubvolume }),
      runtimeSession: runtimeState.session,
      sync,
    } }),
    runtimeState,
    sync,
  };
}

function openPrepared({ kind, port }: {
  kind: "bulk" | "writable";
  port: ReturnType<typeof createRuntimeBoundHizoFSApplicationSessionPort>;
}) {
  if (kind === "writable") return port.openWritable({ keepExistingData: true, path: ["file"] });
  if (port.openExplicitBulk === undefined) throw new Error("expected explicit bulk support");
  return port.openExplicitBulk({ path: ["target"] });
}

describe("runtime-bound HizoFS application session port", () => {
  it("forwards genuine page bounds and exclusive names without calling the full listing", async () => {
    const readNamespace = namespace();
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      mutationPort: mutationPort().port,
      namespace: readNamespace,
      runtimeSession: runtime().session,
      sync: async () => undefined,
    } });
    await expect(port.listDirectoryPage!({ afterName: "between", maximumEntries: 2, path: ["directory"] }))
      .resolves.toEqual({ entries: [], truncated: false });
    expect(readNamespace.listAfterBounded).toHaveBeenCalledExactlyOnceWith({ afterName: "between", maximumEntries: 2, pathComponents: ["directory"] });
    expect(readNamespace.list).not.toHaveBeenCalled();
    await port.close();
  });

  it("advertises paging only when the namespace has genuine bounded paging", async () => {
    const { listAfterBounded: _listAfterBounded, ...unpaged } = namespace();
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      mutationPort: mutationPort().port,
      namespace: unpaged,
      runtimeSession: runtime().session,
      sync: async () => undefined,
    } });
    expect(port.listDirectoryPage).toBeUndefined();
    await expect(port.listDirectory({ path: [] })).resolves.toEqual([{ kind: "file", name: "file" }]);
    expect(unpaged.list).toHaveBeenCalledOnce();
    await port.close();
  });

  it("projects immutable namespace reads through runtime close linearization", async () => {
    const { port, runtimeState } = createPort();

    await expect(port.listDirectory({ path: [] })).resolves.toEqual([{ kind: "file", name: "file" }]);
    if (port.listDirectoryPage === undefined) throw new Error("expected paged directory capability");
    await expect(port.listDirectoryPage({
      afterName: undefined,
      maximumEntries: 128,
      path: [],
    })).resolves.toEqual({ entries: [{ kind: "file", name: "file" }], truncated: false });
    await expect(port.stat({ path: ["file"] })).resolves.toEqual({
      createdAt: 10n,
      kind: "file",
      modifiedAt: 20n,
      size: 4n,
    });
    await expect(port.stat({ path: ["link"] })).resolves.toEqual({
      createdAt: 10n,
      kind: "symlink",
      modifiedAt: 20n,
      size: 9n,
    });
    const readable = await port.openReadable({ path: ["file"] });
    await expect(readable.read({ length: 2n, offset: 1n, signal: undefined }))
      .resolves.toEqual(new Uint8Array([2, 3]));

    expect(runtimeState.calls.filter(value => value === "read-operation")).toHaveLength(6);
    await port.close();
    await expect(port.stat({ path: [] })).rejects.toMatchObject({ code: "session_closed" });
    await expect(readable.read({ length: 2n, offset: 1n, signal: undefined }))
      .rejects.toMatchObject({ code: "session_closed" });
    await readable.close();
  });

  it("preserves file sizes and read offsets beyond Number precision", async () => {
    const runtimeState = runtime();
    const fileSize = 9_007_199_254_741_003n;
    const offset = 9_007_199_254_740_993n;
    const source = new Uint8Array([7, 9]);
    const readFile = vi.fn<ReadOnlyNamespace["readFile"]>(async () => source);
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      mutationPort: mutationPort().port,
      namespace: {
        ...namespace(),
        readFile,
        stat: async () => ({
          createdAt: createTimestampMilliseconds({ value: 11n }),
          fileSize: createFileOffset({ value: fileSize }),
          inodeNumber: createInodeNumber({ value: 2n }),
          inodeRevision: createInodeRevision({ value: 1n }),
          kind: "file",
          modifiedAt: createTimestampMilliseconds({ value: 13n }),
        }),
      },
      runtimeSession: runtimeState.session,
      sync: async () => undefined,
    } });

    await expect(port.stat({ path: ["large"] })).resolves.toEqual({
      createdAt: 11n,
      kind: "file",
      modifiedAt: 13n,
      size: fileSize,
    });
    const path = ["large"];
    const readable = await port.openReadable({ path });
    path[0] = "changed";
    expect(readable.size).toBe(fileSize);
    const bytes = await readable.read({ length: 2n, offset, signal: undefined });
    expect(readFile).toHaveBeenCalledExactlyOnceWith({ length: 2n, offset, pathComponents: ["large"] });
    expect(bytes).toEqual(source);
    expect(bytes).not.toBe(source);
    expect(runtimeState.calls.filter(value => value === "read-operation")).toHaveLength(3);
    await readable.close();
    await port.close();
  });

  it("uses zero for directory size and preserves absent timestamps", async () => {
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      mutationPort: mutationPort().port,
      namespace: {
        ...namespace(),
        stat: async () => ({
          createdAt: null,
          inodeNumber: createInodeNumber({ value: 1n }),
          inodeRevision: createInodeRevision({ value: 1n }),
          kind: "directory",
          modifiedAt: null,
        }),
      },
      runtimeSession: runtime().session,
      sync: async () => undefined,
    } });

    await expect(port.stat({ path: [] })).resolves.toEqual({
      createdAt: undefined,
      kind: "directory",
      modifiedAt: undefined,
      size: 0n,
    });
    await port.close();
  });

  it.each([
    ["../target", 9],
    ["\u00e9/path", 7],
    ["\ufeffx", 4],
    ["x\u{1f680}", 5],
  ] as const)("reports symlink size from one stat projection without reading the target again: %s", async (target, byteLength) => {
    const runtimeState = runtime();
    const sourceNamespace = namespace();
    const projected = await sourceNamespace.stat({ pathComponents: ["link"] });
    const stat = vi.fn(async () => ({ ...projected, symlinkTargetByteLength: byteLength }));
    const readlink = vi.fn(async () => target);
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      mutationPort: mutationPort().port,
      namespace: {
        ...sourceNamespace,
        readlink,
        stat,
      },
      runtimeSession: runtimeState.session,
      sync: async () => undefined,
    } });

    await expect(port.stat({ path: ["link"] })).resolves.toEqual({
      createdAt: 10n,
      kind: "symlink",
      modifiedAt: 20n,
      size: BigInt(byteLength),
    });
    expect(stat).toHaveBeenCalledExactlyOnceWith({ pathComponents: ["link"] });
    expect(readlink).not.toHaveBeenCalled();
    await expect(port.readlink({ path: ["link"] })).resolves.toBe(target);
    expect(readlink).toHaveBeenCalledExactlyOnceWith({ pathComponents: ["link"] });
    expect(runtimeState.calls.filter(value => value === "read-operation")).toHaveLength(2);
    await port.close();
  });

  it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid symlink target byte-length projection: %s",
    async symlinkTargetByteLength => {
      const sourceNamespace = namespace();
      const projected = await sourceNamespace.stat({ pathComponents: ["link"] });
      const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
        mutationPort: mutationPort().port,
        namespace: {
          ...sourceNamespace,
          stat: async () => ({ ...projected, symlinkTargetByteLength }),
        },
        runtimeSession: runtime().session,
        sync: async () => undefined,
      } });

      await expect(port.stat({ path: ["link"] })).rejects.toThrow("target byte length");
      expect(sourceNamespace.readlink).not.toHaveBeenCalled();
      await port.close();
    },
  );


  it("binds readable size and bytes to one captured working namespace", async () => {
    const runtimeState = runtime();
    const mutations = mutationPort();
    const liveNamespace = namespace();
    const stableNamespace: ReadOnlyNamespace = {
      ...namespace(),
      readFile: vi.fn(async ({ length = 4n, offset = 0n }) => {
        const source = new Uint8Array([9, 8, 7, 6]);
        return source.slice(Number(offset), Number(offset + length));
      }),
    };
    const release = vi.fn();
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      captureStableReadNamespace: () => ({ namespace: stableNamespace, release }),
      mutationPort: mutations.port,
      namespace: liveNamespace,
      runtimeSession: runtimeState.session,
      sync: async () => undefined,
    } });

    const readable = await port.openReadable({ path: ["file"] });
    await expect(readable.read({ length: 4n, offset: 0n, signal: undefined }))
      .resolves.toEqual(new Uint8Array([9, 8, 7, 6]));
    expect(readable.size).toBe(4n);
    expect(stableNamespace.stat).toHaveBeenCalledTimes(1);
    expect(liveNamespace.stat).not.toHaveBeenCalled();

    await readable.close();
    await readable.close();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure", "abort"] as const)("retains a readable capture until every admitted read settles with %s", async outcome => {
    const firstRead = Promise.withResolvers<Uint8Array>();
    const secondRead = Promise.withResolvers<Uint8Array>();
    const readFile = vi.fn<ReadOnlyNamespace["readFile"]>()
      .mockImplementationOnce(async () => await firstRead.promise)
      .mockImplementationOnce(async () => await secondRead.promise);
    const capturedNamespace = { ...namespace(), readFile };
    const release = vi.fn();
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      captureStableReadNamespace: () => ({ namespace: capturedNamespace, release }),
      mutationPort: mutationPort().port,
      namespace: namespace(),
      runtimeSession: runtime().session,
      sync: async () => undefined,
    } });
    const readable = await port.openReadable({ path: ["file"] });
    const aborted = new AbortController();
    aborted.abort();
    await expect(readable.read({ length: 1n, offset: 0n, signal: aborted.signal }))
      .rejects.toBe(aborted.signal.reason);
    expect(readFile).not.toHaveBeenCalled();

    const first = readable.read({ length: 1n, offset: 0n, signal: undefined });
    const second = readable.read({ length: 1n, offset: 1n, signal: undefined });
    const secondOutcome = second.then(value => ({ value }), cause => ({ cause }));
    let settledCloses = 0;
    const closing = readable.close().then(() => {
      settledCloses += 1;
    });
    const repeatedClose = readable.close().then(() => {
      settledCloses += 1;
    });
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();
    expect(settledCloses).toBe(0);
    await expect(readable.read({ length: 1n, offset: 0n, signal: undefined }))
      .rejects.toMatchObject({ code: "session_closed" });

    firstRead.resolve(Uint8Array.of(1));
    await expect(first).resolves.toEqual(Uint8Array.of(1));
    expect(release).not.toHaveBeenCalled();
    expect(settledCloses).toBe(0);
    switch (outcome) {
    case "success":
      secondRead.resolve(Uint8Array.of(2));
      await expect(secondOutcome).resolves.toEqual({ value: Uint8Array.of(2) });
      break;
    case "failure":
    case "abort": {
      const failure = outcome === "abort" ? new DOMException("read aborted", "AbortError") : new Error("read failed");
      secondRead.reject(failure);
      await expect(secondOutcome).resolves.toEqual({ cause: failure });
      break;
    }
    default: outcome satisfies never;
    }
    await Promise.all([closing, repeatedClose]);
    expect(settledCloses).toBe(2);
    expect(release).toHaveBeenCalledOnce();
    await readable.close();
    expect(release).toHaveBeenCalledOnce();
    await port.close();
  });

  it("shares a readable release failure across close calls without releasing twice", async () => {
    const failure = new Error("stable readable release failed");
    const release = vi.fn(() => {
      throw failure;
    });
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      captureStableReadNamespace: () => ({ namespace: namespace(), release }),
      mutationPort: mutationPort().port,
      namespace: namespace(),
      runtimeSession: runtime().session,
      sync: async () => undefined,
    } });
    const readable = await port.openReadable({ path: ["file"] });
    const outcomes = await Promise.allSettled([readable.close(), readable.close()]);
    expect(outcomes).toEqual([
      { reason: failure, status: "rejected" },
      { reason: failure, status: "rejected" },
    ]);
    await expect(readable.close()).rejects.toBe(failure);
    expect(release).toHaveBeenCalledOnce();
    await port.close();
  });

  it("stops a queued public stream pull when readable close begins synchronously", async () => {
    const capturedNamespace = namespace();
    const release = vi.fn();
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      captureStableReadNamespace: () => ({ namespace: capturedNamespace, release }),
      mutationPort: mutationPort().port,
      namespace: capturedNamespace,
      runtimeSession: runtime().session,
      sync: async () => undefined,
    } });
    const session = createHizoFSStorageFileSystemSession({ port });
    const file = await session.root.getFileHandle({ create: false, name: "file" });
    const readable = await file.openReadable({ mimeType: "application/octet-stream" });
    const stream = readable.stream({ end: undefined, signal: undefined, start: 0 });
    const closing = readable.close();
    const streamReader = stream.getReader();
    try {
      await expect(streamReader.read()).rejects.toMatchObject({ code: "session_closed" });
      expect(capturedNamespace.readFile).not.toHaveBeenCalled();
      await closing;
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await streamReader.cancel().catch(() => undefined);
      await closing;
      await session.close();
    }
  });

  it("projects private missing-entry failures into the shared storage boundary", async () => {
    const runtimeState = runtime();
    const missingNamespace: ReadOnlyNamespace = {
      ...namespace(),
      stat: vi.fn(async () => {
        throw new ReadOnlyNamespaceError({ code: "not_found", message: "path component does not exist" });
      }),
    };
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      mutationPort: mutationPort().port,
      namespace: missingNamespace,
      runtimeSession: runtimeState.session,
      sync: async () => undefined,
    } });

    await expect(port.stat({ path: ["missing"] })).rejects.toMatchObject({
      name: "NotFoundError",
      message: "NotFoundError: path component does not exist",
    });
    await port.close();
  });

  it("rejects subvolume mounts until the topology resolver is composed", async () => {
    const { port } = createPort({ includeSubvolume: true });
    await expect(port.listDirectory({ path: [] })).rejects.toMatchObject({
      code: "subvolume_boundary",
    });
  });

  it("serializes mutations through the runtime writer and requires a durable commit point", async () => {
    const { mutations, port, runtimeState } = createPort();
    await port.createFile({ name: "next", path: ["parent"] });

    expect(runtimeState.calls).toEqual([
      "acquire-writer",
      "run-publication",
      "commit-point",
      "close-writer",
    ]);
    expect(mutations.calls[0]?.[0]).toBe("create-file");
  });

  it("accepts an explicitly resolved no-change mutation without claiming durable publication", async () => {
    const runtimeState = runtime();
    const mutations = mutationPort({ markCommitPoint: false });
    mutations.port.moveEntry = async ({ authority, ...request }) => {
      mutations.calls.push(["move-no-change", request]);
      authority.markNoChangeResolved();
    };
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      mutationPort: mutations.port,
      namespace: namespace(),
      runtimeSession: runtimeState.session,
      sync: async () => undefined,
    } });

    await port.moveEntry({
      destinationPath: ["same"],
      name: "entry",
      newName: "entry",
      path: ["same"],
      replace: false,
    });

    expect(runtimeState.calls).toEqual([
      "acquire-writer",
      "run-publication",
      "close-writer",
    ]);
    expect(mutations.calls[0]?.[0]).toBe("move-no-change");
  });

  it("accepts an atomic ensure no-change result without claiming durable publication", async () => {
    const runtimeState = runtime();
    const mutations = mutationPort({ markCommitPoint: false });
    mutations.port.ensureFile = async ({ authority, ...request }) => {
      mutations.calls.push(["ensure-file-no-change", request]);
      authority.markNoChangeResolved();
    };
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      mutationPort: mutations.port,
      namespace: namespace(),
      runtimeSession: runtimeState.session,
      sync: async () => undefined,
    } });

    await port.ensureFile({ name: "existing.txt", path: ["parent"] });

    expect(runtimeState.calls).toEqual([
      "acquire-writer",
      "run-publication",
      "close-writer",
    ]);
    expect(mutations.calls).toEqual([
      ["ensure-file-no-change", { name: "existing.txt", path: ["parent"] }],
    ]);
  });

  it("rejects a durable commit point that has no accepted working candidate", async () => {
    const runtimeState = runtime();
    const mutations = mutationPort({ markCommitPoint: false });
    mutations.port.createFile = async ({ authority }) => {
      authority.markCommitPointCrossed();
    };
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      mutationPort: mutations.port,
      namespace: namespace(),
      runtimeSession: runtimeState.session,
      sync: async () => undefined,
    } });

    await expect(port.createFile({ name: "invalid", path: [] }))
      .rejects.toThrow("before accepting a working candidate");
    expect(runtimeState.calls.at(-1)).toBe("close-writer");
  });

  it("tracks working-candidate acceptance separately and still requires durable publication", async () => {
    const runtimeState = runtime();
    const mutations = mutationPort({ markCommitPoint: false });
    mutations.port.createDirectory = async ({ authority, ...request }) => {
      mutations.calls.push(["mkdir-accepted", request]);
      expect(authority.candidateAccepted()).toBe(false);
      expect(authority.commitPointCrossed()).toBe(false);
      authority.markCandidateAccepted();
      expect(authority.candidateAccepted()).toBe(true);
      expect(authority.commitPointCrossed()).toBe(false);
    };
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      mutationPort: mutations.port,
      namespace: namespace(),
      runtimeSession: runtimeState.session,
      sync: async () => undefined,
    } });

    await expect(port.createDirectory({ name: "accepted-only", path: [] })).rejects.toMatchObject({
      code: "commit_point_not_crossed",
      message: expect.stringContaining("working-candidate acceptance"),
    });
    expect(runtimeState.calls.at(-1)).toBe("close-writer");
  });

  it("allows accepted-only success when the runtime applied lazy publication", async () => {
    const runtimeState = runtime();
    const mutations = mutationPort({ markCommitPoint: false });
    mutations.port.createDirectory = async ({ authority, ...request }) => {
      mutations.calls.push(["mkdir-lazy-accepted", request]);
      authority.markCandidateAccepted();
    };
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      mutationPort: mutations.port,
      mutationSuccessCondition: "working_candidate_acceptance",
      namespace: namespace(),
      runtimeSession: runtimeState.session,
      sync: async () => undefined,
    } });

    await expect(port.createDirectory({ name: "accepted-only", path: [] })).resolves.toBeUndefined();
    expect(runtimeState.calls).toEqual([
      "acquire-writer",
      "run-publication",
      "close-writer",
    ]);
  });

  it("allows an accepted working candidate to advance to the durable commit point", async () => {
    const runtimeState = runtime();
    const mutations = mutationPort({ markCommitPoint: false });
    mutations.port.createFile = async ({ authority, ...request }) => {
      mutations.calls.push(["create-file-accepted", request]);
      authority.markCandidateAccepted();
      authority.markCommitPointCrossed();
      expect(authority.candidateAccepted()).toBe(true);
      expect(authority.commitPointCrossed()).toBe(true);
    };
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      mutationPort: mutations.port,
      namespace: namespace(),
      runtimeSession: runtimeState.session,
      sync: async () => undefined,
    } });

    await expect(port.createFile({ name: "durable", path: [] })).resolves.toBeUndefined();
    expect(runtimeState.calls).toEqual([
      "acquire-writer",
      "run-publication",
      "commit-point",
      "close-writer",
    ]);
  });

  it("rejects no-change or duplicate acceptance after a working candidate is installed", async () => {
    const runtimeState = runtime();
    const mutations = mutationPort({ markCommitPoint: false });
    mutations.port.createDirectory = async ({ authority }) => {
      authority.markCandidateAccepted();
      expect(() => authority.markCandidateAccepted()).toThrow("more than one working candidate");
      expect(() => authority.markNoChangeResolved()).toThrow("after accepting a working candidate");
      authority.markCommitPointCrossed();
    };
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      mutationPort: mutations.port,
      namespace: namespace(),
      runtimeSession: runtimeState.session,
      sync: async () => undefined,
    } });

    await expect(port.createDirectory({ name: "candidate", path: [] })).resolves.toBeUndefined();
  });

  it("fails closed when a mutation returns before marking the publication commit point", async () => {
    const { port, runtimeState } = createPort({ markCommitPoint: false });
    await expect(port.createDirectory({ name: "unsafe", path: [] })).rejects.toEqual(
      expect.objectContaining({ code: "commit_point_not_crossed" }),
    );
    expect(runtimeState.calls.at(-1)).toBe("close-writer");
  });

  it("holds the cross-realm writer until an explicit bulk commit resolves", async () => {
    const { mutations, port, runtimeState } = createPort();
    const openExplicitBulk = port.openExplicitBulk;
    if (openExplicitBulk === undefined) throw new Error("test mutation port omitted explicit bulk support");
    const builder = await openExplicitBulk({ path: ["target"] });
    expect(runtimeState.calls).toEqual(["acquire-writer"]);

    await builder.createEmptyFile({ name: "first" });
    await builder.commit();

    expect(mutations.calls).toContainEqual(["bulk-create-empty-file", "first"]);
    expect(runtimeState.calls).toEqual([
      "acquire-writer",
      "run-publication",
      "commit-point",
      "close-writer",
    ]);
    await expect(builder.abort({ reason: "late" })).rejects.toMatchObject({ code: "session_closed" });
  });

  it("fails closed and aborts the prepared bulk authority when commit resolution fails", async () => {
    const { mutations, port, runtimeState } = createPort({ markCommitPoint: false });
    const openExplicitBulk = port.openExplicitBulk;
    if (openExplicitBulk === undefined) throw new Error("test mutation port omitted explicit bulk support");
    const builder = await openExplicitBulk({ path: [] });

    await expect(builder.commit()).rejects.toMatchObject({ code: "commit_point_not_crossed" });
    expect(mutations.calls.map(([name]) => name)).toContain("abort-explicit-bulk");
    expect(runtimeState.calls.at(-1)).toBe("close-writer");
  });

  it("fails closed and aborts the prepared writable authority when commit resolution fails", async () => {
    const { mutations, port, runtimeState } = createPort({ markCommitPoint: false });
    const writable = await port.openWritable({ keepExistingData: true, path: ["file"] });

    await expect(writable.commit()).rejects.toMatchObject({ code: "commit_point_not_crossed" });
    expect(mutations.calls.map(([name]) => name)).toContain("abort");
    expect(runtimeState.calls.at(-1)).toBe("close-writer");
  });

  it.each([
    ["bulk", "working_candidate_acceptance", "accepted"],
    ["bulk", "durable_publication", "accepted"],
    ["bulk", "working_candidate_acceptance", "no_change"],
    ["bulk", "durable_publication", "no_change"],
    ["writable", "working_candidate_acceptance", "accepted"],
    ["writable", "durable_publication", "accepted"],
    ["writable", "working_candidate_acceptance", "no_change"],
    ["writable", "durable_publication", "no_change"],
  ] as const)("applies %s %s policy to %s prepared completion", async (kind, condition, resolution) => {
    const runtimeState = runtime();
    const mutations = mutationPort();
    const abort = vi.fn(async () => undefined);
    vi.spyOn(mutations.port, kind === "bulk" ? "openExplicitBulk" : "openWritable").mockResolvedValue({
      abort,
      async commit({ authority }: { authority: HizoFSApplicationPublicationAuthority }) {
        if (resolution === "accepted") authority.markCandidateAccepted();
        else authority.markNoChangeResolved();
      },
      createEmptyFile: async () => undefined,
      truncate: async () => undefined,
      write: async () => "returned_to_caller" as const,
    });
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      mutationPort: mutations.port,
      mutationSuccessCondition: condition,
      namespace: namespace(),
      runtimeSession: runtimeState.session,
      sync: async () => undefined,
    } });
    const prepared = await openPrepared({ kind, port });
    if (condition === "durable_publication" && resolution === "accepted") {
      await expect(prepared.commit()).rejects.toMatchObject({
        code: "commit_point_not_crossed",
        message: expect.stringContaining(kind === "bulk" ? "explicit bulk commit" : "file commit"),
      });
      expect(abort).toHaveBeenCalledOnce();
    } else {
      await expect(prepared.commit()).resolves.toBeUndefined();
      expect(abort).not.toHaveBeenCalled();
    }
    expect(runtimeState.calls).toEqual(["acquire-writer", "run-publication", "close-writer"]);
  });

  it("preserves writable commit and prepared-abort failures in order", async () => {
    const runtimeState = runtime();
    const mutations = mutationPort();
    const commitFailure = new Error("prepared writable commit failed");
    const abortFailure = new Error("prepared writable abort failed");
    mutations.port.openWritable = async request => {
      mutations.calls.push(["open-writable-failing-cleanup", request]);
      return {
        async read() {
          throw new Error("unused read");
        },
        async abort() {
          throw abortFailure;
        },
        async commit() {
          throw commitFailure;
        },
        async truncate() {
          throw new Error("unused truncate");
        },
        async write() {
          throw new Error("unused write");
        },
      };
    };
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      mutationPort: mutations.port,
      namespace: namespace(),
      runtimeSession: runtimeState.session,
      sync: async () => undefined,
    } });
    const writable = await port.openWritable({ keepExistingData: true, path: ["file"] });

    let thrown: unknown;
    try {
      await writable.commit();
    } catch (cause: unknown) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([commitFailure, abortFailure]);
    expect(runtimeState.calls.at(-1)).toBe("close-writer");
  });

  describe.each(["success", "failure"] as const)("undefined primary with writer cleanup %s", cleanupOutcome => {
    it.each([
      ["ordinary", "mutation"],
      ["bulk", "commit"],
      ["bulk", "abort"],
      ["bulk", "open"],
      ["writable", "commit"],
      ["writable", "abort"],
      ["writable", "open"],
    ] as const)("preserves %s %s rejection and cleanup order", async (kind, phase) => {
      const runtimeState = runtime();
      const mutations = mutationPort();
      const cleanupFailure = new Error("writer cleanup failed");
      const close = vi.fn(async () => {
        runtimeState.calls.push("close-writer");
        if (cleanupOutcome === "failure") throw cleanupFailure;
      });
      const acquireWriter = runtimeState.session.acquireWriter;
      vi.spyOn(runtimeState.session, "acquireWriter").mockImplementation(async () => {
        const writer = await acquireWriter();
        writer.close = close;
        return writer;
      });
      const fail = vi.fn(async () => {
        throw undefined;
      });
      const abort = vi.fn(async () => {
        if (phase === "abort") await fail();
      });
      if (kind === "ordinary") {
        vi.spyOn(mutations.port, "createFile").mockImplementation(fail);
      } else {
        const open = vi.spyOn(mutations.port, kind === "bulk" ? "openExplicitBulk" : "openWritable");
        if (phase === "open") {
          open.mockImplementation(fail);
        } else {
          open.mockResolvedValue({
            abort,
            commit: fail,
            createEmptyFile: async () => undefined,
            truncate: async () => undefined,
            write: async () => "returned_to_caller" as const,
          });
        }
      }
      const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
        mutationPort: mutations.port,
        namespace: namespace(),
        runtimeSession: runtimeState.session,
        sync: async () => undefined,
      } });
      let operation: () => Promise<unknown>;
      if (kind === "ordinary") {
        operation = async () => await port.createFile({ name: "file", path: [] });
      } else {
        if (phase === "open") {
          operation = async () => await openPrepared({ kind, port });
        } else {
          const prepared = await openPrepared({ kind, port });
          operation = phase === "abort"
            ? async () => await prepared.abort({ reason: "test cancellation" })
            : async () => await prepared.commit();
        }
      }

      const [outcome] = await Promise.allSettled([operation()]);
      if (cleanupOutcome === "success") {
        expect(outcome).toEqual({ status: "rejected", reason: undefined });
      } else {
        expect(outcome.status).toBe("rejected");
        if (outcome.status !== "rejected") throw new Error("expected rejected operation");
        expect(outcome.reason).toBeInstanceOf(AggregateError);
        expect((outcome.reason as AggregateError).errors).toEqual([undefined, cleanupFailure]);
      }
      expect(fail).toHaveBeenCalledOnce();
      expect(abort).toHaveBeenCalledTimes(phase === "commit" || phase === "abort" ? 1 : 0);
      expect(close).toHaveBeenCalledOnce();
      expect(runtimeState.calls.at(-1)).toBe("close-writer");
    });
  });

  it("aborts open explicit bulk builders before closing the runtime session", async () => {
    const { mutations, port, runtimeState } = createPort();
    const openExplicitBulk = port.openExplicitBulk;
    if (openExplicitBulk === undefined) throw new Error("test mutation port omitted explicit bulk support");
    await openExplicitBulk({ path: [] });
    await port.close();

    expect(mutations.calls.map(([name]) => name)).toContain("abort-explicit-bulk");
    expect(runtimeState.calls.slice(-2)).toEqual(["close-writer", "close-session"]);
  });

  it("preserves captured write bytes when the prepared writable consumes ownership", async () => {
    const { mutations, port } = createPort();
    let retained: Uint8Array | undefined;
    mutations.port.openWritable = async () => ({
      async read() {
        throw new Error("unused read");
      },
      async abort() {
        retained?.fill(0);
      },
      async commit({ authority }) {
        authority.markCandidateAccepted();
        authority.markCommitPointCrossed();
        retained?.fill(0);
      },
      async truncate() {
        return;
      },
      async write({ data }) {
        retained = data;
        return "consumed";
      },
    });
    const writable = await port.openWritable({ keepExistingData: true, path: ["file"] });
    const captured = captureFileWriteBytes({ bytes: Uint8Array.of(7, 8, 9) });

    await writable.write({ data: captured, position: 0n });
    expect(retained).toBe(captured);
    expect([...captured]).toEqual([7, 8, 9]);

    await writable.abort({ reason: "test cleanup" });
    expect([...captured]).toEqual([0, 0, 0]);
  });

  it("rejects same-session writer operations while a prepared writable owns the writer", async () => {
    const { mutations, port, runtimeState } = createPort();
    const writable = await port.openWritable({ keepExistingData: true, path: ["file"] });

    await expect(port.createDirectory({ name: "blocked", path: [] })).rejects.toMatchObject({
      code: "operation_in_progress",
    });
    await expect(port.openWritable({ keepExistingData: true, path: ["other"] })).rejects.toMatchObject({
      code: "operation_in_progress",
    });
    await expect(port.moveEntry({
      destinationPath: [],
      name: "file",
      newName: "renamed",
      path: [],
      replace: false,
    })).rejects.toMatchObject({ code: "operation_in_progress" });
    await expect(port.removeEntry({ name: "file", path: [], recursive: false }))
      .rejects.toMatchObject({ code: "operation_in_progress" });
    await expect(port.cloneFile({
      destinationPath: [],
      name: "other",
      newName: "file",
      path: [],
      replace: true,
    })).rejects.toMatchObject({ code: "operation_in_progress" });
    expect(mutations.calls.map(([name]) => name)).toEqual(["open-writable"]);
    expect(runtimeState.calls).toEqual(["acquire-writer"]);

    await writable.abort({ reason: "release same-session writer" });
    await expect(port.createDirectory({ name: "after-release", path: [] })).resolves.toBeUndefined();
    expect(runtimeState.calls).toEqual([
      "acquire-writer",
      "close-writer",
      "acquire-writer",
      "run-publication",
      "commit-point",
      "close-writer",
    ]);
  });

  it.each([
    ["writable", "writable"],
    ["writable", "bulk"],
    ["bulk", "writable"],
    ["bulk", "bulk"],
  ] as const)("reserves a pending %s before a concurrent %s can acquire the writer", async (firstKind, secondKind) => {
    const { port, runtimeState } = createPort();
    const first = openPrepared({ kind: firstKind, port });
    const second = openPrepared({ kind: secondKind, port });
    const mutationResult = port.createDirectory({ name: "blocked", path: [] }).catch(cause => cause);
    const results = await Promise.allSettled([first, second]);
    for (const result of results) {
      if (result.status === "fulfilled") await result.value.abort({ reason: "test cleanup" });
    }

    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "operation_in_progress" } });
    await expect(mutationResult).resolves.toMatchObject({ code: "operation_in_progress" });
    expect(runtimeState.calls.filter(call => call === "acquire-writer")).toHaveLength(1);
    await expect(port.createDirectory({ name: "after-release", path: [] })).resolves.toBeUndefined();
  });

  it.each(["writable", "bulk"] as const)("releases the %s opening reservation after acquisition or preparation fails", async kind => {
    const mutations = mutationPort();
    const runtimeState = runtime();
    const preparationFailure = new Error("preparation failed");
    vi.spyOn(mutations.port, kind === "bulk" ? "openExplicitBulk" : "openWritable")
      .mockRejectedValueOnce(preparationFailure);
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      mutationPort: mutations.port,
      namespace: namespace(),
      runtimeSession: runtimeState.session,
      sync: async () => undefined,
    } });
    const acquisitionFailure = new Error("writer acquisition failed");
    vi.spyOn(runtimeState.session, "acquireWriter").mockRejectedValueOnce(acquisitionFailure);
    await expect(openPrepared({ kind, port })).rejects.toBe(acquisitionFailure);

    await expect(openPrepared({ kind, port })).rejects.toBe(preparationFailure);

    const prepared = await openPrepared({ kind, port });
    await prepared.abort({ reason: "test cleanup" });
    await expect(port.createDirectory({ name: "after-failure", path: [] })).resolves.toBeUndefined();
    expect(runtimeState.calls.filter(call => call === "close-writer")).toHaveLength(3);
  });

  it("keeps reads available during prepared opening and permits concurrent ordinary mutations", async () => {
    const { port } = createPort();
    const opening = port.openWritable({ keepExistingData: true, path: ["file"] });
    await expect(Promise.all([
      port.stat({ path: ["file"] }),
      port.listDirectory({ path: [] }),
    ])).resolves.toHaveLength(2);
    await (await opening).abort({ reason: "test cleanup" });

    await expect(Promise.all([
      port.createDirectory({ name: "first", path: [] }),
      port.createDirectory({ name: "second", path: [] }),
    ])).resolves.toEqual([undefined, undefined]);
  });

  it("rejects same-session writer operations while an explicit bulk builder owns the writer", async () => {
    const { port, runtimeState } = createPort();
    const openExplicitBulk = port.openExplicitBulk;
    if (openExplicitBulk === undefined) throw new Error("test mutation port omitted explicit bulk support");
    const builder = await openExplicitBulk({ path: ["target"] });

    await expect(port.createFile({ name: "blocked", path: [] })).rejects.toMatchObject({
      code: "operation_in_progress",
    });
    await expect(openExplicitBulk({ path: ["other"] })).rejects.toMatchObject({
      code: "operation_in_progress",
    });
    expect(runtimeState.calls).toEqual(["acquire-writer"]);

    await builder.abort({ reason: "release same-session writer" });
  });

  it("holds the cross-realm writer until writable commit or abort", async () => {
    const { mutations, port, runtimeState } = createPort();
    const writable = await port.openWritable({ keepExistingData: true, path: ["file"] });
    expect(runtimeState.calls).toEqual(["acquire-writer"]);

    const bytes = new Uint8Array([7, 8]);
    await writable.write({ data: captureFileWriteBytes({ bytes }), position: 2n });
    bytes.fill(0);
    await writable.truncate({ size: 9n });
    await expect(writable.read({ length: 2n, offset: 1n, signal: undefined })).resolves.toEqual(new Uint8Array(2));
    expect(mutations.calls).toContainEqual(["read-writable", { length: 2n, offset: 1n }]);
    expect(runtimeState.calls).toEqual(["acquire-writer"]);
    await writable.commit();

    expect(mutations.calls).toContainEqual(["write", { data: [7, 8], position: 2n }]);
    expect(runtimeState.calls).toEqual([
      "acquire-writer",
      "run-publication",
      "commit-point",
      "close-writer",
    ]);
    await expect(writable.abort({ reason: "late" })).rejects.toMatchObject({ code: "session_closed" });
  });

  it("makes prepared writable abort terminal without publishing", async () => {
    const { mutations, port, runtimeState } = createPort();
    const writable = await port.openWritable({ keepExistingData: true, path: ["file"] });

    await writable.abort({ reason: "discard prepared mutation" });
    await expect(writable.commit()).rejects.toMatchObject({ code: "session_closed" });
    await expect(writable.truncate({ size: 0n })).rejects.toMatchObject({ code: "session_closed" });
    await expect(writable.read({ length: 0n, offset: 0n, signal: undefined })).rejects.toMatchObject({ code: "session_closed" });
    await expect(writable.write({
      data: captureFileWriteBytes({ bytes: Uint8Array.of(7) }),
      position: 0n,
    })).rejects.toMatchObject({ code: "session_closed" });

    expect(mutations.calls.map(([name]) => name)).toEqual(["open-writable", "abort"]);
    expect(runtimeState.calls).toEqual(["acquire-writer", "close-writer"]);
    await port.close();
    expect(runtimeState.calls).toEqual(["acquire-writer", "close-writer", "close-session"]);
  });

  it("rejects previously acquired I/O handles after the operation gate closes while allowing release", async () => {
    const runtimeState = runtime();
    const mutations = mutationPort();
    const readNamespace = namespace();
    const rejection = new Error("application session requires recovery");
    let allowed = true;
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      assertOperationAllowed: () => {
        if (!allowed) throw rejection;
      },
      mutationPort: mutations.port,
      namespace: readNamespace,
      runtimeSession: runtimeState.session,
      sync: async () => undefined,
    } });
    const readable = await port.openReadable({ path: ["file"] });
    const writable = await port.openWritable({ keepExistingData: true, path: ["file"] });
    const namespaceCallsBeforeRejection = vi.mocked(readNamespace.stat).mock.calls.length;

    allowed = false;
    await expect(port.stat({ path: ["file"] })).rejects.toBe(rejection);
    await expect(readable.read({ length: 1n, offset: 0n, signal: undefined })).rejects.toBe(rejection);
    const rejectedWriteData = captureFileWriteBytes({ bytes: new Uint8Array([1]) });
    await expect(writable.write({ data: rejectedWriteData, position: 0n })).rejects.toBe(rejection);
    expect([...rejectedWriteData]).toEqual([0]);
    expect(vi.mocked(readNamespace.stat)).toHaveBeenCalledTimes(namespaceCallsBeforeRejection);
    expect(mutations.calls.map(([name]) => name)).not.toContain("write");

    await readable.close();
    await writable.abort({ reason: rejection });
    await port.close();
    expect(mutations.calls.map(([name]) => name)).toContain("abort");
    expect(runtimeState.calls.slice(-2)).toEqual(["close-writer", "close-session"]);
  });

  it("aborts prepared writables before closing the owned runtime session", async () => {
    const { mutations, port, runtimeState } = createPort();
    await port.openWritable({ keepExistingData: false, path: ["file"] });
    await port.close();

    expect(mutations.calls.map(([name]) => name)).toContain("abort");
    expect(runtimeState.calls.slice(-2)).toEqual(["close-writer", "close-session"]);
  });

  it("aborts a prepared writable that resolves after session close begins", async () => {
    const runtimeState = runtime();
    const mutations = mutationPort();
    let markOpenStarted: (() => void) | undefined;
    const openStarted = new Promise<void>(resolve => {
      markOpenStarted = resolve;
    });
    let resolvePrepared: ((prepared: Awaited<ReturnType<HizoFSApplicationMutationPort["openWritable"]>>) => void)
      | undefined;
    const prepared = new Promise<Awaited<ReturnType<HizoFSApplicationMutationPort["openWritable"]>>>(resolve => {
      resolvePrepared = resolve;
    });
    mutations.port.openWritable = async request => {
      mutations.calls.push(["open-writable-delayed", request]);
      markOpenStarted?.();
      return await prepared;
    };
    const port = createRuntimeBoundHizoFSApplicationSessionPort({ composition: {
      mutationPort: mutations.port,
      namespace: namespace(),
      runtimeSession: runtimeState.session,
      sync: async () => undefined,
    } });

    const opening = port.openWritable({ keepExistingData: true, path: ["file"] });
    await openStarted;
    await port.close();
    resolvePrepared?.({
      async read() {
        throw new Error("delayed prepared writable must not read");
      },
      async abort({ reason }) {
        mutations.calls.push(["abort-delayed", reason]);
      },
      async commit() {
        throw new Error("delayed prepared writable must not commit");
      },
      async truncate() {
        throw new Error("delayed prepared writable must not truncate");
      },
      async write() {
        throw new Error("delayed prepared writable must not write");
      },
    });

    await expect(opening).rejects.toMatchObject({ code: "session_closed" });
    expect(mutations.calls.map(([name]) => name)).toContain("abort-delayed");
    expect(runtimeState.calls).toEqual(["acquire-writer", "close-session", "close-writer"]);
  });

  it("forwards sync through the operation gate and rejects it after close", async () => {
    const { port, sync } = createPort();

    await port.sync();
    expect(sync).toHaveBeenCalledOnce();

    await port.close();
    await expect(port.sync()).rejects.toMatchObject({ code: "session_closed" });
    expect(sync).toHaveBeenCalledOnce();
  });
});
