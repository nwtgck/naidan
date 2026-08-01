import { describe, expect, it } from "vitest";
import type { ContainerCoordinationKey } from "@/00-storage/service/hizofs/filesystem/container-coordination-key";
import { RuntimeCoordinationRegistry } from "@/00-storage/service/hizofs/runtime/runtime-coordination-registry";

function coordinationKey(): ContainerCoordinationKey {
  return Object.freeze({}) as ContainerCoordinationKey;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("runtime coordination registry", () => {
  it("enforces one writer owner per physical container while copied containers remain independent", () => {
    const registry = new RuntimeCoordinationRegistry();
    const firstKey = coordinationKey();
    const copiedContainerKey = coordinationKey();
    const first = registry.acquireWriter({ coordinationKey: firstKey });
    expect(() => registry.acquireWriter({ coordinationKey: firstKey }))
      .toThrowError(expect.objectContaining({ code: "writer_active" }));
    expect(registry.acquireWriter({ coordinationKey: copiedContainerKey })).toBeDefined();
    first.release();
    expect(registry.acquireWriter({ coordinationKey: firstKey })).toBeDefined();
  });

  it("keeps publication single-flight and holds writer ownership until resolution", async () => {
    const registry = new RuntimeCoordinationRegistry();
    const key = coordinationKey();
    const writer = registry.acquireWriter({ coordinationKey: key });
    const publication = deferred<string>();
    const running = writer.runPublication({ operation: async () => await publication.promise });
    await expect(writer.runPublication({ operation: async () => "other" }))
      .rejects.toMatchObject({ code: "publication_in_progress" });
    expect(() => writer.release()).toThrowError(expect.objectContaining({ code: "publication_in_progress" }));
    publication.resolve("resolved");
    await expect(running).resolves.toBe("resolved");
    writer.release();
  });

  it("serializes maintenance root capture against writer ownership", () => {
    const registry = new RuntimeCoordinationRegistry();
    const key = coordinationKey();
    const writer = registry.acquireWriter({ coordinationKey: key });
    expect(() => registry.beginMaintenance({ coordinationKey: key }))
      .toThrowError(expect.objectContaining({ code: "writer_active" }));
    writer.release();
    const maintenance = registry.beginMaintenance({ coordinationKey: key });
    expect(() => registry.acquireWriter({ coordinationKey: key }))
      .toThrowError(expect.objectContaining({ code: "maintenance_active" }));
    maintenance.release();
    maintenance.release();
    expect(registry.acquireWriter({ coordinationKey: key })).toBeDefined();
  });

  it("rejects publication after writer ownership release", async () => {
    const registry = new RuntimeCoordinationRegistry();
    const writer = registry.acquireWriter({ coordinationKey: coordinationKey() });
    writer.release();
    await expect(writer.runPublication({ operation: async () => undefined }))
      .rejects.toMatchObject({ code: "writer_released" });
  });
});
