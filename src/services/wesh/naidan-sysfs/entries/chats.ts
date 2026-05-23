import type { WeshDirEntry, WeshStat } from '@/services/wesh/types'
import type { NaidanSysfsContext, NaidanSysfsDirectoryEntry, NaidanSysfsEntry } from '@/services/wesh/naidan-sysfs/types'
import { createChatDirectoryEntry } from '@/services/wesh/naidan-sysfs/entries/chat'

function createDirectoryStat(_args: Record<never, never>): WeshStat {
  return { size: 0, mode: 0o555, type: 'directory', mtime: 0, ino: 0, uid: 0, gid: 0 }
}

export function createChatsDirectoryEntry(_args: Record<never, never>): NaidanSysfsDirectoryEntry {
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
      yield {
        name: context.currentChatId,
        type: 'directory',
        fullPath: `${path}/${context.currentChatId}`,
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
      if (name !== context.currentChatId) {
        return undefined
      }
      return createChatDirectoryEntry({ context, chatId: name })
    },
  }
}
