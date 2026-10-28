import { toChatGroupId, toChatId } from '@/01-models/ids';
import { beforeEach, describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  mapFileExplorerModalOptionsToRootDescriptor,
  useFileExplorerModal,
} from './useFileExplorerModal';

describe('useFileExplorerModal', () => {
  beforeEach(() => {
    const { closeFileExplorer } = useFileExplorerModal();
    closeFileExplorer();
  });

  it('keeps wesh mount options structured-cloneable after opening the modal', () => {
    const { fileExplorerOptions, openFileExplorer } = useFileExplorerModal();
    const mountHandle = new MockFileSystemDirectoryHandle({ name: 'project' });

    openFileExplorer({
      options: {
        kind: 'wesh-mounts',
        title: 'Files',
        rootName: 'Files',
        mounts: [{
          type: 'directory',
          path: '/home/user/project',
          handle: mountHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        }, {
          type: 'naidan_sysfs',
          path: '/sys/fs/naidan',
          readOnly: true,
          storageType: 'opfs',
          visibility: 'current_chat_with_chat_group',
          binaryObjectAccess: 'data',
          currentChatId: toChatId({ raw: 'chat-1' }),
          currentChatGroupId: toChatGroupId({ raw: 'chat-group-1' }),
        }],
        initialPath: ['home', 'user', 'project'],
      },
    });

    expect(() => structuredClone(fileExplorerOptions.value)).not.toThrow();
    expect(() => structuredClone(mapFileExplorerModalOptionsToRootDescriptor({
      options: fileExplorerOptions.value,
    }))).not.toThrow();
  });

  it('releases archive root options when the modal closes', () => {
    const blob = new Blob(['PK\u0003\u0004']);
    const { closeFileExplorer, fileExplorerOptions, openFileExplorer } = useFileExplorerModal();

    openFileExplorer({
      options: {
        kind: 'archive-root',
        title: 'Export',
        rootName: 'export.zip',
        archive: { format: 'zip', source: { kind: 'blob', blob } },
      },
    });
    expect(fileExplorerOptions.value.kind).toBe('archive-root');

    closeFileExplorer();

    expect(fileExplorerOptions.value).toEqual({ kind: 'opfs-root' });
  });

  it('maps a ZIP Blob to a structured-cloneable archive root descriptor', () => {
    const blob = new Blob(['PK\u0003\u0004']);
    const descriptor = mapFileExplorerModalOptionsToRootDescriptor({
      options: {
        kind: 'archive-root',
        title: 'Export',
        rootName: 'export.zip',
        archive: { format: 'zip', source: { kind: 'blob', blob } },
      },
    });

    expect(descriptor).toMatchObject({
      kind: 'archive-root',
      rootName: 'export.zip',
      archive: { format: 'zip', source: { kind: 'blob', blob } },
    });
    expect(() => structuredClone(descriptor)).not.toThrow();
  });

  it('maps the OPFS root label to "OPFS root"', () => {
    expect(mapFileExplorerModalOptionsToRootDescriptor({
      options: { kind: 'opfs-root' },
    })).toEqual({
      kind: 'opfs-root',
      rootName: 'OPFS root',
    });
  });
});
