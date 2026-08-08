import {
  createFeatureBits,
} from "@/00-storage/service/hizofs/00-format";
import { createEmptyEncryptedContainer } from "@/00-storage/service/hizofs/authenticated-store/empty-container-store";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import {
  HizoFSCryptoAuthenticationError,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import { OpfsWritableBackend } from "@/00-storage/service/hizofs/physical-store/opfs/opfs-writable-backend";
import { InMemoryOpfsDirectoryHandle } from "@/00-storage/service/test-support/in-memory-opfs";
import { createContainerCoordinationScope, parseContainerCoordinationScopeToken } from "@/00-storage/service/hizofs/runtime/container-coordination-scope";
import { InMemoryCrossRealmLockPort } from "@/00-storage/service/hizofs/runtime/testing/in-memory-cross-realm-lock-port";
import {
  createBrowserContainerCoordinationScope,
  DEFAULT_HIZOFS_BACKING_FILE_HANDLE_CACHE_ENTRY_LIMIT,
  openAuthenticatedDevelopmentWritableApplicationSessionFromCapability,
  openBrowserAuthenticatedDevelopmentWritableContainerCapability,
  openHizoFSWorkerMountGrant,
} from "@/00-storage/service/hizofs/worker/composition-root";
import { HizoFSWorkerRuntimeHost } from "@/00-storage/service/hizofs/worker/runtime-host";
import type {
  StorageDirectoryHandle,
  StorageDirectoryWorkerMountAccessMode,
  StorageDirectoryWorkerMountGrant,
  StorageFileSystemSession,
} from "@/00-storage/service/storage-file-system/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY } from "@/00-storage/service/hizofs/runtime/runtime-policy";
const PASSPHRASE = "correct horse battery staple";
let fixtureSequence = 0;
let originalLocks: LockManager;

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

function createTestBrowserLockManager(): LockManager {
  const held = new Set<string>();
  const request = async <T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    maybeCallback?: LockGrantedCallback<T>,
  ): Promise<Awaited<T>> => {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    if (callback === undefined) throw new Error("browser lock callback is required");
    held.add(name);
    try {
      return await callback({ name, mode: "exclusive" } as Lock);
    } finally {
      held.delete(name);
    }
  };
  return {
    query: async () => ({
      held: [...held].map(name => ({ clientId: "test", mode: "exclusive" as const, name })),
      pending: [],
    }),
    request: request as LockManager["request"],
  } as LockManager;
}

function ownerRuntimeHost(): HizoFSWorkerRuntimeHost {
  return new HizoFSWorkerRuntimeHost({
    crossRealmLockPort: new InMemoryCrossRealmLockPort(),
    policy: {
      lazyDurability: DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
      maxDirectoryIteratorEntries: 256,
      maxHeldLockNames: 64,
      maxMaintenanceRootRegistrations: 64,
      maxReaderPins: 16,
      maxSegmentReferences: 256,
    },
    scope: createContainerCoordinationScope({
      token: parseContainerCoordinationScopeToken({
        value: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
      }),
    }),
  });
}

