import { describe, expect, it, vi } from "vitest";
import { SessionLifecycle } from "@/00-storage/service/hizofs/runtime/session-lifecycle";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("session lifecycle", () => {
  it("linearizes close before new operations and waits for active reads", async () => {
    const releaseResources = vi.fn(async () => undefined);
    const session = new SessionLifecycle({ releaseResources });
    const read = deferred<void>();
    const operation = session.runOperation({ operation: async () => await read.promise });
    const closing = session.close();
    expect(session.state()).toBe("closing");
    await expect(session.runOperation({ operation: async () => undefined }))
      .rejects.toMatchObject({ code: "capability_closed" });
    expect(releaseResources).not.toHaveBeenCalled();
    read.resolve();
    await operation;
    await closing;
    expect(session.state()).toBe("closed");
    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it("revokes a mutation that has not crossed the commit point", async () => {
    const session = new SessionLifecycle({ releaseResources: async () => undefined });
    const prepared = deferred<void>();
    const continueOperation = deferred<void>();
    const operation = session.runOperation({ operation: async ({ authority }) => {
      prepared.resolve();
      await continueOperation.promise;
      authority.assertPublicationAllowed();
    } });
    await prepared.promise;
    const closing = session.close();
    continueOperation.resolve();
    await expect(operation).rejects.toMatchObject({ code: "publication_revoked" });
    await closing;
  });

  it("does not roll back an operation after its authority commit point", async () => {
    const session = new SessionLifecycle({ releaseResources: async () => undefined });
    const committed = deferred<void>();
    const convergence = deferred<string>();
    const operation = session.runOperation({ operation: async ({ authority }) => {
      authority.markCommitPointCrossed();
      committed.resolve();
      return await convergence.promise;
    } });
    await committed.promise;
    const closing = session.close();
    convergence.resolve("converged");
    await expect(operation).resolves.toBe("converged");
    await closing;
  });

  it("revokes owned children before waiting and releases resources last", async () => {
    const order: string[] = [];
    const active = deferred<void>();
    const session = new SessionLifecycle({ releaseResources: async () => {
      order.push("resources");
    } });
    session.registerChild({ child: {
      close: async () => {
        order.push("child-close");
      },
      revoke: () => {
        order.push("child-revoke");
      },
    } });
    const operation = session.runOperation({ operation: async () => {
      await active.promise;
      order.push("operation-settled");
    } });
    const closing = session.close();
    expect(order).toEqual(["child-revoke"]);
    active.resolve();
    await operation;
    await closing;
    expect(order).toEqual(["child-revoke", "operation-settled", "child-close", "resources"]);
  });

  it("rejects a child capability whose asynchronous preparation loses the close race", async () => {
    const session = new SessionLifecycle({ releaseResources: async () => undefined });
    const preparation = deferred<void>();
    const preparedChild = (async () => {
      await preparation.promise;
      return session.registerChild({ child: { close: async () => undefined, revoke: () => undefined } });
    })();
    await session.close();
    preparation.resolve();
    await expect(preparedChild).rejects.toMatchObject({ code: "capability_closed" });
  });

  it("makes close idempotent and completes cleanup even when one child fails", async () => {
    const releaseResources = vi.fn(async () => undefined);
    const session = new SessionLifecycle({ releaseResources });
    session.registerChild({ child: {
      close: async () => {
        throw new Error("child close failed");
      },
      revoke: () => undefined,
    } });
    await expect(session.close()).rejects.toThrow("session close encountered");
    expect(session.state()).toBe("closed");
    expect(releaseResources).toHaveBeenCalledOnce();
    await expect(session.close()).resolves.toBeUndefined();
    await flushMicrotasks();
  });

  it("shares the in-flight close promise with a reentrant revoke callback", async () => {
    const release = deferred<void>();
    const session = new SessionLifecycle({ releaseResources: async () => await release.promise });
    let reentrantClose: Promise<void> | undefined;
    session.registerChild({ child: {
      close: async () => undefined,
      revoke: () => {
        reentrantClose = session.close();
      },
    } });

    const outerClose = session.close();
    await flushMicrotasks();
    expect(reentrantClose).toBeDefined();
    let reentrantSettled = false;
    void reentrantClose?.then(() => {
      reentrantSettled = true;
    });
    await flushMicrotasks();
    expect(reentrantSettled).toBe(false);

    release.resolve();
    await expect(outerClose).resolves.toBeUndefined();
    await expect(reentrantClose).resolves.toBeUndefined();
  });
});
