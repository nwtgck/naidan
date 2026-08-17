import { describe, expect, it, vi } from "vitest";
import {
  createHomeRecordReference,
  createUInt64,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";
import { parseContainerCoordinationScopeToken } from "@/00-storage/service/hizofs/runtime/container-coordination-scope";
import {
  CrossRealmLockCoordinator,
  readerPinLockName,
  type CrossRealmLockLease,
  type CrossRealmLockMode,
  type CrossRealmLockPort,
} from "@/00-storage/service/hizofs/runtime/cross-realm-lock-coordinator";

function commitReference(seed: number) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: 64n + BigInt(seed) * 8n }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    segmentId: parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => seed + index) }),
  } });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function scopeToken(seed: number) {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => seed + index);
  const value = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return parseContainerCoordinationScopeToken({ value });
}

class RecordingLockPort implements CrossRealmLockPort {
  readonly held = new Map<string, { count: number; mode: CrossRealmLockMode }>();
  readonly acquisitions: { mode: CrossRealmLockMode; name: string }[] = [];
  queriedNames: readonly string[] | undefined;

  async acquire({ mode, name }: {
    mode: CrossRealmLockMode;
    name: string;
  }): Promise<CrossRealmLockLease> {
    this.acquisitions.push({ mode, name });
    const existing = this.held.get(name);
    if (existing !== undefined && (mode === "exclusive" || existing.mode === "exclusive")) {
      throw new Error(`test lock conflict: ${name}`);
    }
    this.held.set(name, { count: (existing?.count ?? 0) + 1, mode });
    const completion = Promise.withResolvers<void>();
    let active = true;
    return { release: () => {
      if (!active) return;
      active = false;
      const current = this.held.get(name);
      if (current === undefined) throw new Error("test lock accounting became inconsistent");
      if (current.count === 1) this.held.delete(name);
      else this.held.set(name, { ...current, count: current.count - 1 });
      completion.resolve();
    }, released: completion.promise };
  }

  async tryAcquire({ mode, name }: {
    mode: CrossRealmLockMode;
    name: string;
  }): Promise<CrossRealmLockLease | undefined> {
    const existing = this.held.get(name);
    if (existing !== undefined && (mode === "exclusive" || existing.mode === "exclusive")) return undefined;
    return await this.acquire({ mode, name });
  }

  async queryHeldLockNames(): Promise<readonly string[]> {
    return this.queriedNames ?? [...this.held.keys()];
  }
}

