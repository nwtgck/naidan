import { describe, expect, it } from 'vitest';
import {
  getNaidanOpfsRootDirectoryName,
  getNaidanOpfsSpecialFileSystemDirectoryName,
  NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_NAMES,
  NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_TYPES,
  NAIDAN_OPFS_MODELS_DIRECTORY_NAME,
  NAIDAN_OPFS_ROOT_DIRECTORY_REGISTRY,
  NAIDAN_OPFS_SPECIAL_FILE_SYSTEM_DIRECTORY_NAMES,
  NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
  type OpfsSpecialFileSystemType,
} from './naidan-opfs-root-directory-registry';

describe('Naidan OPFS root directory registry', () => {
  it('makes every known raw OPFS root choose its container-root disposition', () => {
    expect(NAIDAN_OPFS_ROOT_DIRECTORY_REGISTRY).toEqual({
      storage: {
        containerRootDisposition: 'copy_into_container_root',
        directoryName: 'naidan-storage',
        purpose: 'application_storage',
      },
      chat_wesh: {
        containerRootDisposition: 'copy_into_container_root',
        directoryName: 'naidan-chat-wesh',
        purpose: 'special_file_system',
      },
      debug_wesh: {
        containerRootDisposition: 'copy_into_container_root',
        directoryName: 'naidan-debug-wesh',
        purpose: 'special_file_system',
      },
      tmp: {
        containerRootDisposition: 'copy_into_container_root',
        directoryName: 'naidan-tmp',
        purpose: 'special_file_system',
      },
      models: {
        containerRootDisposition: 'outside_container_root',
        directoryName: 'models',
        purpose: 'reconstructible_model_cache',
      },
    });
  });

  it('derives the complete container root and special-file-system mappings from one authority', () => {
    expect(NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_TYPES).toEqual([
      'storage',
      'chat_wesh',
      'debug_wesh',
      'tmp',
    ]);
    expect(NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_NAMES).toEqual([
      'naidan-storage',
      'naidan-chat-wesh',
      'naidan-debug-wesh',
      'naidan-tmp',
    ]);
    expect(NAIDAN_OPFS_SPECIAL_FILE_SYSTEM_DIRECTORY_NAMES).toEqual([
      'naidan-chat-wesh',
      'naidan-debug-wesh',
      'naidan-tmp',
    ]);
    expect(NAIDAN_OPFS_STORAGE_DIRECTORY_NAME).toBe('naidan-storage');
    expect(NAIDAN_OPFS_MODELS_DIRECTORY_NAME).toBe('models');
  });

  it.each([
    ['chat_wesh', 'naidan-chat-wesh'],
    ['debug_wesh', 'naidan-debug-wesh'],
    ['tmp', 'naidan-tmp'],
  ] as const satisfies readonly (readonly [OpfsSpecialFileSystemType, string])[])(
    'maps %s consumers to the same raw and encrypted directory name',
    (type, expectedName) => {
      expect(getNaidanOpfsSpecialFileSystemDirectoryName({ type })).toBe(expectedName);
      expect(getNaidanOpfsRootDirectoryName({ type })).toBe(expectedName);
    },
  );
});
