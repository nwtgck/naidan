import { encodeBase64UrlUnpadded } from "@/00-storage/service/hizofs/00-format/v1/encoding/base64-url";
import { createHizoFSAuthenticatedInspectionSession } from "@/00-storage/service/hizofs/inspection";
import { DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY, type HizoFSRuntimePolicy } from "@/00-storage/service/hizofs/runtime/runtime-policy";
import {
  createBrowserContainerCoordinationScope,
  createBrowserHizoFSTransitionTargetContainer,
  createBrowserHizoFSWorkerRuntimeHost,
  DEFAULT_HIZOFS_BACKING_FILE_HANDLE_CACHE_ENTRY_LIMIT,
  openAuthenticatedDevelopmentWritableApplicationSessionFromCapability,
  openBrowserAuthenticatedDevelopmentWritableContainerCapability,
  withAuthenticatedDevelopmentWritableSessionReadAuthority,
} from "@/00-storage/service/hizofs/worker/composition-root";
import type { StorageFileSystemSession } from "@/00-storage/service/storage-file-system/types";
import type {
  HizoFSDebugWorkspaceAuthority,
  HizoFSDebugWorkspaceProduct,
} from "@/features/debug-hizofs/logic/debug-workspace";

const TEMPORARY_WORKSPACE_RUNTIME_POLICY: HizoFSRuntimePolicy = Object.freeze({
  lazyDurability: DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
  maxDirectoryIteratorEntries: 4_096,
  maxHeldLockNames: 1_024,
  maxMaintenanceRootRegistrations: 1_024,
  maxReaderPins: 256,
  maxSegmentReferences: 4_096,
});

type TemporaryWorkspaceRuntime = Readonly<{
  fileSystemId: string;
  fileSystemSession: StorageFileSystemSession;
  dispose(): Promise<void>;
}>;

type TemporaryWorkspaceRuntimeFactory = ({ backingDirectory }: {
  backingDirectory: FileSystemDirectoryHandle;
}) => Promise<TemporaryWorkspaceRuntime>;

function createEphemeralCredential(): string {
  return encodeBase64UrlUnpadded({
    bytes: globalThis.crypto.getRandomValues(new Uint8Array(32)),
  });
}

function createRetryableAsyncDisposer({ dispose }: {
  dispose: () => Promise<void>;
}): () => Promise<void> {
  let status: "active" | "disposed" = "active";
  let activeAttempt: Promise<void> | undefined;
  return async () => {
    switch (status) {
    case "disposed": return;
    case "active": break;
    default: return status satisfies never;
    }
    if (activeAttempt !== undefined) {
      await activeAttempt;
      return;
    }
    const attempt = (async () => {
      await dispose();
      status = "disposed";
    })();
    activeAttempt = attempt;
    try {
      await attempt;
    } finally {
      if (activeAttempt === attempt) activeAttempt = undefined;
    }
  };
}

async function disposeSessionAndRuntime({ fileSystemSession, disposeRuntime }: {
  fileSystemSession: StorageFileSystemSession;
  disposeRuntime: () => Promise<void>;
}): Promise<void> {
  const failures: unknown[] = [];
  try {
    await fileSystemSession.close();
  } catch (cause: unknown) {
    failures.push(cause);
  }
  // WHY: runtime disposal is intentionally attempted after the application
  // session has detached. Running both in parallel can make the host report a
  // transient session_attached blocker even though the same cleanup sequence
  // would be safe once session close has settled.
  try {
    await disposeRuntime();
  } catch (cause: unknown) {
    failures.push(cause);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "temporary HizoFS session and runtime cleanup both failed");
  }
}