describe("cross-realm lock coordinator", () => {
  it("uses backend-local scope tokens rather than persisted filesystem identity", () => {
    const reference = commitReference(1);
    const first = readerPinLockName({ commitReference: reference, scopeToken: scopeToken(1) });
    const sameBackingFromAnotherRealm = readerPinLockName({ commitReference: reference, scopeToken: scopeToken(1) });
    const copiedBacking = readerPinLockName({ commitReference: reference, scopeToken: scopeToken(2) });
    expect(first).toBe(sameBackingFromAnotherRealm);
    expect(copiedBacking).not.toBe(first);
  });

  it("preserves authority-read and lease-cleanup failures in order", async () => {
    const operationFailure = new Error("authority read failed");
    const releaseFailure = new Error("authority lease release failed");
    const coordinator = new CrossRealmLockCoordinator({
      lockPort: {
        acquire: async () => ({
          release: () => {
            throw releaseFailure;
          },
          released: Promise.resolve(),
        }),
        queryHeldLockNames: async () => [],
      },
      maxHeldLockNames: 64,
      scopeToken: scopeToken(1),
    });

    await expect(coordinator.runAuthorityRead({
      operation: async () => {
        throw operationFailure;
      },
    })).rejects.toEqual(expect.objectContaining({
      errors: [operationFailure, releaseFailure],
    }));
  });

  it("preserves reader-pin acquisition and registration-cleanup failures in order", async () => {
    const acquisitionFailure = new Error("reader pin acquisition failed");
    const registrationFailure = new Error("reader registration release failed");
    let acquisitions = 0;
    const coordinator = new CrossRealmLockCoordinator({
      lockPort: {
        acquire: async () => {
          acquisitions += 1;
          if (acquisitions === 2) throw acquisitionFailure;
          return {
            release: () => {
              throw registrationFailure;
            },
            released: Promise.resolve(),
          };
        },
        queryHeldLockNames: async () => [],
      },
      maxHeldLockNames: 64,
      scopeToken: scopeToken(1),
    });

    await expect(coordinator.acquireReaderPin({ commitReference: commitReference(1) }))
      .rejects.toEqual(expect.objectContaining({
        errors: [acquisitionFailure, registrationFailure],
      }));
  });

  it("releases an unreturned reader pin when registration cleanup fails", async () => {
    const registrationFailure = new Error("reader registration release failed");
    const pinFailure = new Error("reader pin release failed");
    const registrationRelease = vi.fn(() => {
      throw registrationFailure;
    });
    const pinRelease = vi.fn(() => {
      throw pinFailure;
    });
    let acquisitions = 0;
    const coordinator = new CrossRealmLockCoordinator({
      lockPort: {
        acquire: async () => {
          acquisitions += 1;
          return acquisitions === 1
            ? { release: registrationRelease, released: Promise.resolve() }
            : { release: pinRelease, released: Promise.resolve() };
        },
        queryHeldLockNames: async () => [],
      },
      maxHeldLockNames: 64,
      scopeToken: scopeToken(1),
    });

    await expect(coordinator.acquireReaderPin({ commitReference: commitReference(1) }))
      .rejects.toEqual(expect.objectContaining({
        errors: [registrationFailure, pinFailure],
      }));
    expect(registrationRelease).toHaveBeenCalledOnce();
    expect(pinRelease).toHaveBeenCalledOnce();
  });

  it("preserves publication and publication-lease cleanup failures in order", async () => {
    const operationFailure = new Error("publication operation failed");
    const releaseFailure = new Error("publication lease release failed");
    const authorityRelease = vi.fn();
    let acquisitions = 0;
    const coordinator = new CrossRealmLockCoordinator({
      lockPort: {
        acquire: async () => {
          acquisitions += 1;
          return acquisitions === 1
            ? { release: authorityRelease, released: Promise.resolve() }
            : { release: () => {
              throw releaseFailure;
            }, released: Promise.resolve() };
        },
        queryHeldLockNames: async () => [],
      },
      maxHeldLockNames: 64,
      scopeToken: scopeToken(1),
    });
    const writer = await coordinator.acquireWriter();

    await expect(writer.runPublication({
      operation: async () => {
        throw operationFailure;
      },
    })).rejects.toEqual(expect.objectContaining({
      errors: [operationFailure, releaseFailure],
    }));
    writer.release();
    expect(authorityRelease).toHaveBeenCalledOnce();
  });

  it("registers a reader pin before releasing the shared registration gate", async () => {
    const port = new RecordingLockPort();
    const coordinator = new CrossRealmLockCoordinator({ lockPort: port, maxHeldLockNames: 64, scopeToken: scopeToken(1) });
    const pin = await coordinator.acquireReaderPin({ commitReference: commitReference(1) });
    expect(port.acquisitions.map(value => value.mode)).toEqual(["shared", "shared"]);
    expect(port.acquisitions[0]?.name).toContain("reader-registration");
    expect(port.acquisitions[1]?.name).toContain("reader-pin");
    expect([...port.held.keys()]).toEqual([port.acquisitions[1]?.name]);
    pin.release();
    pin.release();
    await pin.released;
    expect(port.held.size).toBe(0);
  });

  it("captures and deduplicates held roots while blocking new registration", async () => {
    const port = new RecordingLockPort();
    const token = scopeToken(1);
    const reference = commitReference(1);
    port.queriedNames = [
      readerPinLockName({ commitReference: reference, scopeToken: token }),
      readerPinLockName({ commitReference: reference, scopeToken: token }),
      readerPinLockName({ commitReference: commitReference(2), scopeToken: scopeToken(2) }),
      "unrelated/lock",
    ];
    const coordinator = new CrossRealmLockCoordinator({ lockPort: port, maxHeldLockNames: 64, scopeToken: token });
    const maintenance = await coordinator.beginMaintenance();
    expect(maintenance.pinnedCommitReferences).toHaveLength(1);
    expect(port.acquisitions.slice(0, 2)).toEqual([
      expect.objectContaining({ mode: "exclusive", name: expect.stringContaining("reader-registration") }),
      expect.objectContaining({ mode: "exclusive", name: expect.stringContaining("authority") }),
    ]);
    expect([...port.held.keys()].some(name => name.includes("reader-registration"))).toBe(true);
    maintenance.release();
    maintenance.release();
    await maintenance.released;
    expect(port.held.size).toBe(0);
  });

  it("fails closed when a held pin in this scope cannot be decoded", async () => {
    const port = new RecordingLockPort();
    const token = scopeToken(1);
    port.queriedNames = [`hizofs-v1/reader-pin/${token}/not-a-reference`];
    const coordinator = new CrossRealmLockCoordinator({ lockPort: port, maxHeldLockNames: 64, scopeToken: token });
    await expect(coordinator.beginMaintenance()).rejects.toMatchObject({ code: "invalid_held_reader_pin" });
    expect(port.held.size).toBe(0);
  });

  it("holds a runtime-owner lease under a lock distinct from mutation authority", async () => {
    const port = new RecordingLockPort();
    const coordinator = new CrossRealmLockCoordinator({
      lockPort: port,
      maxHeldLockNames: 64,
      scopeToken: scopeToken(1),
    });
    const owner = await coordinator.acquireRuntimeOwner();
    expect(port.acquisitions).toEqual([expect.objectContaining({
      mode: "exclusive",
      name: expect.stringContaining("/runtime-owner/"),
    })]);
    const writer = await coordinator.acquireWriter();
    expect(port.acquisitions[1]?.name).toContain("/authority/");
    expect(port.acquisitions[1]?.name).not.toBe(port.acquisitions[0]?.name);
    writer.release();
    await writer.released;
    owner.release();
    owner.release();
    await owner.released;
    expect(port.held.size).toBe(0);
  });

  it("holds writer authority and serializes publication under a separate short gate", async () => {
    const port = new RecordingLockPort();
    const coordinator = new CrossRealmLockCoordinator({ lockPort: port, maxHeldLockNames: 64, scopeToken: scopeToken(1) });
    const writer = await coordinator.acquireWriter();
    const publication = deferred<string>();
    const running = writer.runPublication({ operation: async () => await publication.promise });
    await expect(writer.runPublication({ operation: async () => "other" }))
      .rejects.toMatchObject({ code: "publication_in_progress" });
    expect(() => writer.release()).toThrowError(expect.objectContaining({ code: "publication_in_progress" }));
    publication.resolve("published");
    await expect(running).resolves.toBe("published");
    expect([...port.held.keys()].some(name => name.includes("authority"))).toBe(true);
    expect([...port.held.keys()].some(name => name.includes("publication"))).toBe(false);
    writer.release();
    await writer.released;
    await expect(writer.runPublication({ operation: async () => undefined }))
      .rejects.toMatchObject({ code: "lease_released" });
  });
  it("fails closed when held-lock enumeration exceeds the explicit runtime bound", async () => {
    const lockPort: CrossRealmLockPort = {
      acquire: async () => ({ release: () => undefined, released: Promise.resolve() }),
      queryHeldLockNames: async () => ["a", "b", "c"],
    };
    const coordinator = new CrossRealmLockCoordinator({
      lockPort,
      maxHeldLockNames: 2,
      scopeToken: scopeToken(1),
    });
    await expect(coordinator.beginMaintenance()).rejects.toMatchObject({ code: "held_lock_limit_exceeded" });
  });


  it("provides a non-blocking runtime-owner acquisition boundary", async () => {
    const port = new RecordingLockPort();
    const first = new CrossRealmLockCoordinator({ lockPort: port, maxHeldLockNames: 64, scopeToken: scopeToken(1) });
    const second = new CrossRealmLockCoordinator({ lockPort: port, maxHeldLockNames: 64, scopeToken: scopeToken(1) });
    const held = await first.acquireRuntimeOwner();
    await expect(second.tryAcquireRuntimeOwner()).resolves.toBeUndefined();
    held.release();
    await held.released;
    const acquired = await second.tryAcquireRuntimeOwner();
    expect(acquired).toBeDefined();
    acquired?.release();
    await acquired?.released;
  });

  it("fails explicitly when a lock port cannot provide non-blocking acquisition", async () => {
    const coordinator = new CrossRealmLockCoordinator({
      lockPort: {
        acquire: async () => ({ release: () => undefined, released: Promise.resolve() }),
        queryHeldLockNames: async () => [],
      },
      maxHeldLockNames: 64,
      scopeToken: scopeToken(1),
    });
    await expect(coordinator.tryAcquireRuntimeOwner()).rejects.toMatchObject({ code: "try_acquire_unsupported" });
  });

});
