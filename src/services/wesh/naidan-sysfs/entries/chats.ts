import type { ChatId } from '@/models/ids'
import { toChatId } from '@/models/ids'
import type { WeshDirEntry, WeshStat } from '@/services/wesh/types'
import type { NaidanSysfsContext, NaidanSysfsDirectoryEntry, NaidanSysfsEntry } from '@/services/wesh/naidan-sysfs/types'
import { createChatDirectoryEntry } from '@/services/wesh/naidan-sysfs/entries/chat'

function createDirectoryStat(): WeshStat {
  return { size: 0, mode: 0o555, type: 'directory', mtime: 0, ino: 0, uid: 0, gid: 0 }
}

export async function listVisibleChatIds({ context }: { context: NaidanSysfsContext }): Promise<ChatId[]> {
  switch (context.visibility) {
  case 'current_chat_only':
    return [context.currentChatId]
  case 'current_chat_with_chat_group': {
    if (context.currentChatGroupId === undefined) {
      return [context.currentChatId]
    }
    const chatGroup = await context.reader.loadChatGroup({ chatGroupId: context.currentChatGroupId })
    if (chatGroup === undefined) {
      return [context.currentChatId]
    }
    return Array.from(new Set([
      context.currentChatId,
      ...chatGroup.items.map(item => item.chat.id),
    ]))
  }
  case 'main_chats':
    return (await context.reader.listChats()).map(chat => chat.id)
  default: {
    const _ex: never = context.visibility
    throw new Error(`Unhandled visibility: ${String(_ex)}`)
  }
  }
}

export function createChatsDirectoryEntry(): NaidanSysfsDirectoryEntry {
  return {
    kind: 'directory',
    async stat({ path }: { path: string }) {
      void path
      return createDirectoryStat()
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
          type: 'directory',
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
      const visibleIds = await listVisibleChatIds({ context })
      if (!visibleIds.includes(toChatId({ raw: name }))) {
        return undefined
      }
      return createChatDirectoryEntry({ context, chatId: toChatId({ raw: name }) })
    },
  }
}
