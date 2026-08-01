import { describe, expect, it, vi } from "vitest";
import { WriterMutationLifecycle } from "@/00-storage/service/hizofs/filesystem/mutation/writer-mutation-lifecycle";

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("writer mutation lifecycle", () => {
  it("rejects overlapping mutating operations", async () => {
    const lifecycle = new WriterMutationLifecycle();
    const gate = deferred();
    const first = lifecycle.runExclusive({ operation: async () => await gate.promise });
    await expect(lifecycle.runExclusive({ operation: async () => undefined })).rejects.toMatchObject({ code: "operation_in_progress" });
    gate.resolve();
    await first;
  });

  it("revokes publication preparation when owner close begins and waits for settlement", async () => {
    const lifecycle = new WriterMutationLifecycle();
    const prepared = deferred();
    const release = deferred();
    const observed = vi.fn();
    const operation = lifecycle.runExclusive({ operation: async ({ assertPublicationAllowed }) => {
      prepared.resolve();
      await release.promise;
      expect(() => assertPublicationAllowed()).toThrow("owner is closing");
      observed();
    } });
    await prepared.promise;
    const closing = lifecycle.close();
    release.resolve();
    await operation;
    await closing;
    expect(observed).toHaveBeenCalledOnce();
    await expect(lifecycle.runExclusive({ operation: async () => undefined })).rejects.toMatchObject({ code: "writer_closed" });
  });

  it("makes abort terminal and does not publish", async () => {
    const lifecycle = new WriterMutationLifecycle();
    lifecycle.abort();
    await expect(lifecycle.runExclusive({ operation: async () => undefined })).rejects.toMatchObject({ code: "writer_aborted" });
    await lifecycle.close();
  });

  it("makes close idempotent", async () => {
    const lifecycle = new WriterMutationLifecycle();
    await lifecycle.close();
    await lifecycle.close();
    expect(lifecycle.state()).toBe("closed");
  });
});
