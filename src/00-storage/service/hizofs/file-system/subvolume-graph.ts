import type { HizoFSSubvolumeMountDto } from '@/00-storage/00-dto/hizofs.dto';
import { HizoFSCorruptionError } from '@/00-storage/service/hizofs/errors';
import {
  loadHizoFSFixedSubvolumeState,
  type HizoFSFilesystemState,
} from './active-state';
import type { HizoFSRuntime } from './runtime';

async function assertMountLocation({
  runtime,
  state,
  mount,
}: {
  runtime: HizoFSRuntime;
  state: HizoFSFilesystemState;
  mount: HizoFSSubvolumeMountDto;
}): Promise<void> {
  const parentDirectory = await runtime.nodeService.readDirectory({
    state,
    nodeId: mount.parentDirectoryNodeId,
  });
  const entry = await runtime.directoryStorage.getEntry({
    inode: parentDirectory.inode,
    name: mount.entryName,
  });
  if (entry?.kind !== 'subvolume' || entry.mountId !== mount.mountId) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS current subvolume mount location does not match the namespace',
      cause: undefined,
    });
  }
}

export async function collectHizoFSCurrentSubvolumeDescriptorObjectIds({
  runtime,
  rootState,
}: {
  runtime: HizoFSRuntime;
  rootState: HizoFSFilesystemState;
}): Promise<ReadonlySet<string>> {
  const descriptorObjectIds = new Set<string>([
    rootState.subvolumeDescriptorObjectId,
  ]);
  const descriptorObjectIdBySubvolumeId = new Map<string, string>([[
    rootState.subvolumeDescriptor.subvolumeId,
    rootState.subvolumeDescriptorObjectId,
  ]]);
  const visitingDescriptorObjectIds = new Set<string>([
    rootState.subvolumeDescriptorObjectId,
  ]);

  const visitState = async ({ state }: {
    state: HizoFSFilesystemState;
  }): Promise<void> => {
    for await (const mount of runtime.subvolumeMountIndex.entries({
      rootObjectId: state.commit.subvolumeMountIndexRootObjectId,
    })) {
      await assertMountLocation({ runtime, state, mount });
      const descriptorObjectId = mount.subvolumeDescriptorObjectId;
      if (visitingDescriptorObjectIds.has(descriptorObjectId)) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS current subvolume graph contains a cycle',
          cause: undefined,
        });
      }
      if (descriptorObjectIds.has(descriptorObjectId)) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS current subvolume graph contains multiple parents',
          cause: undefined,
        });
      }

      visitingDescriptorObjectIds.add(descriptorObjectId);
      try {
        const descriptor = await runtime.subvolumeDescriptorStore.read({
          objectId: descriptorObjectId,
        });
        const previousDescriptorObjectId = descriptorObjectIdBySubvolumeId.get(
          descriptor.subvolumeId,
        );
        if (
          previousDescriptorObjectId !== undefined
          && previousDescriptorObjectId !== descriptorObjectId
        ) {
          throw new HizoFSCorruptionError({
            message: 'HizoFS current subvolume identity is bound to multiple descriptors',
            cause: undefined,
          });
        }
        descriptorObjectIdBySubvolumeId.set(
          descriptor.subvolumeId,
          descriptorObjectId,
        );
        let childState: HizoFSFilesystemState;
        switch (descriptor.access) {
        case 'read':
          childState = await loadHizoFSFixedSubvolumeState({
            subvolumeDescriptorObjectId: descriptorObjectId,
            commitStore: runtime.commitStore,
            subvolumeDescriptorStore: runtime.subvolumeDescriptorStore,
            inodeIndex: runtime.inodeIndex,
            inodeStore: runtime.inodeStore,
          });
          break;
        case 'read_write':
          childState = await runtime.getReadWriteSubvolumeCore({
            subvolumeId: descriptor.subvolumeId,
          }).loadActiveState();
          if (childState.subvolumeDescriptorObjectId !== descriptorObjectId) {
            throw new HizoFSCorruptionError({
              message: 'HizoFS current child head references an unexpected descriptor',
              cause: undefined,
            });
          }
          break;
        default: {
          const _ex: never = descriptor;
          throw new Error(`Unhandled HizoFS subvolume descriptor: ${String(_ex)}`);
        }
        }
        if (childState.commit.subvolumeId !== descriptor.subvolumeId) {
          throw new HizoFSCorruptionError({
            message: 'HizoFS current subvolume descriptor and commit identities do not match',
            cause: undefined,
          });
        }
        await visitState({ state: childState });
        descriptorObjectIds.add(descriptorObjectId);
      } finally {
        visitingDescriptorObjectIds.delete(descriptorObjectId);
      }
    }
  };

  await visitState({ state: rootState });
  return descriptorObjectIds;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
