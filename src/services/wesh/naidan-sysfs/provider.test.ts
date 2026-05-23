import { describe, expect, it, vi } from 'vitest'
import type { NaidanSysfsStorageReader } from './types'
import { NaidanSysfsProvider } from './provider'
import { NAIDAN_SYSFS_ROOT_PATH, NAIDAN_SYSFS_VERSION_TEXT } from './constants'

function createReaderStub(_args: Record<never, never>): NaidanSysfsStorageReader {
  return {
    async loadHierarchy(_args: Record<never, never>) {
      return { items: [] }
    },
    async getSidebarStructure(_args: Record<never, never>) {
      return []
    },
    async listChats(_args: Record<never, never>) {
      return []
    },
    async listChatGroups(_args: Record<never, never>) {
      return []
    },
    async loadChatMeta({ chatId }: { chatId: string }) {
      void chatId
      return undefined
    },
    async loadChatContent({ chatId }: { chatId: string }) {
      void chatId
      return undefined
    },
    async loadChat({ chatId }: { chatId: string }) {
      void chatId
      return undefined
    },
    async loadChatGroup({ chatGroupId }: { chatGroupId: string }) {
      void chatGroupId
      return undefined
    },
  }
}

describe('NaidanSysfsProvider', () => {
  it('lists version at the sysfs root', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({}),
    })

    const entries = []
    for await (const entry of provider.readDir({ path: NAIDAN_SYSFS_ROOT_PATH })) {
      entries.push(entry)
    }

    expect(entries).toEqual([
      { name: 'version', type: 'file', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/version` },
    ])
  })

  it('opens version as a generated text file', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({}),
    })

    const handle = await provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/version`,
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      mode: undefined,
    })
    const buffer = new Uint8Array(64)
    const result = await handle.read({ buffer })

    expect(new TextDecoder().decode(buffer.subarray(0, result.bytesRead))).toBe(NAIDAN_SYSFS_VERSION_TEXT)
  })

  it('rejects write opens for generated files', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({}),
    })

    await expect(provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/version`,
      flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' },
      mode: undefined,
    })).rejects.toThrow('File is read-only')
  })

  it('does not touch the storage reader for version access', async () => {
    const reader = createReaderStub({})
    const loadHierarchy = vi.spyOn(reader, 'loadHierarchy')
    const provider = new NaidanSysfsProvider({ reader })

    await provider.stat({ path: `${NAIDAN_SYSFS_ROOT_PATH}/version` })
    const entries = []
    for await (const entry of provider.readDir({ path: NAIDAN_SYSFS_ROOT_PATH })) {
      entries.push(entry)
    }

    expect(entries).toHaveLength(1)
    expect(loadHierarchy).not.toHaveBeenCalled()
  })
})
