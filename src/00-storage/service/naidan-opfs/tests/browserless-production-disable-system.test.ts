import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSchemaDto } from "@/00-storage/00-dto/dto";
import type { Settings } from "@/01-models/types";
import {
  installDevelopmentUnverifiedOpfsPersistenceRuntime,
} from "@/00-storage/service/naidan-opfs/development-persistence-runtime";
import { NAIDAN_OPFS_STORAGE_DIRECTORY_NAME } from "@/00-storage/service/naidan-opfs/opfs-storage-location";
import { getNaidanOpfsSpecialFileSystemDirectoryName } from "@/00-storage/service/opfs/naidan-opfs-root-directory-registry";
import { HIZOFS_TRIAL_DEBUG_MARKER } from "@/00-storage/service/naidan-opfs/trial-debug";
import { TEST_ONLY as RETIRED_PROGRESS_TEST_ONLY } from "@/00-storage/service/naidan-opfs/retired-local-transition-progress-cleanup";
import {
  createNativePlainApplicationNamespaceSession,
  listNativePlainApplicationNamespaceEntryNames,
} from "@/00-storage/service/naidan-opfs/native-plain-application-namespace";
import { openActiveAuthenticatedHizoFSDecryptedSnapshotLease } from "@/00-storage/service/naidan-opfs/active-hizofs-container-location";
import {
  NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS,
} from "@/00-storage/service/naidan-persistence-control/00-format";
import { OPFSStorageProvider } from "@/00-storage/service/opfs-storage";
import { StorageService } from "@/00-storage/service";
import type { OpfsSpecialFileSystemType } from "@/00-storage/service/opfs/opfs-special-file-system";
import type { StorageDirectoryHandle } from "@/00-storage/service/storage-file-system/types";
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

async function listStorageEntryNames({ directory }: {
  directory: StorageDirectoryHandle;
}): Promise<readonly string[]> {
  const names: string[] = [];
  for await (const [name] of directory.entries()) names.push(name);
  return names.toSorted();
}

