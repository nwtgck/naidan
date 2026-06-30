import type { ChatGroupId } from '@/01-models/ids';
import type { ChatGroup } from '@/01-models/types';
import { idToRaw, toChatGroupId } from '@/01-models/ids';
import type { WeshDirEntry, WeshStat } from '@/features/wesh/types';
import type { NaidanSysfsContext, NaidanSysfsDirectoryEntry, NaidanSysfsEntry } from '@/features/wesh/naidan-sysfs/types';
import { createChatGroupDirectoryEntry } from '@/features/wesh/naidan-sysfs/entries/chat-group';

function createDirectoryStat(): WeshStat {
  return { size: 0, mode: 0o555, type: 'directory', mtime: 0, ino: 0, uid: 0, gid: 0 };
}

export async function listVisibleChatGroupIds({ context }: { context: NaidanSysfsContext }): Promise<ChatGroupId[]> {
  switch (context.visibility) {
  case 'current_chat_only':
  case 'current_chat_with_chat_group':
    return context.currentChatGroupId === undefined ? [] : [context.currentChatGroupId];
  case 'main_chats':
    return (await context.reader.listChatGroups()).map(chatGroup => chatGroup.id);
  default: {
    const _ex: never = context.visibility;
    throw new Error(`Unhandled visibility: ${String(_ex)}`);
  }
  }
}

async function loadChatGroup({
  context,
  chatGroupId,
}: {
  context: NaidanSysfsContext,
  chatGroupId: ChatGroupId,
}): Promise<ChatGroup | undefined> {
  const ids = await listVisibleChatGroupIds({ context });
  if (!ids.includes(chatGroupId)) {
    return undefined;
  }
  return context.reader.loadChatGroup({ chatGroupId });
}

export function createChatGroupsDirectoryEntry(): NaidanSysfsDirectoryEntry {
  return {
    kind: 'directory',
    async stat({ path }: { path: string }) {
      void path;
      return createDirectoryStat();
    },
    async *readDir({
      path,
      context,
    }: {
      path: string,
      context: NaidanSysfsContext,
    }): AsyncIterable<WeshDirEntry> {
      const ids = await listVisibleChatGroupIds({ context });
      for (const chatGroupId of ids) {
        yield {
          name: idToRaw({ id: chatGroupId }),
          type: 'directory',
          fullPath: `${path}/${idToRaw({ id: chatGroupId })}`,
        };
      }
    },
    async getChild({
      name,
      parentPath,
      context,
    }: {
      name: string,
      parentPath: string,
      context: NaidanSysfsContext,
    }): Promise<NaidanSysfsEntry | undefined> {
      void parentPath;
      const chatGroup = await loadChatGroup({ context, chatGroupId: toChatGroupId({ raw: name }) });
      if (chatGroup === undefined) {
        return undefined;
      }
      return createChatGroupDirectoryEntry({ context, chatGroup });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
