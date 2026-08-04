import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/01-models/types";
import { NaidanOpfsStorageBackend } from "@/00-storage/service/naidan-opfs/backend";
import {
  createDevelopmentOpfsPersistenceRuntime,
  installDevelopmentUnverifiedOpfsPersistenceRuntime,
} from "@/00-storage/service/naidan-opfs/development-persistence-runtime";
import { NAIDAN_OPFS_STORAGE_DIRECTORY_NAME } from "@/00-storage/service/naidan-opfs/opfs-storage-location";
import { getNaidanOpfsSpecialFileSystemDirectoryName } from "@/00-storage/service/opfs/naidan-opfs-root-directory-registry";
import type { OpfsSpecialFileSystemType } from "@/00-storage/service/opfs/opfs-special-file-system";
import { NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS } from "@/00-storage/service/naidan-persistence-control/00-format";
import { listNativePlainApplicationNamespaceEntryNames } from "@/00-storage/service/naidan-opfs/native-plain-application-namespace";
import { TEST_ONLY as RETIRED_PROGRESS_TEST_ONLY } from "@/00-storage/service/naidan-opfs/retired-local-transition-progress-cleanup";
import { OPFSStorageProvider } from "@/00-storage/service/opfs-storage";
import { OPFS_PLAIN_NAMESPACE_SESSION_LOCK_KEY } from "@/00-storage/service/opfs/opfs-storage-session-lock";
import { HostVolumeDB } from "@/00-storage/service/opfs/host-volume-db";
import { createNativeOpfsFileSystemSession } from "@/00-storage/service/storage-file-system/native-opfs";
import {
  createInMemoryOpfsStorageManager,
  InMemoryOpfsDirectoryHandle,
} from "@/00-storage/service/test-support/in-memory-opfs";
import { InMemoryWebLockManager } from "@/00-storage/service/test-support/in-memory-web-locks";

const PASSPHRASE = "correct horse battery staple";

function settings({ endpointUrl }: { endpointUrl: string }): Settings {
  return {
    endpoint: { type: "openai", url: endpointUrl },
    mounts: [],
    providerProfiles: [],
    storageType: "opfs",
    titleGeneration: {
      endpoint: "same_scope",
      lmParameters: {
        frequencyPenalty: undefined,
        maxCompletionTokens: undefined,
        presencePenalty: undefined,
        reasoning: { effort: undefined },
        stop: undefined,
        temperature: undefined,
        topP: undefined,
      },
      model: "same_scope",
    },
  };
}

function lockManager(): LockManager {
  return new InMemoryWebLockManager();
}

async function plainBackend({ root }: {
  root: InMemoryOpfsDirectoryHandle;
}): Promise<NaidanOpfsStorageBackend> {
  const session = createNativeOpfsFileSystemSession({
    root: root as unknown as FileSystemDirectoryHandle,
  });
  const backend = new NaidanOpfsStorageBackend({
    hostVolumeDB: new HostVolumeDB(),
    namespaceRoot: session.root,
  });
  await backend.init();
  return backend;
}

const MANAGED_SPECIAL_FILE_CASES = [
  { bytes: Uint8Array.of(11, 12), type: "chat_wesh" },
  { bytes: Uint8Array.of(21, 22, 23), type: "debug_wesh" },
  { bytes: Uint8Array.of(31, 32, 33, 34), type: "tmp" },
] as const satisfies readonly Readonly<{
  bytes: Uint8Array<ArrayBuffer>;
  type: OpfsSpecialFileSystemType;
}>[];

async function writeNativeManagedRootFile({ bytes, root, type }: {
  bytes: Uint8Array<ArrayBuffer>;
  root: InMemoryOpfsDirectoryHandle;
  type: OpfsSpecialFileSystemType;
}): Promise<void> {
  const directory = await root.getDirectoryHandle(
    getNaidanOpfsSpecialFileSystemDirectoryName({ type }),
    { create: true },
  );
  const writable = await (await directory.getFileHandle("transition-value.bin", { create: true }))
    .createWritable({ keepExistingData: false });
  await writable.write(bytes);
  await writable.close();
}

