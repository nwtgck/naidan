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
    const mountHandle = new MockFileSystemDirectoryHandle('project')

    openFileExplorer({
      kind: 'wesh-mounts',
      title: 'Files',
      rootName: 'Files',
      mounts: [{
        path: '/home/user/project',
        handle: mountHandle as unknown as FileSystemDirectoryHandle,
        readOnly: false,
      }],
      initialPath: ['home', 'user', 'project'],
    })

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
