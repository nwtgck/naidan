import type { WeshDirEntry, WeshOpenFlags, WeshStat } from '@/services/wesh/types'
import { GeneratedTextFileHandle } from '@/services/wesh/naidan-sysfs/generated-text-file-handle'
import { NAIDAN_SYSFS_ROOT_PATH, NAIDAN_SYSFS_VERSION_TEXT } from '@/services/wesh/naidan-sysfs/constants'
import { createChatGroupsDirectoryEntry } from '@/services/wesh/naidan-sysfs/entries/chat-groups'
import { createChatsDirectoryEntry } from '@/services/wesh/naidan-sysfs/entries/chats'
import { createHierarchyDirectoryEntry } from '@/services/wesh/naidan-sysfs/entries/hierarchy'
import type { NaidanSysfsContext, NaidanSysfsDirectoryEntry, NaidanSysfsEntry, NaidanSysfsFileEntry, NaidanSysfsSymlinkEntry } from '@/services/wesh/naidan-sysfs/types'

function createDirectoryStat({ size }: { size: number }): WeshStat {
  return { size, mode: 0o555, type: 'directory', mtime: 0, ino: 0, uid: 0, gid: 0 }
}

function createFileStat({ size }: { size: number }): WeshStat {
  return { size, mode: 0o444, type: 'file', mtime: 0, ino: 0, uid: 0, gid: 0 }
}

function createVersionFileEntry(_args: Record<never, never>): NaidanSysfsFileEntry {
  return {
    kind: 'file',
    async stat({ path }: { path: string }) {
      return createFileStat({ size: path === `${NAIDAN_SYSFS_ROOT_PATH}/version` ? NAIDAN_SYSFS_VERSION_TEXT.length : 0 })
    },
    async open({ flags }: { path: string; flags: WeshOpenFlags }) {
      switch (flags.access) {
      case 'read':
        break
      case 'write':
      case 'read-write':
        throw new Error('File is read-only')
      default: {
        const _ex: never = flags.access
        throw new Error(`Unhandled access mode: ${String(_ex)}`)
      }
      }
      return new GeneratedTextFileHandle({
        estimatedSize: NAIDAN_SYSFS_VERSION_TEXT.length,
        readText: async () => NAIDAN_SYSFS_VERSION_TEXT,
      })
    },
  }
}

function createCurrentChatSymlinkEntry({
  chatId,
}: {
  chatId: string;
}): NaidanSysfsSymlinkEntry {
  return {
    kind: 'symlink',
    async stat({ path }: { path: string }) {
      void path
      return { size: `${NAIDAN_SYSFS_ROOT_PATH}/chats/${chatId}`.length, mode: 0o777, type: 'symlink', mtime: 0, ino: 0, uid: 0, gid: 0 }
    },
    async readlink({ path }: { path: string }) {
      void path
      return `${NAIDAN_SYSFS_ROOT_PATH}/chats/${chatId}`
    },
  }
}

function createCurrentChatGroupSymlinkEntry({
  chatGroupId,
}: {
  chatGroupId: string;
}): NaidanSysfsSymlinkEntry {
  return {
    kind: 'symlink',
    async stat({ path }: { path: string }) {
      void path
      return { size: `${NAIDAN_SYSFS_ROOT_PATH}/chat-groups/${chatGroupId}`.length, mode: 0o777, type: 'symlink', mtime: 0, ino: 0, uid: 0, gid: 0 }
    },
    async readlink({ path }: { path: string }) {
      void path
      return `${NAIDAN_SYSFS_ROOT_PATH}/chat-groups/${chatGroupId}`
    },
  }
}

export function createRootEntry(_args: Record<never, never>): NaidanSysfsDirectoryEntry {
  return {
    kind: 'directory',
    async stat({ path }: { path: string }) {
      void path
      return createDirectoryStat({ size: 0 })
    },
    async *readDir({
      path,
      context,
    }: {
      path: string;
      context: NaidanSysfsContext;
    }): AsyncIterable<WeshDirEntry> {
      void context
      yield {
        name: 'version',
        type: 'file',
        fullPath: `${path}/version`,
      }
      yield {
        name: 'current-chat',
        type: 'symlink',
        fullPath: `${path}/current-chat`,
      }
      yield {
        name: 'chats',
        type: 'directory',
        fullPath: `${path}/chats`,
      }
      yield {
        name: 'hierarchy',
        type: 'directory',
        fullPath: `${path}/hierarchy`,
      }
      if (context.currentChatGroupId !== undefined) {
        yield {
          name: 'current-chat-group',
          type: 'symlink',
          fullPath: `${path}/current-chat-group`,
        }
        yield {
          name: 'chat-groups',
          type: 'directory',
          fullPath: `${path}/chat-groups`,
        }
      }
    },
    async getChild({
      name,
      parentPath,
      context,
    }: {
      name: string;
      parentPath: string;
      context: NaidanSysfsContext;
    }): Promise<NaidanSysfsEntry | undefined> {
      void parentPath
      switch (name) {
      case 'version':
        return createVersionFileEntry({})
      case 'current-chat':
        return createCurrentChatSymlinkEntry({ chatId: context.currentChatId })
      case 'chats':
        return createChatsDirectoryEntry({})
      case 'hierarchy':
        return createHierarchyDirectoryEntry({})
      case 'current-chat-group':
        return context.currentChatGroupId === undefined
          ? undefined
          : createCurrentChatGroupSymlinkEntry({ chatGroupId: context.currentChatGroupId })
      case 'chat-groups':
        return createChatGroupsDirectoryEntry({})
      default:
        return undefined
      }
    },
  }
}
