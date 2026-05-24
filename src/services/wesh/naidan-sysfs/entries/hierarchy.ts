import { NAIDAN_SYSFS_ROOT_PATH } from '@/services/wesh/naidan-sysfs/constants'
import { listVisibleChatIds } from '@/services/wesh/naidan-sysfs/entries/chats'
import { listVisibleChatGroupIds } from '@/services/wesh/naidan-sysfs/entries/chat-groups'
import type { NaidanSysfsContext, NaidanSysfsDirectoryEntry, NaidanSysfsEntry, NaidanSysfsSymlinkEntry } from '@/services/wesh/naidan-sysfs/types'
import type { WeshDirEntry, WeshStat } from '@/services/wesh/types'

function createDirectoryStat(_args: Record<never, never>): WeshStat {
  return { size: 0, mode: 0o555, type: 'directory', mtime: 0, ino: 0, uid: 0, gid: 0 }
}

function createChatSymlinkEntry({ chatId }: { chatId: string }): NaidanSysfsSymlinkEntry {
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

function createChatGroupSymlinkEntry({ chatGroupId }: { chatGroupId: string }): NaidanSysfsSymlinkEntry {
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

function createHierarchyChatGroupsDirectory(_args: Record<never, never>): NaidanSysfsDirectoryEntry {
  return {
    kind: 'directory',
    async stat({ path }: { path: string }) {
      void path
      return createDirectoryStat({})
    },
    async *readDir({
      path,
      context,
    }: {
      path: string;
      context: NaidanSysfsContext;
    }): AsyncIterable<WeshDirEntry> {
      for (const chatGroupId of await listVisibleChatGroupIds({ context })) {
        yield {
          name: chatGroupId,
          type: 'symlink',
          fullPath: `${path}/${chatGroupId}`,
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
      if (!(await listVisibleChatGroupIds({ context })).includes(name)) {
        return undefined
      }
      return createChatGroupSymlinkEntry({ chatGroupId: name })
    },
  }
}

function createHierarchyChatsDirectory(_args: Record<never, never>): NaidanSysfsDirectoryEntry {
  return {
    kind: 'directory',
    async stat({ path }: { path: string }) {
      void path
      return createDirectoryStat({})
    },
    async *readDir({
      path,
      context,
    }: {
      path: string;
      context: NaidanSysfsContext;
    }): AsyncIterable<WeshDirEntry> {
      for (const chatId of await listVisibleChatIds({ context })) {
        yield {
          name: chatId,
          type: 'symlink',
          fullPath: `${path}/${chatId}`,
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
      if (!(await listVisibleChatIds({ context })).includes(name)) {
        return undefined
      }
      return createChatSymlinkEntry({ chatId: name })
    },
  }
}

export function createHierarchyDirectoryEntry(_args: Record<never, never>): NaidanSysfsDirectoryEntry {
  return {
    kind: 'directory',
    async stat({ path }: { path: string }) {
      void path
      return createDirectoryStat({})
    },
    async *readDir({ path }: { path: string; context: NaidanSysfsContext }): AsyncIterable<WeshDirEntry> {
      yield { name: 'chats', type: 'directory', fullPath: `${path}/chats` }
      yield { name: 'chat-groups', type: 'directory', fullPath: `${path}/chat-groups` }
    },
    async getChild({
      name,
      parentPath,
    }: {
      name: string;
      parentPath: string;
      context: NaidanSysfsContext;
    }): Promise<NaidanSysfsEntry | undefined> {
      void parentPath
      switch (name) {
      case 'chats':
        return createHierarchyChatsDirectory({})
      case 'chat-groups':
        return createHierarchyChatGroupsDirectory({})
      default:
        return undefined
      }
    },
  }
}
