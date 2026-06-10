import type { ChatGroup } from '@/models/types'
import type { WeshDirEntry, WeshStat } from '@/services/wesh/types'
import type { NaidanSysfsContext, NaidanSysfsDirectoryEntry, NaidanSysfsEntry } from '@/services/wesh/naidan-sysfs/types'
import { createChatGroupDirectoryEntry } from '@/services/wesh/naidan-sysfs/entries/chat-group'

function createDirectoryStat(_args: Record<never, never>): WeshStat {
  return { size: 0, mode: 0o555, type: 'directory', mtime: 0, ino: 0, uid: 0, gid: 0 }
}

export async function listVisibleChatGroupIds({ context }: { context: NaidanSysfsContext }): Promise<string[]> {
  switch (context.visibility) {
  case 'current_chat_only':
  case 'current_chat_with_chat_group':
    return context.currentChatGroupId === undefined ? [] : [context.currentChatGroupId]
  case 'all_chats':
    return (await context.reader.listChatGroups({})).map(chatGroup => chatGroup.id)
  default: {
    const _ex: never = context.visibility
    throw new Error(`Unhandled visibility: ${String(_ex)}`)
  }
  }
}

async function loadChatGroup({
  context,
  chatGroupId,
}: {
  context: NaidanSysfsContext;
  chatGroupId: string;
}): Promise<ChatGroup | undefined> {
  const ids = await listVisibleChatGroupIds({ context })
  if (!ids.includes(chatGroupId)) {
    return undefined
  }
  return context.reader.loadChatGroup({ chatGroupId })
}

export function createChatGroupsDirectoryEntry(_args: Record<never, never>): NaidanSysfsDirectoryEntry {
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
      const ids = await listVisibleChatGroupIds({ context })
      for (const chatGroupId of ids) {
        yield {
          name: chatGroupId,
          type: 'directory',
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
      const chatGroup = await loadChatGroup({ context, chatGroupId: name })
      if (chatGroup === undefined) {
        return undefined
      }
      return createChatGroupDirectoryEntry({ context, chatGroup })
    },
  }
}
