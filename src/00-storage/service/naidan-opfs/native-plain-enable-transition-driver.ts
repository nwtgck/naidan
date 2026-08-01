import type { NaidanPersistenceEndpointV1 } from "@/00-storage/service/naidan-persistence-control/00-format";
import { createStorageFileSystemTransitionSource } from "@/00-storage/service/naidan-persistence-control/transition/storage-file-system-transition-source";
import type {
  TransitionEndpointDriver,
  TransitionTargetOperationBinding,
} from "@/00-storage/service/naidan-persistence-control/transition/transition-provider-adapter";
import {
  cleanupNativePlainApplicationNamespace,
  createNativePlainApplicationNamespaceSession,
  includeNativePlainApplicationStorageEntry,
  isCanonicalHizoFSContainerName,
  runWithNativePlainApplicationNamespaceSession,
} from '@/00-storage/service/naidan-opfs/native-plain-application-namespace';

export const NATIVE_PLAIN_ENABLE_AUTHORITY_IDENTITY = "naidan-plain-opfs-v1";

function requirePlainEndpoint({ endpoint }: { endpoint: NaidanPersistenceEndpointV1 }): void {
  switch (endpoint.type) {
  case "plain": return;
  case "hizofs": throw new TypeError("native plain enable source driver belongs to the plain endpoint");
  default: return endpoint satisfies never;
  }
}

export function createNativePlainEnableTransitionDriver({ nativeNamespaceRoot }: {
  nativeNamespaceRoot: FileSystemDirectoryHandle;
}): TransitionEndpointDriver {
  return {
    cleanupEndpoint: async ({ endpoint }) => {
      requirePlainEndpoint({ endpoint });
      await cleanupNativePlainApplicationNamespace({ nativeNamespaceRoot });
    },
    finalizeTarget: async () => {
      throw new TypeError("native plain enable source driver cannot finalize a target");
    },
    inspectEndpoint: async ({ endpoint }) => {
      requirePlainEndpoint({ endpoint });
      try {
        return await runWithNativePlainApplicationNamespaceSession({
          failureMessage: "native plain endpoint readiness and session cleanup both failed",
          operation: async ({ session }) => {
            await session.root.stat();
            return "fully_verified" as const;
          },
          session: createNativePlainApplicationNamespaceSession({ nativeNamespaceRoot }),
        });
      } catch (cause: unknown) {
        if (cause instanceof DOMException && cause.name === "NotFoundError") return "invalid";
        throw cause;
      }
    },
    openSourceEndpoint: async ({ endpoint }) => {
      requirePlainEndpoint({ endpoint });
      const session = createNativePlainApplicationNamespaceSession({ nativeNamespaceRoot });
      return {
        authorityIdentity: NATIVE_PLAIN_ENABLE_AUTHORITY_IDENTITY,
        close: async () => await session.close(),
        source: createStorageFileSystemTransitionSource({ session }),
      };
    },
    openTargetEndpoint: async () => {
      throw new TypeError("native plain enable source driver cannot open a target endpoint");
    },
    prepareTarget: async ({ binding: _binding }: { binding: TransitionTargetOperationBinding }) => {
      throw new TypeError("native plain enable source driver cannot prepare a target");
    },
    verifyNormalOpen: async () => {
      throw new TypeError("native plain enable source driver cannot verify a target");
    },
  };
}

export const TEST_ONLY = {
  cleanupApplicationNamespace: cleanupNativePlainApplicationNamespace,
  createApplicationNamespaceSession: createNativePlainApplicationNamespaceSession,
  includeApplicationStorageEntry: includeNativePlainApplicationStorageEntry,
  isCanonicalHizoFSContainerName,
};