async function createOwnerSession({
  createRuntimeHost = async () => ownerRuntimeHost(),
}: {
  createRuntimeHost?: ({ canonicalBackingLocation }: {
    canonicalBackingLocation: string;
  }) => Promise<HizoFSWorkerRuntimeHost>;
} = {}): Promise<{
  readonly backingDirectory: InMemoryOpfsDirectoryHandle;
  readonly canonicalBackingLocation: string;
  readonly session: StorageFileSystemSession;
}> {
  fixtureSequence += 1;
  const backingDirectory = new InMemoryOpfsDirectoryHandle({ capabilityProfile: "worker", name: `grant-${fixtureSequence}.hizofs` });
  const backend = new OpfsWritableBackend<AuthenticatedHizoFSPhysicalBytes>({
    root: backingDirectory as unknown as FileSystemDirectoryHandle,
  });
  const created = await createEmptyEncryptedContainer({
    backend,
    passphrase: PASSPHRASE,
    randomSource: deterministicRandomSource(),
    supportedFeatureBits: createFeatureBits({ value: 0n }),
  });
  created.rootKey.destroy();
  const capability = await openBrowserAuthenticatedDevelopmentWritableContainerCapability({
    backingFileHandleCacheEntryLimit: DEFAULT_HIZOFS_BACKING_FILE_HANDLE_CACHE_ENTRY_LIMIT,
    containerRoot: backingDirectory as unknown as FileSystemDirectoryHandle,
    passphrase: PASSPHRASE,
    verifyProofAuthority: async () => undefined,
  });
  if (capability.type !== "opened") throw new Error("test container rejected its credential");
  const canonicalBackingLocation = `naidan-storage/hizofs/${backingDirectory.name}`;
  const session = await openAuthenticatedDevelopmentWritableApplicationSessionFromCapability({
    authority: capability.authority,
    canonicalBackingLocation,
    recheckAuthority: async () => undefined,
    rootName: backingDirectory.name,
    runtimeHost: await createRuntimeHost({ canonicalBackingLocation }),
  });
  return { backingDirectory, canonicalBackingLocation, session };
}

async function requireGrant({
  accessMode,
  directory,
}: {
  accessMode: StorageDirectoryWorkerMountAccessMode;
  directory: StorageDirectoryHandle;
}): Promise<StorageDirectoryWorkerMountGrant> {
  if (directory.createWorkerMountGrant === undefined) {
    throw new Error("HizoFS directory did not expose a Worker grant issuer");
  }
  return await directory.createWorkerMountGrant({ accessMode });
}

beforeEach(() => {
  originalLocks = navigator.locks;
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: createTestBrowserLockManager(),
  });
});

afterEach(() => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: originalLocks,
  });
});

