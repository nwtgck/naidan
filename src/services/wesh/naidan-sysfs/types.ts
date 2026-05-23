import type { EmptyArgs, Chat, ChatContent, ChatGroup, ChatMeta, Hierarchy, SidebarItem } from '@/models/types'
import type { WeshDirEntry, WeshFileHandle, WeshOpenFlags, WeshStat } from '@/services/wesh/types'

export interface NaidanSysfsStorageReader {
  loadHierarchy(_args: EmptyArgs): Promise<Hierarchy>;
  getSidebarStructure(_args: EmptyArgs): Promise<SidebarItem[]>;
  listChats(_args: EmptyArgs): Promise<Array<Pick<Chat, 'id' | 'title' | 'updatedAt' | 'groupId'>>>;
  listChatGroups(_args: EmptyArgs): Promise<ChatGroup[]>;
  loadChatMeta({ chatId }: { chatId: string }): Promise<ChatMeta | undefined>;
  loadChatContent({ chatId }: { chatId: string }): Promise<ChatContent | undefined>;
  loadChat({ chatId }: { chatId: string }): Promise<Chat | undefined>;
  loadChatGroup({ chatGroupId }: { chatGroupId: string }): Promise<ChatGroup | undefined>;
}

export interface NaidanSysfsContext {
  reader: NaidanSysfsStorageReader;
}

export interface NaidanSysfsDirectoryEntry {
  kind: 'directory';
  stat({ path }: { path: string }): Promise<WeshStat>;
  readDir({ path, context }: { path: string; context: NaidanSysfsContext }): AsyncIterable<WeshDirEntry>;
  getChild({ name, parentPath, context }: {
    name: string;
    parentPath: string;
    context: NaidanSysfsContext;
  }): Promise<NaidanSysfsEntry | undefined>;
}

export interface NaidanSysfsFileEntry {
  kind: 'file';
  stat({ path }: { path: string }): Promise<WeshStat>;
  open({ path, flags }: { path: string; flags: WeshOpenFlags }): Promise<WeshFileHandle>;
}

export interface NaidanSysfsSymlinkEntry {
  kind: 'symlink';
  stat({ path }: { path: string }): Promise<WeshStat>;
  readlink({ path }: { path: string }): Promise<string>;
}

export interface NaidanSysfsRestrictedDirectoryEntry {
  kind: 'restricted-directory';
  stat({ path }: { path: string }): Promise<WeshStat>;
  readDir({ path }: { path: string }): AsyncIterable<WeshDirEntry>;
}

export type NaidanSysfsEntry =
  | NaidanSysfsDirectoryEntry
  | NaidanSysfsFileEntry
  | NaidanSysfsSymlinkEntry
  | NaidanSysfsRestrictedDirectoryEntry
