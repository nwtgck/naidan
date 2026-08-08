import { describe, expect, it } from "vitest";
import {
  createHizoFSReadApi,
  type HizoFSReadApiNamespace,
  type HizoFSReadApiRuntimeSession,
} from "@/00-storage/service/hizofs/api/read-api";

function namespace({
  createdAt = null,
  fileSize = 9_007_199_254_740_993n,
  kind = "file",
  modifiedAt = null,
  symlinkTarget = "é/path",
}: {
  createdAt?: bigint | null;
  fileSize?: bigint;
  kind?: "directory" | "file" | "symlink";
  modifiedAt?: bigint | null;
  symlinkTarget?: string;
} = {}): HizoFSReadApiNamespace {
  return {
    readFile: async () => new Uint8Array([1, 2, 3]),
    readlink: async () => symlinkTarget,
    stat: async () => ({
      createdAt: createdAt as never,
      ...(kind === "file" ? { fileSize: fileSize as never } : {}),
      inodeNumber: 4n as never,
      inodeRevision: 7n as never,
      kind,
      modifiedAt: modifiedAt as never,
    }),
  };
}

class RuntimeSession implements HizoFSReadApiRuntimeSession {
  private closed = false;

  async close(): Promise<void> {
    this.closed = true;
  }

  async runReadOperation<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
    if (this.closed) throw new Error("runtime session is closed");
    return await operation();
  }
}

describe("HizoFS narrow read API", () => {
  it("projects file size and timestamps without Number conversion", async () => {
    const api = createHizoFSReadApi({
      namespace: namespace({ createdAt: 11n, modifiedAt: 13n }),
      session: new RuntimeSession(),
    });
    await expect(api.stat({ pathComponents: ["large"] })).resolves.toEqual({
      createdAt: 11n,
      kind: "file",
      modifiedAt: 13n,
      size: 9_007_199_254_740_993n,
    });
  });

  it("uses zero for directory size and preserves absent timestamps", async () => {
    const api = createHizoFSReadApi({
      namespace: namespace({ kind: "directory" }),
      session: new RuntimeSession(),
    });
    await expect(api.stat({ pathComponents: [] })).resolves.toEqual({
      createdAt: undefined,
      kind: "directory",
      modifiedAt: undefined,
      size: 0n,
    });
  });

  it("reports symlink size as exact canonical UTF-8 target bytes", async () => {
    const api = createHizoFSReadApi({
      namespace: namespace({ kind: "symlink", symlinkTarget: "é/path" }),
      session: new RuntimeSession(),
    });
    await expect(api.stat({ pathComponents: ["link"] })).resolves.toMatchObject({
      kind: "symlink",
      size: 7n,
    });
  });

  it("runs reads inside the runtime session and rejects use after close", async () => {
    const session = new RuntimeSession();
    const api = createHizoFSReadApi({ namespace: namespace(), session });
    await expect(api.readFile({ pathComponents: ["file"] })).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await api.close();
    await expect(api.readFile({ pathComponents: ["file"] })).rejects.toThrow("runtime session is closed");
  });
});
