import type { SidebarItem } from '@/01-models/types';
import { idToRaw } from '@/01-models/ids';
import type { ChatGroupId, ChatId } from '@/01-models/ids';
import { NAIDAN_SYSFS_ROOT_PATH } from '@/features/wesh/naidan-sysfs/constants';
import type { NaidanSysfsContext, NaidanSysfsDirectoryEntry, NaidanSysfsEntry, NaidanSysfsSymlinkEntry } from '@/features/wesh/naidan-sysfs/types';
import type { WeshDirEntry, WeshStat } from '@/features/wesh/types';

function createDirectoryStat(): WeshStat {
  return { size: 0, mode: 0o555, type: 'directory', mtime: 0, ino: 0, uid: 0, gid: 0 };
}

function createChatSymlinkEntry({ chatId }: { chatId: ChatId }): NaidanSysfsSymlinkEntry {
  return {
    kind: 'symlink',
    async stat({ path }: { path: string }) {
      void path;
      return { size: `${NAIDAN_SYSFS_ROOT_PATH}/chats/${idToRaw({ id: chatId })}`.length, mode: 0o777, type: 'symlink', mtime: 0, ino: 0, uid: 0, gid: 0 };
    },
    async readlink({ path }: { path: string }) {
      void path;
      return `${NAIDAN_SYSFS_ROOT_PATH}/chats/${idToRaw({ id: chatId })}`;
    },
  };
}

function createChatGroupSymlinkEntry({ chatGroupId }: { chatGroupId: ChatGroupId }): NaidanSysfsSymlinkEntry {
  return {
    kind: 'symlink',
    async stat({ path }: { path: string }) {
      void path;
      return { size: `${NAIDAN_SYSFS_ROOT_PATH}/chat-groups/${idToRaw({ id: chatGroupId })}`.length, mode: 0o777, type: 'symlink', mtime: 0, ino: 0, uid: 0, gid: 0 };
    },
    async readlink({ path }: { path: string }) {
      void path;
      return `${NAIDAN_SYSFS_ROOT_PATH}/chat-groups/${idToRaw({ id: chatGroupId })}`;
    },
  };
}

function createHierarchyChatSymlinkName({
  index,
  chatId,
}: {
  index: number,
  chatId: ChatId,
}): string {
  return `${index}-chat-${idToRaw({ id: chatId })}`;
}

function createHierarchyChatGroupSymlinkName({
  index,
  chatGroupId,
}: {
  index: number,
  chatGroupId: ChatGroupId,
}): string {
  return `${index}-chat-group-${idToRaw({ id: chatGroupId })}`;
}

async function listVisibleHierarchyItems({ context }: { context: NaidanSysfsContext }): Promise<SidebarItem[]> {
  const items = await context.reader.getSidebarStructure();

  switch (context.visibility) {
  case 'current_chat_only':
    if (context.currentChatGroupId !== undefined) {
      return items.filter(item => item.type === 'chat_group' && item.chatGroup.id === context.currentChatGroupId);
    }
    return items.filter(item => item.type === 'chat' && item.chat.id === context.currentChatId);
  case 'current_chat_with_chat_group':
    if (context.currentChatGroupId !== undefined) {
      return items.filter(item => item.type === 'chat_group' && item.chatGroup.id === context.currentChatGroupId);
    }
    return items.filter(item => item.type === 'chat' && item.chat.id === context.currentChatId);
  case 'main_chats':
    return items;
  default: {
    const _ex: never = context.visibility;
    throw new Error(`Unhandled visibility: ${String(_ex)}`);
  }
  }
}

export function createHierarchyDirectoryEntry(): NaidanSysfsDirectoryEntry {
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
      const items = await listVisibleHierarchyItems({ context });
      for (const [index, item] of items.entries()) {
        const name = (() => {
          switch (item.type) {
          case 'chat':
            return createHierarchyChatSymlinkName({ index: index + 1, chatId: item.chat.id });
          case 'chat_group':
            return createHierarchyChatGroupSymlinkName({ index: index + 1, chatGroupId: item.chatGroup.id });
          default: {
            const _ex: never = item;
            throw new Error(`Unhandled hierarchy item type: ${String(_ex)}`);
          }
          }
        })();
        yield { name, type: 'symlink', fullPath: `${path}/${name}` };
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
      const items = await listVisibleHierarchyItems({ context });
      for (const [index, item] of items.entries()) {
        switch (item.type) {
        case 'chat': {
          const expectedName = createHierarchyChatSymlinkName({ index: index + 1, chatId: item.chat.id });
          if (expectedName === name) {
            return createChatSymlinkEntry({ chatId: item.chat.id });
          }
          break;
        }
        case 'chat_group': {
          const expectedName = createHierarchyChatGroupSymlinkName({
            index: index + 1,
            chatGroupId: item.chatGroup.id,
          });
          if (expectedName === name) {
            return createChatGroupSymlinkEntry({ chatGroupId: item.chatGroup.id });
          }
          break;
        }
        default: {
          const _ex: never = item;
          throw new Error(`Unhandled hierarchy item type: ${String(_ex)}`);
        }
        }
      }
      return undefined;
    },
  };
}
