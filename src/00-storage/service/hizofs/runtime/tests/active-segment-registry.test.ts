import { describe, expect, it } from "vitest";
import { parseSegmentId } from "@/00-storage/service/hizofs/00-format";
import type { ContainerCoordinationKey } from "@/00-storage/service/hizofs/filesystem/container-coordination-key";
import { ActiveSegmentRegistry } from "@/00-storage/service/hizofs/runtime/active-segment-registry";

function coordinationKey(): ContainerCoordinationKey {
  return Object.freeze({}) as ContainerCoordinationKey;
}

function segmentId(seed: number) {
  return parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => seed + index) });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("active segment registry", () => {
  it("waits for read, handle, and cache references while blocking new ones", async () => {
    const registry = new ActiveSegmentRegistry({ maxReferencesPerContainer: 4 });
    const key = coordinationKey();
    const id = segmentId(1);
    const read = registry.acquire({ coordinationKey: key, kind: "read_lease", segmentId: id });
    const handle = registry.acquire({ coordinationKey: key, kind: "backend_handle", segmentId: id });
    const cache = registry.acquire({ coordinationKey: key, kind: "snapshot_cache", segmentId: id });
    let deletionReady = false;
    const deletionPromise = registry.beginDeletion({ coordinationKey: key, segmentId: id }).then(value => {
      deletionReady = true;
      return value;
    });
    await flushMicrotasks();
    expect(deletionReady).toBe(false);
    expect(() => registry.acquire({ coordinationKey: key, kind: "read_lease", segmentId: id }))
      .toThrowError(expect.objectContaining({ code: "deletion_active" }));
    read.release();
    handle.release();
    await flushMicrotasks();
    expect(deletionReady).toBe(false);
    cache.release();
    const deletion = await deletionPromise;
    expect(() => registry.acquire({ coordinationKey: key, kind: "snapshot_cache", segmentId: id }))
      .toThrowError(expect.objectContaining({ code: "deletion_active" }));
    deletion.release();
    expect(registry.acquire({ coordinationKey: key, kind: "read_lease", segmentId: id })).toBeDefined();
  });

  it("isolates byte-copied containers by runtime coordination identity", async () => {
    const registry = new ActiveSegmentRegistry({ maxReferencesPerContainer: 1 });
    const original = coordinationKey();
    const copied = coordinationKey();
    const id = segmentId(1);
    registry.acquire({ coordinationKey: original, kind: "read_lease", segmentId: id });
    const copiedDeletion = await registry.beginDeletion({ coordinationKey: copied, segmentId: id });
    copiedDeletion.release();
  });

  it("enforces a per-container reference bound across segments and kinds", () => {
    const registry = new ActiveSegmentRegistry({ maxReferencesPerContainer: 2 });
    const key = coordinationKey();
    registry.acquire({ coordinationKey: key, kind: "read_lease", segmentId: segmentId(1) });
    registry.acquire({ coordinationKey: key, kind: "snapshot_cache", segmentId: segmentId(2) });
    expect(() => registry.acquire({ coordinationKey: key, kind: "backend_handle", segmentId: segmentId(3) }))
      .toThrowError(expect.objectContaining({ code: "reference_limit_exceeded" }));
  });

  it("makes reference and deletion release idempotent", async () => {
    const registry = new ActiveSegmentRegistry({ maxReferencesPerContainer: 1 });
    const key = coordinationKey();
    const id = segmentId(1);
    const reference = registry.acquire({ coordinationKey: key, kind: "read_lease", segmentId: id });
    reference.release();
    reference.release();
    const deletion = await registry.beginDeletion({ coordinationKey: key, segmentId: id });
    deletion.release();
    deletion.release();
  });
});
