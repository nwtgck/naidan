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

describe("runtime-bound HizoFS application session port", () => {
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
  });


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

  it("preserves writable commit and prepared-abort failures in order", async () => {
    const runtimeState = runtime();
    const mutations = mutationPort();
    const commitFailure = new Error("prepared writable commit failed");
    const abortFailure = new Error("prepared writable abort failed");
    mutations.port.openWritable = async request => {
      mutations.calls.push(["open-writable-failing-cleanup", request]);
      return {
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
    const { port, runtimeState } = createPort();
    const writable = await port.openWritable({ keepExistingData: true, path: ["file"] });

    await expect(port.createDirectory({ name: "blocked", path: [] })).rejects.toMatchObject({
      code: "operation_in_progress",
    });
    await expect(port.openWritable({ keepExistingData: true, path: ["other"] })).rejects.toMatchObject({
      code: "operation_in_progress",
    });
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
