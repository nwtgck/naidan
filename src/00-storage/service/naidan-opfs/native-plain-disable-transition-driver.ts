import type { NaidanPersistenceEndpointV1 } from '@/00-storage/service/naidan-persistence-control/00-format';
import type {
  TransitionEndpointDriver,
  TransitionTargetOperationBinding,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-provider-adapter';
import { createNativeOpfsFileSystemSession } from '@/00-storage/service/storage-file-system/native-opfs';
import {
  cleanupNativePlainApplicationNamespace,
  createNativePlainApplicationNamespaceSession,
  isNativePlainApplicationNamespaceEmpty,
  runWithNativePlainApplicationNamespaceSession,
} from '@/00-storage/service/naidan-opfs/native-plain-application-namespace';
import {
  assertNativePlainTransitionSourceCompatible,
  createNativePlainTransitionNamespaceSession,
  projectNativePlainTransitionSource,
} from '@/00-storage/service/naidan-opfs/native-plain-transition-namespace';
import type { NativePlainTransitionProgressBridge } from '@/00-storage/service/naidan-opfs/native-plain-transition-progress-bridge';
import { createStorageFileSystemTransitionSource } from '@/00-storage/service/naidan-persistence-control/transition/storage-file-system-transition-source';

export const NATIVE_PLAIN_DISABLE_AUTHORITY_IDENTITY = 'naidan-plain-opfs-v1';

function requirePlainEndpoint({ endpoint }: { endpoint: NaidanPersistenceEndpointV1 }): void {
  switch (endpoint.type) {
  case 'plain': return;
  case 'hizofs': throw new TypeError('native plain disable target driver belongs to the plain endpoint');
  default: return endpoint satisfies never;
  }
}

function requireBinding({ actual, expected }: {
  actual: TransitionTargetOperationBinding;
  expected: TransitionTargetOperationBinding;
}): void {
  if (
    actual.operationId !== expected.operationId
    || actual.source.type !== 'hizofs'
    || expected.source.type !== 'hizofs'
    || actual.source.fileSystemId !== expected.source.fileSystemId
    || actual.target.type !== 'plain'
    || expected.target.type !== 'plain'
  ) {
    throw new TypeError('native plain disable target operation binding changed');
  }
}

export function createNativePlainDisableTransitionDriver({ binding, bridge, nativeNamespaceRoot, verificationPageSize }: {
  binding: TransitionTargetOperationBinding;
  bridge: NativePlainTransitionProgressBridge;
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  verificationPageSize: number;
}): TransitionEndpointDriver {
  if (!Number.isSafeInteger(verificationPageSize) || verificationPageSize < 1) {
    throw new RangeError('native plain disable verification page size must be a positive safe integer');
  }
  requirePlainEndpoint({ endpoint: binding.target });
  switch (binding.source.type) {
  case 'hizofs': break;
  case 'plain': throw new TypeError('native plain disable source must be HizoFS');
  default: binding.source satisfies never;
  }

  const inspect = async () => {
    const lifecycle = await bridge.currentLifecycle();
    if (lifecycle === undefined) {
      return await isNativePlainApplicationNamespaceEmpty({ nativeNamespaceRoot }) ? 'absent' : 'invalid';
    }
    switch (lifecycle) {
    case 'preparing':
    case 'active': return 'absent';
    case 'sealed':
    case 'published': return 'fully_verified';
    default: return lifecycle satisfies never;
    }
  };

  return {
    cleanupEndpoint: async ({ endpoint }) => {
      requirePlainEndpoint({ endpoint });
      if (await bridge.currentLifecycle() === undefined) {
        throw new TypeError('native plain target cleanup requires its authenticated operation marker');
      }
      await cleanupNativePlainApplicationNamespace({ nativeNamespaceRoot });
    },
    finalizeTarget: async ({ binding: actual }) => {
      requireBinding({ actual, expected: binding });
      const lifecycle = await bridge.currentLifecycle();
      switch (lifecycle) {
      case 'sealed': return;
      case 'active':
      case 'preparing':
      case 'published':
      case undefined: throw new TypeError('native plain target must be sealed before finalization');
      default: return lifecycle satisfies never;
      }
    },
    inspectEndpoint: async ({ endpoint }) => {
      requirePlainEndpoint({ endpoint });
      return await inspect();
    },
    openSourceEndpoint: async () => {
      throw new TypeError('native plain disable target driver cannot open a source endpoint');
    },
    openTargetEndpoint: async ({ binding: actual }) => {
      requireBinding({ actual, expected: binding });
      const mutationSession = createNativeOpfsFileSystemSession({ root: nativeNamespaceRoot });
      const verificationSession = createNativePlainApplicationNamespaceSession({ nativeNamespaceRoot });
      const namespace = createNativePlainTransitionNamespaceSession({
        bridge,
        session: mutationSession,
        verificationSession,
      });
      return {
        authorityIdentity: NATIVE_PLAIN_DISABLE_AUTHORITY_IDENTITY,
        close: namespace.close,
        source: namespace.source,
        target: namespace.target,
      };
    },
    prepareTarget: async ({ binding: actual }) => {
      requireBinding({ actual, expected: binding });
      const current = await bridge.currentLifecycle();
      if (current === undefined) {
        if (!await isNativePlainApplicationNamespaceEmpty({ nativeNamespaceRoot })) {
          throw new TypeError('native plain target contains unowned application bytes');
        }
        await bridge.prepareTarget();
        return;
      }
      switch (current) {
      case 'preparing':
      case 'active':
      case 'sealed': return;
      case 'published': throw new TypeError('published native plain target cannot re-enter target building');
      default: return current satisfies never;
      }
    },
    verifyNormalOpen: async ({ binding: actual }) => {
      requireBinding({ actual, expected: binding });
      const lifecycle = await bridge.currentLifecycle();
      switch (lifecycle) {
      case 'sealed':
      case 'published': break;
      case 'active':
      case 'preparing':
      case undefined: throw new TypeError('native plain target must be sealed before normal-open verification');
      default: return lifecycle satisfies never;
      }
      await runWithNativePlainApplicationNamespaceSession({
        failureMessage: 'native plain normal-open verification and session cleanup both failed',
        operation: async ({ session }) => {
          await session.root.stat();
          await assertNativePlainTransitionSourceCompatible({
            maximumDirectoryEntriesPerRead: verificationPageSize,
            source: projectNativePlainTransitionSource({
              source: createStorageFileSystemTransitionSource({ session }),
            }),
          });
        },
        session: createNativePlainApplicationNamespaceSession({ nativeNamespaceRoot }),
      });
    },
  };
}

export const TEST_ONLY = {
  requireBinding,
  requirePlainEndpoint,
};