async function writeFileBytes({ bytes, directory, name }: {
  bytes: Uint8Array<ArrayBuffer>;
  directory: FileSystemDirectoryHandle;
  name: string;
}): Promise<void> {
  const writable = await (await directory.getFileHandle(name, { create: true })).createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function readFileBytes({ directory, name }: {
  directory: FileSystemDirectoryHandle;
  name: string;
}): Promise<Uint8Array> {
  const file = await (await directory.getFileHandle(name, { create: false })).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

const MANAGED_SPECIAL_FILE_CASES = [
  { bytes: Uint8Array.of(41, 42), type: "chat_wesh" },
  { bytes: Uint8Array.of(51, 52, 53), type: "debug_wesh" },
  { bytes: Uint8Array.of(61, 62, 63, 64), type: "tmp" },
] as const satisfies readonly Readonly<{
  bytes: Uint8Array<ArrayBuffer>;
  type: OpfsSpecialFileSystemType;
}>[];

async function writeEncryptedManagedRootFile({ bytes, provider, type }: {
  bytes: Uint8Array<ArrayBuffer>;
  provider: OPFSStorageProvider;
  type: OpfsSpecialFileSystemType;
}): Promise<void> {
  const access = await provider.openSpecialFileSystemDirectory({
    create: true,
    path: "/",
    type,
  });
  if (access?.type !== "storage_directory") {
    throw new Error("Expected encrypted managed root storage directory");
  }
  const file = await access.handle.getFileHandle({
    create: true,
    name: "transition-value.bin",
  });
  const writable = await file.createWritable({ keepExistingData: false });
  await writable.write({ data: bytes, position: 0 });
  await writable.close();
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
  it("rejects fresh disable before durable start and preserves unowned plain bytes", async () => {
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
    const unownedFileBytes = new Uint8Array([0, 255, 17, 34, 51]);
    const unownedNestedBytes = new Uint8Array([99, 0, 100, 200]);

    try {
      const plain = new OPFSStorageProvider();
      await plain.init();
      await plain.saveSettings({
        settings: settings({ endpointUrl: "http://hizofs-source-before-conflict" }),
      });
      await plain.enableEncryption({
        onProgress: undefined,
        passphrase: PASSPHRASE,
        signal: undefined,
      });

      const encrypted = new OPFSStorageProvider();
      await encrypted.unlockWithPassphrase({ passphrase: PASSPHRASE });
      await encrypted.saveSettings({
        settings: settings({ endpointUrl: "http://hizofs-source-after-conflict" }),
      });
      await vi.waitFor(async () => {
        await expect(listNativePlainApplicationNamespaceEntryNames({
          nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
        })).resolves.toEqual([]);
      });

      const storageRoot = await root.getDirectoryHandle(
        NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
        { create: false },
      );
      await writeFileBytes({
        bytes: unownedFileBytes,
        directory: storageRoot as unknown as FileSystemDirectoryHandle,
        name: "unowned-plain.bin",
      });
      const unownedDirectory = await storageRoot.getDirectoryHandle("unowned-plain-directory", { create: true });
      await writeFileBytes({
        bytes: unownedNestedBytes,
        directory: unownedDirectory as unknown as FileSystemDirectoryHandle,
        name: "nested.bin",
      });

      await expect(encrypted.disableEncryption({
        onProgress: undefined,
        signal: undefined,
      })).rejects.toThrow("unowned application bytes");

      const afterReload = new OPFSStorageProvider();
      await expect(afterReload.inspectEncryption()).resolves.toMatchObject({
        requiredAction: "unlock",
        type: "credential_required",
      });
      await expect(listNativePlainApplicationNamespaceEntryNames({
        nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
      })).resolves.toEqual(["unowned-plain-directory", "unowned-plain.bin"]);
      await expect(readFileBytes({
        directory: storageRoot as unknown as FileSystemDirectoryHandle,
        name: "unowned-plain.bin",
      })).resolves.toEqual(unownedFileBytes);
      const unownedDirectoryAfterReload = await storageRoot.getDirectoryHandle(
        "unowned-plain-directory",
        { create: false },
      );
      await expect(readFileBytes({
        directory: unownedDirectoryAfterReload as unknown as FileSystemDirectoryHandle,
        name: "nested.bin",
      })).resolves.toEqual(unownedNestedBytes);

      await afterReload.unlockWithPassphrase({ passphrase: PASSPHRASE });
      await expect(afterReload.loadSettings()).resolves.toMatchObject({
        endpoint: { url: "http://hizofs-source-after-conflict" },
      });
      await expect(readFileBytes({
        directory: storageRoot as unknown as FileSystemDirectoryHandle,
        name: "unowned-plain.bin",
      })).resolves.toEqual(unownedFileBytes);
      await afterReload.dispose();
    } finally {
      uninstallRuntime();
    }
  }, 60_000);

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
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        await writeEncryptedManagedRootFile({ bytes, provider: encryptedAfterReload, type });
      }
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
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        const directory = await root.getDirectoryHandle(
          getNaidanOpfsSpecialFileSystemDirectoryName({ type }),
          { create: false },
        );
        await expect(readFileBytes({
          directory: directory as unknown as FileSystemDirectoryHandle,
          name: "transition-value.bin",
        })).resolves.toEqual(bytes);
      }
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

  it("disables after raw-conflict cleanup when the encrypted source has absent and empty managed roots", async () => {
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

    try {
      const plain = new OPFSStorageProvider();
      await plain.init();
      await plain.saveSettings({
        settings: settings({ endpointUrl: "http://partial-managed-root-source" }),
      });
      await plain.enableEncryption({
        onProgress: undefined,
        passphrase: PASSPHRASE,
        signal: undefined,
      });

      const encrypted = new StorageService();
      await expect(encrypted.init({ type: "opfs" }))
        .rejects.toThrow("OPFS encryption must be unlocked before storage can be used");
      await encrypted.unlockOpfsEncryptionWithPassphrase({ passphrase: PASSPHRASE });
      await encrypted.clearOpfsSpecialFileSystem({ type: "tmp" });
      const nestedChat = await encrypted.openOpfsSpecialFileSystemDirectory({
        create: true,
        path: "/nested",
        type: "chat_wesh",
      });
      if (nestedChat?.type !== "storage_directory") {
        throw new Error("Expected encrypted nested chat storage directory");
      }
      const nestedFile = await nestedChat.handle.getFileHandle({ create: true, name: "value.bin" });
      const nestedWritable = await nestedFile.createWritable({ keepExistingData: false });
      await nestedWritable.write({ data: Uint8Array.of(71, 72), position: 0 });
      await nestedWritable.close();

      const storageRoot = await root.getDirectoryHandle(
        NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
        { create: false },
      );
      await writeFileBytes({
        bytes: Uint8Array.of(91, 92, 93),
        directory: storageRoot as unknown as FileSystemDirectoryHandle,
        name: "stale-disable-target.bin",
      });
      const conflict = await encrypted.inspectOpfsEncryptionDisableConflict();
      expect(conflict).toMatchObject({ type: "conflict" });
      if (conflict.type !== "conflict") throw new Error("Expected a native plain target conflict");
      await expect(encrypted.cleanupOpfsEncryptionDisableConflict({ inspectionId: conflict.inspectionId }))
        .resolves.toEqual({ type: "clear" });

      const encryptedSnapshot = await openActiveAuthenticatedHizoFSDecryptedSnapshotLease();
      if (encryptedSnapshot === undefined) throw new Error("Expected an active encrypted snapshot");
      await expect(listStorageEntryNames({ directory: encryptedSnapshot.root })).resolves.toEqual([
        "naidan-chat-wesh",
        "naidan-debug-wesh",
        "naidan-storage",
      ]);
      const emptyDebugRoot = await encryptedSnapshot.root.getDirectoryHandle({
        create: false,
        name: "naidan-debug-wesh",
      });
      await expect(listStorageEntryNames({ directory: emptyDebugRoot })).resolves.toEqual([]);
      const encryptedChatRoot = await encryptedSnapshot.root.getDirectoryHandle({
        create: false,
        name: "naidan-chat-wesh",
      });
      await expect(listStorageEntryNames({ directory: encryptedChatRoot })).resolves.toEqual(["nested"]);
      await encryptedSnapshot.dispose();

      const plainProjection = createNativePlainApplicationNamespaceSession({
        nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
      });
      await expect(listStorageEntryNames({ directory: plainProjection.root })).resolves.toEqual([
        "naidan-chat-wesh",
        "naidan-debug-wesh",
        "naidan-storage",
        "naidan-tmp",
      ]);
      await plainProjection.close();

      await encrypted.disableOpfsEncryption({
        onProgress: undefined,
        signal: undefined,
      });

      const reopenedPlain = new OPFSStorageProvider();
      await expect(reopenedPlain.inspectEncryption()).resolves.toMatchObject({ type: "plain" });
      await reopenedPlain.init();
      await expect(reopenedPlain.loadSettings()).resolves.toMatchObject({
        endpoint: { url: "http://partial-managed-root-source" },
      });
      const plainNestedChat = await root.getDirectoryHandle("naidan-chat-wesh", { create: false });
      const plainNestedDirectory = await plainNestedChat.getDirectoryHandle("nested", { create: false });
      await expect(readFileBytes({
        directory: plainNestedDirectory as unknown as FileSystemDirectoryHandle,
        name: "value.bin",
      })).resolves.toEqual(Uint8Array.of(71, 72));
      await reopenedPlain.dispose();
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
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        await writeEncryptedManagedRootFile({ bytes, provider: encrypted, type });
      }

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
      await expect(listNativePlainApplicationNamespaceEntryNames({
        nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
      })).resolves.toContain("settings.json");
      await afterRestart.convergeTransitionWithPassphrase({
        passphrase: PASSPHRASE,
        signal: undefined,
      });
      await expect(listNativePlainApplicationNamespaceEntryNames({
        nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
      })).resolves.toEqual([]);
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
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        await expect(readEncryptedManagedRootFile({
          provider: encryptedAfterConvergence,
          type,
        })).resolves.toEqual(bytes);
      }
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
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        const directory = await root.getDirectoryHandle(
          getNaidanOpfsSpecialFileSystemDirectoryName({ type }),
          { create: false },
        );
        await expect(readFileBytes({
          directory: directory as unknown as FileSystemDirectoryHandle,
          name: "transition-value.bin",
        })).resolves.toEqual(bytes);
      }
      await plainAfterRetry.dispose();
    } finally {
      uninstallRuntime();
    }
  }, 60_000);

  it("keeps plain OPFS authoritative after disable is interrupted immediately after authority switch", async () => {
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
    let interruptedAfterAuthoritySwitch = false;

    try {
      const plainBeforeEnable = new OPFSStorageProvider();
      await plainBeforeEnable.init();
      await plainBeforeEnable.saveSettings({
        settings: settings({ endpointUrl: "http://before-post-switch-disable" }),
      });
      await plainBeforeEnable.enableEncryption({
        onProgress: undefined,
        passphrase: PASSPHRASE,
        signal: undefined,
      });

      const encrypted = new OPFSStorageProvider();
      await encrypted.unlockWithPassphrase({ passphrase: PASSPHRASE });
      await encrypted.saveSettings({
        settings: settings({ endpointUrl: "http://plain-after-post-switch-disable" }),
      });
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        await writeEncryptedManagedRootFile({ bytes, provider: encrypted, type });
      }
      await expect(encrypted.disableEncryption({
        onProgress: ({ progress }) => {
          if (progress.phase !== "switching_authority" || interruptedAfterAuthoritySwitch) return;
          interruptedAfterAuthoritySwitch = true;
          controller.abort(new DOMException("planned post-switch interruption", "AbortError"));
        },
        signal: controller.signal,
      })).rejects.toMatchObject({ name: "AbortError" });
      expect(interruptedAfterAuthoritySwitch).toBe(true);

      const recovery = new OPFSStorageProvider();
      await expect(recovery.inspectEncryption()).resolves.toMatchObject({
        requiredAction: "converge_transition",
        type: "credential_required",
      });
      await recovery.convergeTransitionWithPassphrase({
        passphrase: PASSPHRASE,
        signal: undefined,
      });

      const plainAfterReload = new OPFSStorageProvider();
      await plainAfterReload.init();
      await expect(plainAfterReload.inspectEncryptionSettings()).resolves.toEqual({ type: "plain" });
      await expect(plainAfterReload.loadSettings()).resolves.toMatchObject({
        endpoint: { url: "http://plain-after-post-switch-disable" },
      });
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        const directory = await root.getDirectoryHandle(
          getNaidanOpfsSpecialFileSystemDirectoryName({ type }),
          { create: false },
        );
        await expect(readFileBytes({
          directory: directory as unknown as FileSystemDirectoryHandle,
          name: "transition-value.bin",
        })).resolves.toEqual(bytes);
      }
      const storageRoot = await root.getDirectoryHandle(
        NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
        { create: false },
      );
      await expectNoPersistentTransitionProgress({
        storageRoot: storageRoot as unknown as FileSystemDirectoryHandle,
      });
      await plainAfterReload.dispose();
    } finally {
      uninstallRuntime();
    }
  }, 60_000);

  it("keeps recovery required and preserves HizoFS when abandoned plaintext cleanup fails", async () => {
    let failAbandonedPlainCleanup = false;
    const cleanupFailure = new DOMException("abandoned plaintext cleanup fault", "NoModificationAllowedError");
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: "window",
      faultHooks: {
        beforeRemoveEntry: async ({ name }) => {
          if (failAbandonedPlainCleanup && name === "settings.json") throw cleanupFailure;
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
    const controller = new AbortController();

    try {
      const plain = new OPFSStorageProvider();
      await plain.init();
      await plain.saveSettings({
        settings: settings({ endpointUrl: "http://source-survives-cleanup-fault" }),
      });
      await plain.enableEncryption({
        onProgress: undefined,
        passphrase: PASSPHRASE,
        signal: undefined,
      });

      const encrypted = new OPFSStorageProvider();
      await encrypted.unlockWithPassphrase({ passphrase: PASSPHRASE });
      await vi.waitFor(async () => {
        await expect(listNativePlainApplicationNamespaceEntryNames({
          nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
        })).resolves.toEqual([]);
      });
      await vi.waitFor(async () => {
        await expect(encrypted.loadSettings()).resolves.toMatchObject({
          endpoint: { url: "http://source-survives-cleanup-fault" },
        });
      });
      await expect(encrypted.disableEncryption({
        onProgress: ({ progress }) => {
          if (progress.phase === "verifying") controller.abort();
        },
        signal: controller.signal,
      })).rejects.toMatchObject({ name: "AbortError" });

      failAbandonedPlainCleanup = true;
      const failedRecovery = new OPFSStorageProvider();
      await expect(failedRecovery.convergeTransitionWithPassphrase({
        passphrase: PASSPHRASE,
        signal: undefined,
      })).rejects.toBe(cleanupFailure);
      await expect(failedRecovery.inspectEncryption()).resolves.toMatchObject({
        requiredAction: "converge_transition",
        type: "credential_required",
      });
      await expect(failedRecovery.init()).rejects.toThrow(/encryption|transition/i);
      await expect(failedRecovery.loadSettings()).rejects.toThrow(/suspended|not initialized or unlocked/);
      await expect(listNativePlainApplicationNamespaceEntryNames({
        nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
      })).resolves.toContain("settings.json");

      failAbandonedPlainCleanup = false;
      const retriedRecovery = new OPFSStorageProvider();
      await retriedRecovery.convergeTransitionWithPassphrase({
        passphrase: PASSPHRASE,
        signal: undefined,
      });
      await expect(listNativePlainApplicationNamespaceEntryNames({
        nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
      })).resolves.toEqual([]);

      const encryptedAfterRetry = new OPFSStorageProvider();
      await encryptedAfterRetry.unlockWithPassphrase({ passphrase: PASSPHRASE });
      await expect(encryptedAfterRetry.loadSettings()).resolves.toMatchObject({
        endpoint: { url: "http://source-survives-cleanup-fault" },
      });
      await encryptedAfterRetry.dispose();
    } finally {
      uninstallRuntime();
    }
  }, 60_000);

  it("retries convergence after abandoned plaintext deletion loses its response", async () => {
    let loseDeleteResponse = false;
    let lostDeleteResponse = false;
    const responseLoss = new DOMException("remove response lost", "UnknownError");
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: "window",
      faultHooks: {
        afterRemoveEntry: async ({ name }) => {
          if (!loseDeleteResponse || lostDeleteResponse || name !== "settings.json") return;
          lostDeleteResponse = true;
          throw responseLoss;
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
    const controller = new AbortController();

    try {
      const plain = new OPFSStorageProvider();
      await plain.init();
      await plain.saveSettings({
        settings: settings({ endpointUrl: "http://source-after-delete-response-loss" }),
      });
      await plain.enableEncryption({
        onProgress: undefined,
        passphrase: PASSPHRASE,
        signal: undefined,
      });

      const encrypted = new OPFSStorageProvider();
      await encrypted.unlockWithPassphrase({ passphrase: PASSPHRASE });
      await vi.waitFor(async () => {
        await expect(listNativePlainApplicationNamespaceEntryNames({
          nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
        })).resolves.toEqual([]);
      });
      await vi.waitFor(async () => {
        await expect(encrypted.loadSettings()).resolves.toMatchObject({
          endpoint: { url: "http://source-after-delete-response-loss" },
        });
      });
      await expect(encrypted.disableEncryption({
        onProgress: ({ progress }) => {
          if (progress.phase === "verifying") controller.abort();
        },
        signal: controller.signal,
      })).rejects.toMatchObject({ name: "AbortError" });

      loseDeleteResponse = true;
      const firstRecovery = new OPFSStorageProvider();
      await expect(firstRecovery.convergeTransitionWithPassphrase({
        passphrase: PASSPHRASE,
        signal: undefined,
      })).rejects.toBe(responseLoss);
      expect(lostDeleteResponse).toBe(true);
      await expect(firstRecovery.inspectEncryption()).resolves.toMatchObject({
        requiredAction: "converge_transition",
        type: "credential_required",
      });

      loseDeleteResponse = false;
      const retriedRecovery = new OPFSStorageProvider();
      await retriedRecovery.convergeTransitionWithPassphrase({
        passphrase: PASSPHRASE,
        signal: undefined,
      });
      await expect(listNativePlainApplicationNamespaceEntryNames({
        nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
      })).resolves.toEqual([]);

      const encryptedAfterRetry = new OPFSStorageProvider();
      await encryptedAfterRetry.unlockWithPassphrase({ passphrase: PASSPHRASE });
      await expect(encryptedAfterRetry.loadSettings()).resolves.toMatchObject({
        endpoint: { url: "http://source-after-delete-response-loss" },
      });
      await encryptedAfterRetry.dispose();
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
