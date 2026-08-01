import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSchemaDto } from "@/00-storage/00-dto/dto";
import type { Settings } from "@/01-models/types";
import {
  installDevelopmentUnverifiedOpfsPersistenceRuntime,
} from "@/00-storage/service/naidan-opfs/development-persistence-runtime";
import { NAIDAN_OPFS_STORAGE_DIRECTORY_NAME } from "@/00-storage/service/naidan-opfs/opfs-storage-location";
import { HIZOFS_TRIAL_DEBUG_MARKER } from "@/00-storage/service/naidan-opfs/trial-debug";
import { TEST_ONLY as RETIRED_PROGRESS_TEST_ONLY } from "@/00-storage/service/naidan-opfs/retired-local-transition-progress-cleanup";
import { listNativePlainApplicationNamespaceEntryNames } from "@/00-storage/service/naidan-opfs/native-plain-application-namespace";
import {
  NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS,
} from "@/00-storage/service/naidan-persistence-control/00-format";
import { OPFSStorageProvider } from "@/00-storage/service/opfs-storage";
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

async function listEntryNames({ directory }: {
  directory: FileSystemDirectoryHandle;
}): Promise<readonly string[]> {
  const names: string[] = [];
  for await (const [name] of directory.entries()) names.push(name);
  return names.toSorted();
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

describe("browserless production HizoFS disable system", () => {
  it("disables, reloads into plain storage, writes, reopens, and removes the retired HizoFS container", async () => {
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: "window",
      name: "opfs-root",
    });
    const locks = new InMemoryWebLockManager();
    vi.stubGlobal("navigator", {
      locks,
      storage: createInMemoryOpfsStorageManager({ root }),
    });
    const uninstallRuntime = installDevelopmentUnverifiedOpfsPersistenceRuntime({
      lockManager: locks,
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const plainBeforeEnable = new OPFSStorageProvider();
      await plainBeforeEnable.init();
      await plainBeforeEnable.saveSettings({
        settings: settings({ endpointUrl: "http://plain-before-enable" }),
      });
      await plainBeforeEnable.enableEncryption({
        onProgress: undefined,
        passphrase: PASSPHRASE,
        signal: undefined,
      });

      const encryptedAfterReload = new OPFSStorageProvider();
      await expect(encryptedAfterReload.inspectEncryptionSettings()).resolves.toEqual({
        access: "locked",
        type: "encrypted",
      });
      await encryptedAfterReload.unlockWithPassphrase({ passphrase: PASSPHRASE });
      const unlockedSettingsInspection = await encryptedAfterReload.inspectEncryptionSettings();
      expect(unlockedSettingsInspection.type).toBe("encrypted");
      if (unlockedSettingsInspection.type !== "encrypted") {
        throw new Error("Expected unlocked encrypted settings inspection");
      }
      expect(unlockedSettingsInspection.access).toBe("unlocked");
      await vi.waitFor(async () => {
        await expect(listNativePlainApplicationNamespaceEntryNames({
          nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
        })).resolves.toEqual([]);
      });
      expect(await encryptedAfterReload.loadSettings()).toMatchObject({
        endpoint: { url: "http://plain-before-enable" },
      });
      await encryptedAfterReload.saveSettings({
        settings: settings({ endpointUrl: "http://encrypted-before-disable" }),
      });
      const storageRoot = await root.getDirectoryHandle(
        NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
        { create: false },
      );
      const encryptedStorageEntries = await listEntryNames({
        directory: storageRoot as unknown as FileSystemDirectoryHandle,
      });
      const persistenceControlDirectoryName =
        NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName;
      const [retiredHizoFSContainerName, ...unexpectedEncryptedEntries] =
        encryptedStorageEntries.filter(name => name !== persistenceControlDirectoryName);
      expect(retiredHizoFSContainerName).toBeDefined();
      expect(unexpectedEncryptedEntries).toEqual([]);

      await encryptedAfterReload.disableEncryption({
        onProgress: undefined,
        signal: undefined,
      });
      await expectNoPersistentTransitionProgress({
        storageRoot: storageRoot as unknown as FileSystemDirectoryHandle,
      });

      // The initiating encrypted provider is settled for reload. A fresh
      // provider must discover stable plain authority without a credential.
      const plainAfterReload = new OPFSStorageProvider();
      await expect(plainAfterReload.inspectEncryption()).resolves.toMatchObject({ type: "plain" });
      await expect(plainAfterReload.inspectEncryptionSettings()).resolves.toEqual({ type: "plain" });
      await plainAfterReload.init();
      expect(await plainAfterReload.loadSettings()).toMatchObject({
        endpoint: { url: "http://encrypted-before-disable" },
      });
      await plainAfterReload.saveSettings({
        settings: settings({ endpointUrl: "http://plain-after-disable" }),
      });

      await vi.waitFor(async () => {
        const plainStorageEntries = await listEntryNames({
          directory: storageRoot as unknown as FileSystemDirectoryHandle,
        });
        expect(plainStorageEntries).toContain(persistenceControlDirectoryName);
        expect(plainStorageEntries).toContain("settings.json");
        expect(plainStorageEntries).not.toContain(retiredHizoFSContainerName);
      });
      const rawSettingsFile = await (await storageRoot.getFileHandle("settings.json")).getFile();
      const rawSettings = SettingsSchemaDto.parse(JSON.parse(await rawSettingsFile.text()));
      expect(rawSettings.endpoint).toMatchObject({ url: "http://plain-after-disable" });
      await plainAfterReload.dispose();

      const plainSecondReload = new OPFSStorageProvider();
      await plainSecondReload.init();
      await expect(plainSecondReload.inspectEncryption()).resolves.toMatchObject({ type: "plain" });
      expect(await plainSecondReload.loadSettings()).toMatchObject({
        endpoint: { url: "http://plain-after-disable" },
      });
      await plainSecondReload.dispose();

      const disableStages = info.mock.calls.flatMap(([marker, detail]) => {
        if (marker !== `[${HIZOFS_TRIAL_DEBUG_MARKER}]`
          || typeof detail !== "object"
          || detail === null
          || !("event" in detail)
          || detail.event !== "native_disable"
          || !("stage" in detail)
          || typeof detail.stage !== "string") return [];
        return [detail.stage];
      });
      expect(disableStages[0]).toBe("started");
      expect(disableStages).toContain("persistence_transition_started");
      expect(disableStages).toContain("runtime_prepared");
      expect(disableStages).toContain("verifying");
      expect(disableStages).toContain("authority_switched");
      expect(disableStages).toContain("retired_cleanup");
      expect(disableStages.at(-1)).toBe("stable");
      expect(disableStages.every(stage => [
        "started",
        "persistence_transition_started",
        "runtime_prepared",
        "copying",
        "verifying",
        "authority_switched",
        "retired_cleanup",
        "stable",
      ].includes(stage))).toBe(true);
      expect(warn.mock.calls.some(([, detail]) => typeof detail === "object"
        && detail !== null
        && "event" in detail
        && detail.event === "native_disable_failure")).toBe(false);
    } finally {
      uninstallRuntime();
    }
  }, 60_000);

  it("keeps HizoFS authoritative and retries disable from scratch after restart when verification is interrupted", async () => {
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: "window",
      name: "opfs-root",
    });
    const locks = new InMemoryWebLockManager();
    vi.stubGlobal("navigator", {
      locks,
      storage: createInMemoryOpfsStorageManager({ root }),
    });
    const uninstallRuntime = installDevelopmentUnverifiedOpfsPersistenceRuntime({
      lockManager: locks,
    });
    const controller = new AbortController();
    let abortedDuringVerification = false;

    try {
      const plainBeforeEnable = new OPFSStorageProvider();
      await plainBeforeEnable.init();
      await plainBeforeEnable.saveSettings({
        settings: settings({ endpointUrl: "http://before-interrupted-disable" }),
      });
      await plainBeforeEnable.enableEncryption({
        onProgress: undefined,
        passphrase: PASSPHRASE,
        signal: undefined,
      });

      const encrypted = new OPFSStorageProvider();
      await encrypted.unlockWithPassphrase({ passphrase: PASSPHRASE });
      await encrypted.saveSettings({
        settings: settings({ endpointUrl: "http://encrypted-before-interruption" }),
      });

      await expect(encrypted.disableEncryption({
        onProgress: ({ progress }) => {
          if (progress.phase !== "verifying" || abortedDuringVerification) return;
          abortedDuringVerification = true;
          controller.abort();
        },
        signal: controller.signal,
      })).rejects.toMatchObject({ name: "AbortError" });
      expect(abortedDuringVerification).toBe(true);
      await encrypted.dispose();

      const afterRestart = new OPFSStorageProvider();
      await expect(afterRestart.inspectEncryption()).resolves.toMatchObject({
        requiredAction: "converge_transition",
        type: "credential_required",
      });
      await expect(afterRestart.init()).rejects.toThrow(/encryption|transition/i);
      await afterRestart.convergeTransitionWithPassphrase({
        passphrase: PASSPHRASE,
        signal: undefined,
      });
      await afterRestart.dispose();

      const encryptedAfterConvergence = new OPFSStorageProvider();
      await expect(encryptedAfterConvergence.inspectEncryption()).resolves.toMatchObject({
        requiredAction: "unlock",
        type: "credential_required",
      });
      await encryptedAfterConvergence.unlockWithPassphrase({ passphrase: PASSPHRASE });
      expect(await encryptedAfterConvergence.loadSettings()).toMatchObject({
        endpoint: { url: "http://encrypted-before-interruption" },
      });
      await encryptedAfterConvergence.disableEncryption({
        onProgress: undefined,
        signal: undefined,
      });
      await encryptedAfterConvergence.dispose();

      const plainAfterRetry = new OPFSStorageProvider();
      await plainAfterRetry.init();
      await expect(plainAfterRetry.inspectEncryptionSettings()).resolves.toEqual({ type: "plain" });
      expect(await plainAfterRetry.loadSettings()).toMatchObject({
        endpoint: { url: "http://encrypted-before-interruption" },
      });
      await plainAfterRetry.dispose();
    } finally {
      uninstallRuntime();
    }
  }, 60_000);
  it("keeps stable plain storage usable when retired HizoFS cleanup fails and retries after restart", async () => {
    let cleanupFaultCount = 0;
    let failRetiredCleanup = false;
    let retiredHizoFSContainerName: string | undefined;
    const cleanupFailure = new DOMException("retired HizoFS cleanup fault", "NoModificationAllowedError");
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: "window",
      faultHooks: {
        beforeRemoveEntry: async ({ name }) => {
          if (!failRetiredCleanup || name !== retiredHizoFSContainerName) return;
          cleanupFaultCount += 1;
          throw cleanupFailure;
        },
      },
      name: "opfs-root",
    });
    const locks = new InMemoryWebLockManager();
    vi.stubGlobal("navigator", {
      locks,
      storage: createInMemoryOpfsStorageManager({ root }),
    });
    const uninstallRuntime = installDevelopmentUnverifiedOpfsPersistenceRuntime({
      lockManager: locks,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const plainBeforeEnable = new OPFSStorageProvider();
      await plainBeforeEnable.init();
      await plainBeforeEnable.saveSettings({
        settings: settings({ endpointUrl: "http://before-cleanup-failure" }),
      });
      await plainBeforeEnable.enableEncryption({
        onProgress: undefined,
        passphrase: PASSPHRASE,
        signal: undefined,
      });

      const encrypted = new OPFSStorageProvider();
      await encrypted.unlockWithPassphrase({ passphrase: PASSPHRASE });
      await encrypted.saveSettings({
        settings: settings({ endpointUrl: "http://plain-authority-after-cleanup-failure" }),
      });
      const storageRoot = await root.getDirectoryHandle(
        NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
        { create: false },
      );
      const persistenceControlDirectoryName =
        NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName;
      [retiredHizoFSContainerName] = (await listEntryNames({
        directory: storageRoot as unknown as FileSystemDirectoryHandle,
      })).filter(name => name !== persistenceControlDirectoryName);
      expect(retiredHizoFSContainerName).toBeDefined();

      failRetiredCleanup = true;
      await expect(encrypted.disableEncryption({
        onProgress: undefined,
        signal: undefined,
      })).resolves.toBeUndefined();

      const plainAfterCleanupFailure = new OPFSStorageProvider();
      await plainAfterCleanupFailure.init();
      await expect(plainAfterCleanupFailure.inspectEncryption()).resolves.toMatchObject({ type: "plain" });
      expect(await plainAfterCleanupFailure.loadSettings()).toMatchObject({
        endpoint: { url: "http://plain-authority-after-cleanup-failure" },
      });
      expect(await listEntryNames({
        directory: storageRoot as unknown as FileSystemDirectoryHandle,
      })).toContain(retiredHizoFSContainerName);
      await plainAfterCleanupFailure.dispose();

      failRetiredCleanup = false;
      const plainAfterCleanupRetry = new OPFSStorageProvider();
      await plainAfterCleanupRetry.init();
      await vi.waitFor(async () => {
        expect(await listEntryNames({
          directory: storageRoot as unknown as FileSystemDirectoryHandle,
        })).not.toContain(retiredHizoFSContainerName);
      });
      expect(await plainAfterCleanupRetry.loadSettings()).toMatchObject({
        endpoint: { url: "http://plain-authority-after-cleanup-failure" },
      });
      await plainAfterCleanupRetry.dispose();
      expect(cleanupFaultCount).toBeGreaterThan(0);
      expect(error).toHaveBeenCalledWith(
        '[opfs-encryption] deferred startup maintenance failed',
        cleanupFailure,
      );
    } finally {
      error.mockRestore();
      warning.mockRestore();
      uninstallRuntime();
    }
  }, 60_000);

});