async function createBrowserTemporaryWorkspaceRuntime({ backingDirectory }: {
  backingDirectory: FileSystemDirectoryHandle;
}): Promise<TemporaryWorkspaceRuntime> {
  // WHY: Temporary workspaces still use the ordinary self-contained Credential
  // Slot path. The one-use random credential exists only long enough to create
  // and authenticate the first application session; the live session then owns
  // all secret-bearing authority and the debug feature receives no credential.
  let ephemeralCredential: string | undefined = createEphemeralCredential();
  const fileSystemId = await createBrowserHizoFSTransitionTargetContainer({
    passphrases: [ephemeralCredential],
    reserveContainerRoot: async () => ({
      cleanup: async () => undefined,
      containerRoot: backingDirectory,
      type: "reserved",
    }),
  });
  const canonicalBackingLocation = `hizofs-temporary-workspace:${globalThis.crypto.randomUUID()}`;
  const scope = await createBrowserContainerCoordinationScope({ canonicalBackingLocation });
  const runtimeHost = createBrowserHizoFSWorkerRuntimeHost({
    lockManager: navigator.locks,
    policy: TEMPORARY_WORKSPACE_RUNTIME_POLICY,
    scope,
  });

  const opened = await openBrowserAuthenticatedDevelopmentWritableContainerCapability({
    backingFileHandleCacheEntryLimit: DEFAULT_HIZOFS_BACKING_FILE_HANDLE_CACHE_ENTRY_LIMIT,
    containerRoot: backingDirectory,
    passphrase: ephemeralCredential,
    verifyProofAuthority: async ({ fileSystemId: openedFileSystemId }) => {
      if (openedFileSystemId !== fileSystemId) {
        throw new TypeError("temporary HizoFS container identity changed during initial open");
      }
    },
  });
  switch (opened.type) {
  case "credential_rejected":
    throw new TypeError("temporary HizoFS credential was rejected after creation");
  case "opened": {
    let fileSystemSession: StorageFileSystemSession;
    try {
      fileSystemSession = await openAuthenticatedDevelopmentWritableApplicationSessionFromCapability({
        authority: opened.authority,
        canonicalBackingLocation,
        recheckAuthority: async () => undefined,
        rootName: "temporary.hizofs",
        runtimeHost,
      });
    } catch (cause: unknown) {
      try {
        await opened.releaseResources();
      } catch (cleanupFailure: unknown) {
        throw new AggregateError(
          [cause, cleanupFailure],
          "temporary HizoFS session open and capability cleanup both failed",
        );
      }
      throw cause;
    } finally {
      ephemeralCredential = undefined;
    }

    const dispose = createRetryableAsyncDisposer({
      dispose: async () => await disposeSessionAndRuntime({
        fileSystemSession,
        disposeRuntime: async () => {
          const result = await runtimeHost.flushAndDisposeIfIdleAndSafe();
          switch (result.status) {
          case "disposed": return;
          case "retained":
            throw new Error(`temporary HizoFS runtime shutdown is blocked by ${result.blocker}`);
          default: return result satisfies never;
          }
        },
      }),
    });
    return Object.freeze({
      fileSystemId,
      fileSystemSession,
      dispose,
    });
  }
  default: return opened satisfies never;
  }
}

function createHizoFSDebugWorkspaceAuthorityWith({ createRuntime }: {
  createRuntime: TemporaryWorkspaceRuntimeFactory;
}): HizoFSDebugWorkspaceAuthority {
  return Object.freeze({
    create: async ({ backingDirectory }: { backingDirectory: FileSystemDirectoryHandle }): Promise<HizoFSDebugWorkspaceProduct> => {
      const runtime = await createRuntime({ backingDirectory });
      return Object.freeze({
        authenticatedInspectionSession: createHizoFSAuthenticatedInspectionSession({
          authorityBorrower: {
            run: async ({ operation }) => await withAuthenticatedDevelopmentWritableSessionReadAuthority({
              operation,
              session: runtime.fileSystemSession,
            }),
          },
        }),
        dispose: runtime.dispose,
        fileSystemId: runtime.fileSystemId,
        fileSystemSession: runtime.fileSystemSession,
      });
    },
  });
}

export function createBrowserHizoFSDebugWorkspaceAuthority(): HizoFSDebugWorkspaceAuthority {
  return createHizoFSDebugWorkspaceAuthorityWith({
    createRuntime: createBrowserTemporaryWorkspaceRuntime,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createHizoFSDebugWorkspaceAuthorityWith,
  createRetryableAsyncDisposer,
  disposeSessionAndRuntime,
};
