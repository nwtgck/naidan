import type { Chat, ChatContent, ChatGroup, ChatMeta, ChatSummary, Hierarchy, SidebarItem } from '@/models/types'
import type { BinaryObjectId, ChatGroupId, ChatId } from '@/models/ids'
import type { ChatContentDto, ChatGroupDto, ChatMetaDto } from '@/models/dto'
import type { NaidanSysfsBinaryObjectAccess, NaidanSysfsVisibility, WeshDirEntry, WeshFileHandle, WeshOpenFlags, WeshStat } from '@/services/wesh/types'

export interface NaidanSysfsBinaryObject {
  id: string;
  name: string | null;
  mimeType: string;
  size: number;
  createdAt: number;
}

export interface NaidanSysfsStorageReader {
  loadHierarchy(): Promise<Hierarchy>;
  getSidebarStructure(): Promise<SidebarItem[]>;
  listChats(): Promise<ChatSummary[]>;
  listChatGroups(): Promise<ChatGroup[]>;
  loadChatMeta({ chatId }: { chatId: ChatId }): Promise<ChatMeta | undefined>;
  loadChatContent({ chatId }: { chatId: ChatId }): Promise<ChatContent | undefined>;
  loadChat({ chatId }: { chatId: ChatId }): Promise<Chat | undefined>;
  loadChatGroup({ chatGroupId }: { chatGroupId: ChatGroupId }): Promise<ChatGroup | undefined>;
  listBinaryObjects(): AsyncIterable<NaidanSysfsBinaryObject>;
  getBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<NaidanSysfsBinaryObject | undefined>;
  getBinaryObjectBlob({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<Blob | undefined>;
}

export interface NaidanSysfsRemoteChatMetaPayload {
  dto: ChatMetaDto;
  groupId: string | null | undefined;
}

export interface NaidanSysfsRemoteChatSidebarItem {
  id: string;
  type: 'chat';
  chat: { id: string; title: string | null; updatedAt: number; groupId?: string | null };
}

export interface NaidanSysfsRemoteChatGroupPayload {
  dto: ChatGroupDto;
  items: NaidanSysfsRemoteChatSidebarItem[];
}

export type NaidanSysfsRemoteSidebarItem =
  | NaidanSysfsRemoteChatSidebarItem
  | {
    id: string;
    type: 'chat_group';
    chatGroup: NaidanSysfsRemoteChatGroupPayload;
  }

export interface NaidanSysfsRemoteReader {
  readonly storageType: 'local' | 'memory';
  getSidebarStructure(): Promise<NaidanSysfsRemoteSidebarItem[]>;
  listChats(): Promise<Array<{ id: string; title: string | null; updatedAt: number; groupId?: string | null }>>;
  listChatGroups(): Promise<NaidanSysfsRemoteChatGroupPayload[]>;
  loadChatMeta({ chatId }: { chatId: string }): Promise<NaidanSysfsRemoteChatMetaPayload | undefined>;
  loadChatContent({ chatId }: { chatId: string }): Promise<ChatContentDto | undefined>;
  loadChatGroup({ chatGroupId }: { chatGroupId: string }): Promise<NaidanSysfsRemoteChatGroupPayload | undefined>;
  listBinaryObjects(): Promise<NaidanSysfsBinaryObject[]>;
  getBinaryObject({ binaryObjectId }: { binaryObjectId: string }): Promise<NaidanSysfsBinaryObject | undefined>;
  getBinaryObjectBlob({ binaryObjectId }: { binaryObjectId: string }): Promise<Blob | undefined>;
}

export interface NaidanSysfsContext {
  reader: NaidanSysfsStorageReader;
  visibility: NaidanSysfsVisibility;
  binaryObjectAccess: NaidanSysfsBinaryObjectAccess;
  currentChatId: ChatId;
  currentChatGroupId: ChatGroupId | undefined;
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