async function readNativeManagedRootFile({ root, type }: {
  root: InMemoryOpfsDirectoryHandle;
  type: OpfsSpecialFileSystemType;
}): Promise<Uint8Array<ArrayBuffer>> {
  const directory = await root.getDirectoryHandle(
    getNaidanOpfsSpecialFileSystemDirectoryName({ type }),
    { create: false },
  );
  const file = await (await directory.getFileHandle(
    "transition-value.bin",
    { create: false },
  )).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function readEncryptedManagedRootFile({ provider, type }: {
  provider: OPFSStorageProvider;
  type: OpfsSpecialFileSystemType;
}): Promise<Uint8Array<ArrayBuffer>> {
  const access = await provider.openSpecialFileSystemDirectory({
    create: false,
    path: "/",
    type,
  });
  if (access?.type !== "storage_directory") {
    throw new Error("Expected encrypted managed root storage directory");
  }
  const file = await access.handle.getFileHandle({
    create: false,
    name: "transition-value.bin",
  });
  const readable = await file.openReadable({ mimeType: "application/octet-stream" });
  try {
    return new Uint8Array(await new Response(readable.stream({
      end: undefined,
      signal: undefined,
      start: 0,
    })).arrayBuffer());
  } finally {
    await readable.close();
  }
}

function runtime() {
  return createDevelopmentOpfsPersistenceRuntime({
    lockManager: lockManager(),
    runtimePolicy: {
      maxDirectoryIteratorEntries: 4_096,
      maxHeldLockNames: 1_024,
      maxMaintenanceRootRegistrations: 1_024,
      maxReaderPins: 256,
      maxSegmentReferences: 4_096,
    },
  });
}

async function expectNoPersistentTransitionProgress({ storageRoot }: {
  storageRoot: FileSystemDirectoryHandle;
}): Promise<void> {
  const collection = await storageRoot.getDirectoryHandle(
    NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName,
    { create: false },
  );
  await expect(collection.getDirectoryHandle(
    RETIRED_PROGRESS_TEST_ONLY.directoryName,
    { create: false },
  )).rejects.toMatchObject({ name: "NotFoundError" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browserless production HizoFS enable system", () => {
  it("enables, reloads, unlocks, writes, and reopens through the production composition", async () => {
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: "window",
      name: "opfs-root",
    });
    vi.stubGlobal("navigator", {
      storage: createInMemoryOpfsStorageManager({ root }),
    });

    const before = await plainBackend({ root });
    await before.saveSettings({ settings: settings({ endpointUrl: "http://before-transition" }) });
    await before.dispose();

    const storageRoot = await root.getDirectoryHandle(
      NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
      { create: true },
    );
    const firstRuntime = runtime();
    const transition = await firstRuntime.runTransition({
      nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
      onProgress: undefined,
      request: { operation: "enable", passphrase: PASSPHRASE },
      signal: undefined,
      storageRoot: storageRoot as unknown as FileSystemDirectoryHandle,
    });
    expect(transition).toEqual({ type: "completed" });
    await expectNoPersistentTransitionProgress({
      storageRoot: storageRoot as unknown as FileSystemDirectoryHandle,
    });

    const secondRuntime = runtime();
    await expect(secondRuntime.inspect({
      storageRoot: storageRoot as unknown as FileSystemDirectoryHandle,
    })).resolves.toMatchObject({ type: "credential_required" });
    const secondSession = await secondRuntime.unlockWithPassphrase({
      passphrase: PASSPHRASE,
      storageRoot: storageRoot as unknown as FileSystemDirectoryHandle,
    });
    await expect(secondRuntime.runUnlockedMaintenance({
      nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
      session: secondSession,
      storageRoot: storageRoot as unknown as FileSystemDirectoryHandle,
    })).resolves.toMatchObject({ remainingEntryCount: 0, state: 'completed' });
    await expect(listNativePlainApplicationNamespaceEntryNames({
      nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
    })).resolves.toEqual([]);
    expect(await secondSession.backend.loadSettings()).toMatchObject({
      endpoint: { url: "http://before-transition" },
    });
    await secondSession.backend.saveSettings({
      settings: settings({ endpointUrl: "http://after-transition" }),
    });
    await secondSession.close();

    const thirdRuntime = runtime();
    const thirdSession = await thirdRuntime.unlockWithPassphrase({
      passphrase: PASSPHRASE,
      storageRoot: storageRoot as unknown as FileSystemDirectoryHandle,
    });
    expect(await thirdSession.backend.loadSettings()).toMatchObject({
      endpoint: { url: "http://after-transition" },
    });
    await thirdSession.close();
  }, 60_000);

  it("ignores malformed retired progress files and removes only their fixed names", async () => {
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: "window",
      name: "opfs-root",
    });
    vi.stubGlobal("navigator", {
      storage: createInMemoryOpfsStorageManager({ root }),
    });
    const storageRoot = await root.getDirectoryHandle(
      NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
      { create: true },
    );
    const collection = await storageRoot.getDirectoryHandle(
      NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName,
      { create: true },
    );
    const retiredProgress = await collection.getDirectoryHandle(
      RETIRED_PROGRESS_TEST_ONLY.directoryName,
      { create: true },
    );
    for (const [index, fileName] of RETIRED_PROGRESS_TEST_ONLY.fileNames.entries()) {
      const writable = await (await retiredProgress.getFileHandle(fileName, { create: true }))
        .createWritable({ keepExistingData: false });
      await writable.write(index === 0
        ? Uint8Array.of(0xff, 0x00)
        : new TextEncoder().encode("wrong key and stale operation"));
      await writable.close();
    }
    const unknown = await retiredProgress.getFileHandle("unrelated.json", { create: true });
    await (await unknown.createWritable({ keepExistingData: false })).close();

    const before = await plainBackend({ root });
    await before.saveSettings({ settings: settings({ endpointUrl: "http://malformed-progress" }) });
    await before.dispose();
    await expect(runtime().runTransition({
      nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
      onProgress: undefined,
      request: { operation: "enable", passphrase: PASSPHRASE },
      signal: undefined,
      storageRoot: storageRoot as unknown as FileSystemDirectoryHandle,
    })).resolves.toEqual({ type: "completed" });

    for (const fileName of RETIRED_PROGRESS_TEST_ONLY.fileNames) {
      await expect(retiredProgress.getFileHandle(fileName, { create: false }))
        .rejects.toMatchObject({ name: "NotFoundError" });
    }
    await expect(retiredProgress.getFileHandle("unrelated.json", { create: false })).resolves.toBeDefined();
    const afterReload = runtime();
    const session = await afterReload.unlockWithPassphrase({
      passphrase: PASSPHRASE,
      storageRoot: storageRoot as unknown as FileSystemDirectoryHandle,
    });
    expect(await session.backend.loadSettings()).toMatchObject({
      endpoint: { url: "http://malformed-progress" },
    });
    await session.close();
  }, 60_000);

  it("enables and reopens through the public OPFS provider lifecycle", async () => {
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: "window",
      name: "opfs-root",
    });
    const locks = lockManager();
    vi.stubGlobal("navigator", {
      locks,
      storage: createInMemoryOpfsStorageManager({ root }),
    });
    const uninstallRuntime = installDevelopmentUnverifiedOpfsPersistenceRuntime({
      lockManager: locks,
    });

    try {
      const before = new OPFSStorageProvider();
      await before.init();
      await before.saveSettings({ settings: settings({ endpointUrl: "http://provider-before" }) });
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        await writeNativeManagedRootFile({ bytes, root, type });
      }
      await before.enableEncryption({
        onProgress: undefined,
        passphrase: PASSPHRASE,
        signal: undefined,
      });

      // The transition settles the initiating provider for reload. A fresh
      // provider instance must require and accept the persisted credential.
      const afterReload = new OPFSStorageProvider();
      await expect(afterReload.inspectEncryption()).resolves.toMatchObject({
        type: "credential_required",
      });
      await afterReload.unlockWithPassphrase({ passphrase: PASSPHRASE });
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        await expect(readEncryptedManagedRootFile({ provider: afterReload, type })).resolves.toEqual(bytes);
        await expect(root.getDirectoryHandle(
          getNaidanOpfsSpecialFileSystemDirectoryName({ type }),
          { create: false },
        )).rejects.toMatchObject({ name: "NotFoundError" });
      }
      await vi.waitFor(async () => {
        await expect(listNativePlainApplicationNamespaceEntryNames({
          nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
        })).resolves.toEqual([]);
      });
      expect(await afterReload.loadSettings()).toMatchObject({
        endpoint: { url: "http://provider-before" },
      });
      await afterReload.saveSettings({
        settings: settings({ endpointUrl: "http://provider-after" }),
      });
      await afterReload.dispose();

      const secondReload = new OPFSStorageProvider();
      await secondReload.unlockWithPassphrase({ passphrase: PASSPHRASE });
      expect(await secondReload.loadSettings()).toMatchObject({
        endpoint: { url: "http://provider-after" },
      });
      await secondReload.dispose();
    } finally {
      uninstallRuntime();
    }
  }, 60_000);

  it("does not infer plain cleanup ownership from stable HizoFS after a stale lease is released", async () => {
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: "window",
      name: "opfs-root",
    });
    const locks = lockManager();
    vi.stubGlobal("navigator", {
      locks,
      storage: createInMemoryOpfsStorageManager({ root }),
    });
    const uninstallRuntime = installDevelopmentUnverifiedOpfsPersistenceRuntime({
      lockManager: locks,
    });

    try {
      const before = new OPFSStorageProvider();
      await before.init();
      await before.saveSettings({ settings: settings({ endpointUrl: "http://cleanup-before" }) });
      await before.enableEncryption({
        onProgress: undefined,
        passphrase: PASSPHRASE,
        signal: undefined,
      });
      const storageRoot = await root.getDirectoryHandle(
        NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
        { create: false },
      );
      const unownedFile = await storageRoot.getFileHandle("unowned-after-stable.bin", { create: true });
      const unownedWritable = await unownedFile.createWritable();
      await unownedWritable.write(new Uint8Array([1, 3, 3, 7]));
      await unownedWritable.close();

      const releaseStalePlainLease = Promise.withResolvers<void>();
      const stalePlainLease = locks.request(
        OPFS_PLAIN_NAMESPACE_SESSION_LOCK_KEY,
        { mode: "shared" },
        async () => await releaseStalePlainLease.promise,
      );
      await vi.waitFor(async () => {
        expect((await locks.query()).held).toContainEqual({
          mode: "shared",
          name: OPFS_PLAIN_NAMESPACE_SESSION_LOCK_KEY,
        });
      });

      const firstReload = new OPFSStorageProvider();
      await firstReload.unlockWithPassphrase({ passphrase: PASSPHRASE });
      await expect(listNativePlainApplicationNamespaceEntryNames({
        nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
      })).resolves.toEqual(["unowned-after-stable.bin"]);
      await vi.waitFor(async () => {
        await expect(firstReload.loadSettings()).resolves.toMatchObject({
          endpoint: { url: "http://cleanup-before" },
        });
      });
      await firstReload.dispose();

      releaseStalePlainLease.resolve();
      await stalePlainLease;

      const secondReload = new OPFSStorageProvider();
      await secondReload.unlockWithPassphrase({ passphrase: PASSPHRASE });
      await expect(listNativePlainApplicationNamespaceEntryNames({
        nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
      })).resolves.toEqual(["unowned-after-stable.bin"]);
      expect(await secondReload.loadSettings()).toMatchObject({
        endpoint: { url: "http://cleanup-before" },
      });
      await secondReload.dispose();
    } finally {
      uninstallRuntime();
    }
  }, 60_000);


  it("keeps plaintext cleanup as an explicit retryable transition until all managed roots are removed", async () => {
    let failCleanup = false;
    const cleanupFailure = new DOMException("cleanup fault", "NoModificationAllowedError");
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: "window",
      faultHooks: {
        beforeRemoveEntry: async () => {
          if (failCleanup) throw cleanupFailure;
        },
      },
      name: "opfs-root",
    });
    const locks = lockManager();
    vi.stubGlobal("navigator", {
      locks,
      storage: createInMemoryOpfsStorageManager({ root }),
    });
    const uninstallRuntime = installDevelopmentUnverifiedOpfsPersistenceRuntime({
      lockManager: locks,
    });
    const warning = vi.spyOn(console, "warn");

    try {
      const before = new OPFSStorageProvider();
      await before.init();
      await before.saveSettings({ settings: settings({ endpointUrl: "http://cleanup-fault" }) });
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        await writeNativeManagedRootFile({ bytes, root, type });
      }

      failCleanup = true;
      await expect(before.enableEncryption({
        onProgress: undefined,
        passphrase: PASSPHRASE,
        signal: undefined,
      })).rejects.toBe(cleanupFailure);

      await vi.waitFor(async () => {
        expect(warning).toHaveBeenCalledWith("[HIZOFS_TRIAL_DEBUG_001]", expect.objectContaining({
          event: "retired_plain_cleanup",
          failure: expect.objectContaining({
            errorMessage: "cleanup fault",
            errorName: "NoModificationAllowedError",
          }),
          stage: "failed",
        }));
      });

      const pending = new OPFSStorageProvider();
      await expect(pending.inspectEncryption()).resolves.toMatchObject({
        requiredAction: "converge_transition",
        type: "credential_required",
      });
      await expect(listNativePlainApplicationNamespaceEntryNames({
        nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
      })).resolves.not.toEqual([]);
      for (const { type } of MANAGED_SPECIAL_FILE_CASES) {
        await expect(root.getDirectoryHandle(
          getNaidanOpfsSpecialFileSystemDirectoryName({ type }),
          { create: false },
        )).resolves.toBeDefined();
      }

      await expect(pending.convergeTransitionWithPassphrase({
        passphrase: PASSPHRASE,
        signal: undefined,
      })).rejects.toBe(cleanupFailure);

      failCleanup = false;
      await expect(pending.convergeTransitionWithPassphrase({
        passphrase: PASSPHRASE,
        signal: undefined,
      })).resolves.toBeUndefined();

      const afterCleanup = new OPFSStorageProvider();
      await afterCleanup.unlockWithPassphrase({ passphrase: PASSPHRASE });
      expect(await afterCleanup.loadSettings()).toMatchObject({
        endpoint: { url: "http://cleanup-fault" },
      });
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        await expect(readEncryptedManagedRootFile({ provider: afterCleanup, type })).resolves.toEqual(bytes);
        await expect(root.getDirectoryHandle(
          getNaidanOpfsSpecialFileSystemDirectoryName({ type }),
          { create: false },
        )).rejects.toMatchObject({ name: "NotFoundError" });
      }
      await expect(listNativePlainApplicationNamespaceEntryNames({
        nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
      })).resolves.toEqual([]);
      await afterCleanup.dispose();
    } finally {
      warning.mockRestore();
      uninstallRuntime();
    }
  }, 60_000);

  it.each([
    { interruption: "before authority switch", phase: "verifying" },
    { interruption: "after authority switch", phase: "cleaning_source" },
  ] as const)(
    "converges an enable interruption $interruption at the coarse authority boundary",
    async ({ phase }) => {
      const root = new InMemoryOpfsDirectoryHandle({
        capabilityProfile: "window",
        name: "opfs-root",
      });
      const locks = lockManager();
      vi.stubGlobal("navigator", {
        locks,
        storage: createInMemoryOpfsStorageManager({ root }),
      });
      const uninstallRuntime = installDevelopmentUnverifiedOpfsPersistenceRuntime({
        lockManager: locks,
      });
      const controller = new AbortController();
      let interrupted = false;

      try {
        const plain = new OPFSStorageProvider();
        await plain.init();
        await plain.saveSettings({
          settings: settings({ endpointUrl: `http://return-${phase}` }),
        });
        for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
          await writeNativeManagedRootFile({ bytes, root, type });
        }

        await expect(plain.enableEncryption({
          onProgress: ({ progress }) => {
            if (interrupted || progress.phase !== phase) return;
            interrupted = true;
            controller.abort(new DOMException("planned interruption", "AbortError"));
          },
          passphrase: PASSPHRASE,
          signal: controller.signal,
        })).rejects.toMatchObject({ name: "AbortError" });
        expect(interrupted).toBe(true);

        const recovery = new OPFSStorageProvider();
        await expect(recovery.inspectEncryption()).resolves.toMatchObject({
          requiredAction: "converge_transition",
          type: "credential_required",
        });
        switch (phase) {
        case "verifying": {
          await recovery.returnInterruptedEncryptionToPlain({
            onProgress: undefined,
            passphrase: PASSPHRASE,
            signal: undefined,
          });
          const sourceAfterReload = new OPFSStorageProvider();
          await sourceAfterReload.init();
          await expect(sourceAfterReload.inspectEncryption()).resolves.toMatchObject({ type: "plain" });
          await expect(sourceAfterReload.loadSettings()).resolves.toMatchObject({
            endpoint: { url: `http://return-${phase}` },
          });
          for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
            await expect(readNativeManagedRootFile({ root, type })).resolves.toEqual(bytes);
          }
          await sourceAfterReload.enableEncryption({
            onProgress: undefined,
            passphrase: PASSPHRASE,
            signal: undefined,
          });
          const freshTarget = new OPFSStorageProvider();
          await freshTarget.unlockWithPassphrase({ passphrase: PASSPHRASE });
          await expect(freshTarget.loadSettings()).resolves.toMatchObject({
            endpoint: { url: `http://return-${phase}` },
          });
          for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
            await expect(readEncryptedManagedRootFile({ provider: freshTarget, type })).resolves.toEqual(bytes);
            await expect(root.getDirectoryHandle(
              getNaidanOpfsSpecialFileSystemDirectoryName({ type }),
              { create: false },
            )).rejects.toMatchObject({ name: "NotFoundError" });
          }
          await freshTarget.dispose();
          break;
        }
        case "cleaning_source": {
          await recovery.convergeTransitionWithPassphrase({
            passphrase: PASSPHRASE,
            signal: undefined,
          });
          const targetAfterReload = new OPFSStorageProvider();
          await targetAfterReload.unlockWithPassphrase({ passphrase: PASSPHRASE });
          await expect(targetAfterReload.loadSettings()).resolves.toMatchObject({
            endpoint: { url: `http://return-${phase}` },
          });
          for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
            await expect(readEncryptedManagedRootFile({ provider: targetAfterReload, type })).resolves.toEqual(bytes);
            await expect(root.getDirectoryHandle(
              getNaidanOpfsSpecialFileSystemDirectoryName({ type }),
              { create: false },
            )).rejects.toMatchObject({ name: "NotFoundError" });
          }
          await targetAfterReload.dispose();
          break;
        }
        default: phase satisfies never;
        }
        const storageRoot = await root.getDirectoryHandle(
          NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
          { create: false },
        );
        await expectNoPersistentTransitionProgress({
          storageRoot: storageRoot as unknown as FileSystemDirectoryHandle,
        });
      } finally {
        uninstallRuntime();
      }
    },
    60_000,
  );

});