describe("HizoFS Worker mount grants", () => {
  it("reopens a writable session rooted at the exact granted directory", async () => {
    const fixture = await createOwnerSession();
    const mounted = await fixture.session.root.getDirectoryHandle({ name: "mounted", create: true });
    await fixture.session.root.getDirectoryHandle({ name: "sibling", create: true });
    const grant = await requireGrant({ accessMode: "read_write", directory: mounted });
    await fixture.session.close();

    const workerSession = await openHizoFSWorkerMountGrant({
      grant,
      resolveBackingDirectory: async () => fixture.backingDirectory as unknown as FileSystemDirectoryHandle,
    });
    try {
      expect(workerSession.root.name).toBe("mounted");
      await expect(workerSession.sync()).rejects.toMatchObject({
        code: "durability_not_demonstrated",
        implementation: "hizofs",
        retryable: false,
      });
      await expect(workerSession.root.getDirectoryHandle({ name: "sibling", create: false }))
        .rejects.toThrow();
      const file = await workerSession.root.getFileHandle({ name: "worker.txt", create: true });
      const writable = await file.createWritable({ keepExistingData: false });
      await writable.write({ position: 0, data: new TextEncoder().encode("worker-owned") });
      await writable.close();
      const readable = await file.openReadable({ mimeType: "text/plain" });
      try {
        await expect(new Response(readable.stream({
          start: 0,
          end: undefined,
          signal: undefined,
        })).text()).resolves.toBe("worker-owned");
      } finally {
        await readable.close();
      }
    } finally {
      await workerSession.close();
    }
  });

  it("waits for a prepared writable before sealing a Worker mount grant", async () => {
    const fixture = await createOwnerSession();
    const mounted = await fixture.session.root.getDirectoryHandle({ name: "mounted", create: true });
    const file = await mounted.getFileHandle({ name: "held.txt", create: true });
    const writable = await file.createWritable({ keepExistingData: false });
    await writable.write({ position: 0, data: new Uint8Array([1, 2, 3]) });

    let grantSettled = false;
    const grantOperation = requireGrant({ accessMode: "read", directory: mounted }).then(grant => {
      grantSettled = true;
      return grant;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(grantSettled).toBe(false);

    await writable.close();
    await expect(grantOperation).resolves.toMatchObject({ accessMode: "read" });
    await fixture.session.close();
  });

  it("keeps the default Worker mount policy blocking until the runtime owner is released", async () => {
    const crossRealmLockPort = new InMemoryCrossRealmLockPort();
    const fixture = await createOwnerSession({
      createRuntimeHost: async ({ canonicalBackingLocation }) => new HizoFSWorkerRuntimeHost({
        crossRealmLockPort,
        policy: {
          lazyDurability: DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
          maxDirectoryIteratorEntries: 256,
          maxHeldLockNames: 64,
          maxMaintenanceRootRegistrations: 64,
          maxReaderPins: 16,
          maxSegmentReferences: 256,
        },
        scope: await createBrowserContainerCoordinationScope({ canonicalBackingLocation }),
      }),
    });
    const mounted = await fixture.session.root.getDirectoryHandle({ name: "mounted", create: true });
    const grant = await requireGrant({ accessMode: "read_write", directory: mounted });
    const runtimeHostRegistry = {
      getOrCreate: ({ policy, scope }: Parameters<
        NonNullable<Parameters<typeof openHizoFSWorkerMountGrant>[0]["runtimeHostRegistry"]>["getOrCreate"]
      >[0]) => new HizoFSWorkerRuntimeHost({ crossRealmLockPort, policy, scope }),
    };
    let opened = false;
    const opening = openHizoFSWorkerMountGrant({
      grant,
      resolveBackingDirectory: async () => fixture.backingDirectory as unknown as FileSystemDirectoryHandle,
      runtimeHostRegistry,
    }).then(session => {
      opened = true;
      return session;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(opened).toBe(false);
    await fixture.session.close();
    const workerSession = await opening;
    expect(opened).toBe(true);
    await workerSession.close();
  });

  it("can reject a Worker mount immediately when another runtime owns the container", async () => {
    const crossRealmLockPort = new InMemoryCrossRealmLockPort();
    const fixture = await createOwnerSession({
      createRuntimeHost: async ({ canonicalBackingLocation }) => new HizoFSWorkerRuntimeHost({
        crossRealmLockPort,
        policy: {
          lazyDurability: DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
          maxDirectoryIteratorEntries: 256,
          maxHeldLockNames: 64,
          maxMaintenanceRootRegistrations: 64,
          maxReaderPins: 16,
          maxSegmentReferences: 256,
        },
        scope: await createBrowserContainerCoordinationScope({ canonicalBackingLocation }),
      }),
    });
    const mounted = await fixture.session.root.getDirectoryHandle({ name: "mounted", create: true });
    const grant = await requireGrant({ accessMode: "read_write", directory: mounted });
    const runtimeHostRegistry = {
      getOrCreate: ({ policy, scope }: Parameters<
        NonNullable<Parameters<typeof openHizoFSWorkerMountGrant>[0]["runtimeHostRegistry"]>["getOrCreate"]
      >[0]) => new HizoFSWorkerRuntimeHost({ crossRealmLockPort, policy, scope }),
    };

    try {
      await expect(openHizoFSWorkerMountGrant({
        grant,
        resolveBackingDirectory: async () => fixture.backingDirectory as unknown as FileSystemDirectoryHandle,
        runtimeHostRegistry,
        runtimeOwnerPolicy: "reject_if_busy",
      })).rejects.toMatchObject({
        code: "runtime_owner_busy",
        name: "HizoFSWorkerRuntimeHostError",
      });
    } finally {
      await fixture.session.close();
    }
  });

  it("reuses one same-realm runtime host across Worker mount grant opens", async () => {
    const fixture = await createOwnerSession();
    const first = await fixture.session.root.getDirectoryHandle({ name: "first", create: true });
    const second = await fixture.session.root.getDirectoryHandle({ name: "second", create: true });
    const firstGrant = await requireGrant({ accessMode: "read", directory: first });
    const secondGrant = await requireGrant({ accessMode: "read", directory: second });
    await fixture.session.close();

    let createdHost: HizoFSWorkerRuntimeHost | undefined;
    let createCount = 0;
    const runtimeHostRegistry = {
      getOrCreate: ({ createHost, lockManager, policy, scope }: Parameters<
        NonNullable<Parameters<typeof openHizoFSWorkerMountGrant>[0]["runtimeHostRegistry"]>["getOrCreate"]
      >[0]) => {
        if (createdHost === undefined) {
          createCount += 1;
          createdHost = createHost({ lockManager, policy, scope });
        }
        return createdHost;
      },
    };
    const resolveBackingDirectory = async () => fixture.backingDirectory as unknown as FileSystemDirectoryHandle;

    const firstSession = await openHizoFSWorkerMountGrant({
      grant: firstGrant,
      resolveBackingDirectory,
      runtimeHostRegistry,
    });
    await firstSession.close();
    const secondSession = await openHizoFSWorkerMountGrant({
      grant: secondGrant,
      resolveBackingDirectory,
      runtimeHostRegistry,
    });
    await secondSession.close();

    expect(createCount).toBe(1);
  });

  it("preserves read-only access mode at the capability boundary", async () => {
    const fixture = await createOwnerSession();
    const mounted = await fixture.session.root.getDirectoryHandle({ name: "mounted", create: true });
    const grant = await requireGrant({ accessMode: "read", directory: mounted });
    await fixture.session.close();

    const workerSession = await openHizoFSWorkerMountGrant({
      grant,
      resolveBackingDirectory: async () => fixture.backingDirectory as unknown as FileSystemDirectoryHandle,
    });
    try {
      await expect(workerSession.root.getFileHandle({ name: "blocked.txt", create: true }))
        .rejects.toThrow("generation is read-only");
    } finally {
      await workerSession.close();
    }
  });

  it.each([
    { field: "grantId", mutate: (grant: StorageDirectoryWorkerMountGrant) => ({ ...grant, grantId: `${grant.grantId}-tampered` }) },
    { field: "accessMode", mutate: (grant: StorageDirectoryWorkerMountGrant) => ({ ...grant, accessMode: "read" as const }) },
  ])("rejects public-envelope $field tampering", async ({ mutate }) => {
    const fixture = await createOwnerSession();
    const mounted = await fixture.session.root.getDirectoryHandle({ name: "mounted", create: true });
    const grant = await requireGrant({ accessMode: "read_write", directory: mounted });
    await fixture.session.close();

    const failure = await openHizoFSWorkerMountGrant({
      grant: mutate(grant),
      resolveBackingDirectory: async () => fixture.backingDirectory as unknown as FileSystemDirectoryHandle,
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(HizoFSCryptoAuthenticationError);
    expect(failure).toMatchObject({
      cause: { name: "OperationError" },
      code: "authentication_failed",
    });
  });

  it("keeps independently scoped grants usable across independent session lifetimes", async () => {
    const fixture = await createOwnerSession();
    const first = await fixture.session.root.getDirectoryHandle({ name: "first", create: true });
    const second = await fixture.session.root.getDirectoryHandle({ name: "second", create: true });
    const firstGrant = await requireGrant({ accessMode: "read_write", directory: first });
    const secondGrant = await requireGrant({ accessMode: "read_write", directory: second });
    await fixture.session.close();

    const firstSession = await openHizoFSWorkerMountGrant({
      grant: firstGrant,
      resolveBackingDirectory: async () => fixture.backingDirectory as unknown as FileSystemDirectoryHandle,
    });
    try {
      const firstFile = await firstSession.root.getFileHandle({ name: "first.txt", create: true });
      const firstWritable = await firstFile.createWritable({ keepExistingData: false });
      await firstWritable.write({ position: 0, data: new TextEncoder().encode("first") });
      await firstWritable.close();
    } finally {
      await firstSession.close();
    }

    // Each grant reopens the latest authenticated generation. A session that was
    // opened before another writer commits must fail rather than silently refresh.
    const secondSession = await openHizoFSWorkerMountGrant({
      grant: secondGrant,
      resolveBackingDirectory: async () => fixture.backingDirectory as unknown as FileSystemDirectoryHandle,
    });
    try {
      const secondFile = await secondSession.root.getFileHandle({ name: "second.txt", create: true });
      const secondWritable = await secondFile.createWritable({ keepExistingData: false });
      await secondWritable.write({ position: 0, data: new TextEncoder().encode("second") });
      await secondWritable.close();
    } finally {
      await secondSession.close();
    }

    const reopenedFirst = await openHizoFSWorkerMountGrant({
      grant: firstGrant,
      resolveBackingDirectory: async () => fixture.backingDirectory as unknown as FileSystemDirectoryHandle,
    });
    try {
      const firstFile = await reopenedFirst.root.getFileHandle({ name: "first.txt", create: false });
      const readable = await firstFile.openReadable({ mimeType: "text/plain" });
      try {
        await expect(new Response(readable.stream({
          start: 0,
          end: undefined,
          signal: undefined,
        })).text()).resolves.toBe("first");
      } finally {
        await readable.close();
      }
      await expect(reopenedFirst.root.getFileHandle({ name: "second.txt", create: false })).rejects.toThrow();
    } finally {
      await reopenedFirst.close();
    }
  });

  it("keeps root-key bytes outside JSON grant metadata", async () => {
    const fixture = await createOwnerSession();
    const mounted = await fixture.session.root.getDirectoryHandle({ name: "mounted", create: true });
    const grant = await requireGrant({ accessMode: "read", directory: mounted });
    await fixture.session.close();

    const payload = grant.opaquePayload as {
      readonly ciphertext: Uint8Array;
      readonly nonce: Uint8Array;
      readonly wrappingKey: CryptoKey;
    };
    const aad = new TextEncoder().encode(
      `hizofs-worker-mount-grant-v1\u0000${grant.grantId}\u0000${grant.accessMode}`,
    );
    const cleartext = new Uint8Array(await crypto.subtle.decrypt(
      {
        additionalData: aad,
        iv: new Uint8Array(payload.nonce),
        name: "AES-GCM",
      },
      payload.wrappingKey,
      new Uint8Array(payload.ciphertext),
    ));
    try {
      const metadataLength = new DataView(cleartext.buffer, cleartext.byteOffset, 4).getUint32(0, false);
      const metadata = new TextDecoder("utf-8", { fatal: true }).decode(cleartext.subarray(4, 4 + metadataLength));
      const parsedMetadata = JSON.parse(metadata) as Record<string, unknown>;
      expect(Object.keys(parsedMetadata)).toEqual([
        "accessMode",
        "canonicalBackingLocation",
        "fileSystemId",
        "grantId",
        "inodeNumber",
        "scopePath",
        "type",
        "unlockingSlotId",
        "unlockSequence",
        "version",
      ]);
      expect(parsedMetadata).not.toHaveProperty("rootKey");
      expect(cleartext.byteLength - 4 - metadataLength).toBe(32);
    } finally {
      aad.fill(0);
      cleartext.fill(0);
    }
  });

  it("rejects a grant after its directory inode is deleted and replaced", async () => {
    const fixture = await createOwnerSession();
    const mounted = await fixture.session.root.getDirectoryHandle({ name: "mounted", create: true });
    const grant = await requireGrant({ accessMode: "read_write", directory: mounted });
    await fixture.session.root.removeEntry({ name: "mounted", recursive: true });
    const replacement = await fixture.session.root.getDirectoryHandle({ name: "mounted", create: true });
    // Grant issuance is a cross-runtime capability boundary and therefore
    // settles the current working generation before sealing its inode identity.
    // Issuing a replacement grant makes the new inode durable so the old grant
    // must be rejected by an independently reopened runtime.
    await requireGrant({ accessMode: "read_write", directory: replacement });
    await fixture.session.close();

    await expect(openHizoFSWorkerMountGrant({
      grant,
      resolveBackingDirectory: async () => fixture.backingDirectory as unknown as FileSystemDirectoryHandle,
    }))
      .rejects.toThrow("scope is stale or was replaced");
  });
});
