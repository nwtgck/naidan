import { toChatGroupId, toChatId } from '@/models/ids';
import { beforeEach, describe, expect, it } from 'vitest'
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem'
import {
  mapFileExplorerModalOptionsToRootDescriptor,
  useFileExplorerModal,
} from './useFileExplorerModal'

describe('useFileExplorerModal', () => {
  beforeEach(() => {
    const { closeFileExplorer } = useFileExplorerModal()
    closeFileExplorer()
  })

  it('keeps wesh mount options structured-cloneable after opening the modal', () => {
    const { fileExplorerOptions, openFileExplorer } = useFileExplorerModal()
    const mountHandle = new MockFileSystemDirectoryHandle({ name: 'project' })

    openFileExplorer({ options: {
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
    } })

    expect(() => structuredClone(fileExplorerOptions.value)).not.toThrow()
    expect(() => structuredClone(mapFileExplorerModalOptionsToRootDescriptor({
      options: fileExplorerOptions.value,
    }))).not.toThrow()
  })

  it('maps the OPFS root label to "OPFS root"', () => {
    expect(mapFileExplorerModalOptionsToRootDescriptor({
      options: { kind: 'opfs-root' },
    })).toEqual({
      kind: 'opfs-root',
      rootName: 'OPFS root',
    })
  })
})
