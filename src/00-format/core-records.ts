import { idToRaw, toChatId, toChatGroupId, type ChatGroupId, type ChatId, type VolumeId } from '@/01-models/ids';
import type { Chat, ChatContent, ChatGroup, ChatMeta, Hierarchy, Settings } from '@/01-models/types';
import type { FileLocation, ReadFileText, WriteFileText } from './file-record';
import {
  ChatContentDtoSchema, ChatGroupDtoSchema, ChatMetaDtoSchema, HierarchyDtoSchema, SettingsDtoSchema,
  type ChatGroupDto, type ChatMetaDto,
} from './00-dto/dto';
import {
  chatContentToDomain, chatContentToDto, chatGroupConfigurationToDomain, chatGroupToDto,
  chatMetaToDomain, chatMetaToDto, chatToDomain, hierarchyToDomain, hierarchyToDto, settingsToDomain, settingsToDto,
} from './mapper/mappers';
import * as layout from './01-layout/layout-entries';

function readSettings({ text }: { text: string }): Settings {
  return settingsToDomain({ dto: SettingsDtoSchema.parse(JSON.parse(text)) });
}

function settingsText({ settings }: { settings: Settings }): string {
  return JSON.stringify(SettingsDtoSchema.parse(settingsToDto({ domain: settings })));
}

function readHierarchy({ text }: { text: string }): Hierarchy {
  return hierarchyToDomain({ dto: HierarchyDtoSchema.parse(JSON.parse(text)) });
}

function groupIdForChat({ text, id }: { text: string, id: ChatId }): ChatGroupId | undefined {
  const rawId = idToRaw({ id });
  const { items } = HierarchyDtoSchema.parse(JSON.parse(text));
  const group = items.find(item => item.type === 'chat_group' && item.chat_ids.includes(rawId));
  return group === undefined ? undefined : toChatGroupId({ raw: group.id });
}

function hierarchyText({ hierarchy }: { hierarchy: Hierarchy }): string {
  return JSON.stringify(hierarchyToDto({ domain: hierarchy }));
}

function chatMetaText({ meta }: { meta: ChatMeta }): string {
  return JSON.stringify(ChatMetaDtoSchema.parse(chatMetaToDto({ domain: meta })));
}

function chatContentText({ content }: { content: ChatContent }): string {
  const dto = chatContentToDto({ domain: content });
  ChatContentDtoSchema.parse(dto);
  return JSON.stringify(dto);
}

function readChatContent({ text }: { text: string }): ChatContent {
  return chatContentToDomain({ dto: ChatContentDtoSchema.parse(JSON.parse(text)) });
}

function chatGroupText({ chatGroup }: { chatGroup: ChatGroup }): string {
  return JSON.stringify(ChatGroupDtoSchema.parse(chatGroupToDto({ domain: chatGroup })));
}

export function storedChatMeta({ dto }: { dto: ChatMetaDto }) {
  return {
    id: toChatId({ raw: dto.id }),
    toDomain: () => chatMetaToDomain({ dto }),
    referencesVolume: ({ volumeId }: { volumeId: VolumeId }) =>
      dto.mounts?.some(mount => mount.volumeId === idToRaw({ id: volumeId })) ?? false,
  };
}

export function storedChatGroup({ dto }: { dto: ChatGroupDto }) {
  return {
    configuration: () => chatGroupConfigurationToDomain({ dto }),
    referencesVolume: ({ volumeId }: { volumeId: VolumeId }) =>
      dto.mounts?.some(mount => mount.volumeId === idToRaw({ id: volumeId })) ?? false,
  };
}

export type StoredChatMeta = ReturnType<typeof storedChatMeta>;
export type StoredChatGroup = ReturnType<typeof storedChatGroup>;

function decodeChat({ metaText, contentText }: {
  metaText: string | undefined, contentText: string | undefined,
}): Chat | undefined {
  const meta = metaText === undefined ? undefined : ChatMetaDtoSchema.parse(JSON.parse(metaText));
  const content = contentText === undefined ? undefined : ChatContentDtoSchema.parse(JSON.parse(contentText));
  if (meta === undefined || content === undefined) {
    return undefined;
  }
  return chatToDomain({ dto: { ...meta, ...content, experimental: meta.experimental, messages: undefined } });
}

function fileRecords<I extends ChatId | ChatGroupId>({ directory }: { directory: FileLocation }) {
  return {
    path: directory.path,
    file({ id }: { id: I }) {
      return layout.entry({ parent: directory.path, name: idToRaw({ id }) + '.json' });
    },
    listedFile({ name }: { name: string }) {
      return name.endsWith('.json') ? layout.entry({ parent: directory.path, name }) : undefined;
    },
  };
}

export function opfsCoreRecords({ settings, hierarchy, chatMetas, chatContents, chatGroups }: {
  settings: FileLocation, hierarchy: FileLocation, chatMetas: FileLocation,
  chatContents: FileLocation, chatGroups: FileLocation,
}) {
  const metas = fileRecords<ChatId>({ directory: chatMetas });
  const contents = fileRecords<ChatId>({ directory: chatContents });
  const groups = fileRecords<ChatGroupId>({ directory: chatGroups });
  return {
    settings: {
      path: settings.path,
      async read({ readText }: { readText: ReadFileText }): Promise<Settings | undefined> {
        const text = await readText({ file: settings });
        return text === undefined ? undefined : readSettings({ text });
      },
      write({ settings: value, writeText }: { settings: Settings, writeText: WriteFileText }) {
        return writeText({ file: settings, text: settingsText({ settings: value }) });
      },
    },
    hierarchy: {
      path: hierarchy.path,
      async read({ readText }: { readText: ReadFileText }): Promise<Hierarchy | undefined> {
        const text = await readText({ file: hierarchy });
        return text === undefined ? undefined : readHierarchy({ text });
      },
      async findChatGroupId({ id, readText }: { id: ChatId, readText: ReadFileText }): Promise<ChatGroupId | undefined> {
        const text = await readText({ file: hierarchy });
        return text === undefined ? undefined : groupIdForChat({ text, id });
      },
      write({ hierarchy: value, writeText }: { hierarchy: Hierarchy, writeText: WriteFileText }) {
        return writeText({ file: hierarchy, text: hierarchyText({ hierarchy: value }) });
      },
    },
    chatMetas: {
      path: metas.path,
      file: metas.file,
      async read({ id, readText }: { id: ChatId, readText: ReadFileText }): Promise<ChatMeta | undefined> {
        const text = await readText({ file: metas.file({ id }) });
        return text === undefined ? undefined : chatMetaToDomain({ dto: ChatMetaDtoSchema.parse(JSON.parse(text)) });
      },
      async readListed({ name, readText }: { name: string, readText: ReadFileText }): Promise<StoredChatMeta | undefined> {
        const file = metas.listedFile({ name });
        const text = file === undefined ? undefined : await readText({ file });
        return text === undefined ? undefined : storedChatMeta({ dto: ChatMetaDtoSchema.parse(JSON.parse(text)) });
      },
      write({ meta, writeText }: { meta: ChatMeta, writeText: WriteFileText }) {
        return writeText({ file: metas.file({ id: meta.id }), text: chatMetaText({ meta }) });
      },
    },
    chatContents: {
      path: contents.path,
      file: contents.file,
      async read({ id, readText }: { id: ChatId, readText: ReadFileText }): Promise<ChatContent | undefined> {
        const text = await readText({ file: contents.file({ id }) });
        return text === undefined ? undefined : readChatContent({ text });
      },
      write({ id, content, writeText }: { id: ChatId, content: ChatContent, writeText: WriteFileText }) {
        return writeText({ file: contents.file({ id }), text: chatContentText({ content }) });
      },
      inspectRoundTrip({ content }: { content: ChatContent }) {
        const serialized = chatContentText({ content });
        return { serialized, restored: readChatContent({ text: serialized }) };
      },
    },
    chatGroups: {
      path: groups.path,
      file: groups.file,
      async read({ id, readText }: { id: ChatGroupId, readText: ReadFileText }): Promise<StoredChatGroup | undefined> {
        const text = await readText({ file: groups.file({ id }) });
        return text === undefined ? undefined : storedChatGroup({ dto: ChatGroupDtoSchema.parse(JSON.parse(text)) });
      },
      async readListed({ name, readText }: { name: string, readText: ReadFileText }): Promise<StoredChatGroup | undefined> {
        const file = groups.listedFile({ name });
        const text = file === undefined ? undefined : await readText({ file });
        return text === undefined ? undefined : storedChatGroup({ dto: ChatGroupDtoSchema.parse(JSON.parse(text)) });
      },
      write({ chatGroup, writeText }: { chatGroup: ChatGroup, writeText: WriteFileText }) {
        return writeText({ file: groups.file({ id: chatGroup.id }), text: chatGroupText({ chatGroup }) });
      },
    },
    chats: {
      async read({ id, readText }: { id: ChatId, readText: ReadFileText }) {
        const metaText = await readText({ file: metas.file({ id }) });
        const contentText = await readText({ file: contents.file({ id }) });
        return decodeChat({ metaText, contentText });
      },
    },
  };
}

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;
type ListStorage = Pick<Storage, 'getItem' | 'key' | 'length'>;

function listRecords<T>({ prefix, storage, decode }: {
  prefix: string, storage: ListStorage, decode({ text }: { text: string }): T,
}): T[] {
  const records: T[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && key.startsWith(prefix)) {
      const text = storage.getItem(key);
      if (text !== null) {
        records.push(decode({ text }));
      }
    }
  }
  return records;
}

export function localCoreRecords({ settings, hierarchy, chatMetas, chatContents, chatGroups }: {
  settings: string, hierarchy: string, chatMetas: string, chatContents: string, chatGroups: string,
}) {
  const metaKey = ({ id }: { id: ChatId }) => chatMetas + idToRaw({ id });
  const contentKey = ({ id }: { id: ChatId }) => chatContents + idToRaw({ id });
  const groupKey = ({ id }: { id: ChatGroupId }) => chatGroups + idToRaw({ id });
  return {
    settings: {
      // The provider handles persisted-value errors separately from getItem errors.
      capture({ storage }: { storage: ReadStorage }): (() => Settings) | undefined {
        const text = storage.getItem(settings);
        return text === null ? undefined : () => readSettings({ text });
      },
      write({ settings: value, storage }: { settings: Settings, storage: WriteStorage }) {
        storage.setItem(settings, settingsText({ settings: value }));
      },
    },
    hierarchy: {
      read({ storage }: { storage: ReadStorage }): Hierarchy | undefined {
        const text = storage.getItem(hierarchy);
        return text === null ? undefined : readHierarchy({ text });
      },
      findChatGroupId({ id, storage }: { id: ChatId, storage: ReadStorage }): ChatGroupId | undefined {
        const text = storage.getItem(hierarchy);
        return text === null ? undefined : groupIdForChat({ text, id });
      },
      write({ hierarchy: value, storage }: { hierarchy: Hierarchy, storage: WriteStorage }) {
        storage.setItem(hierarchy, hierarchyText({ hierarchy: value }));
      },
    },
    chatMetas: {
      read({ id, storage }: { id: ChatId, storage: ReadStorage }): ChatMeta | undefined {
        const text = storage.getItem(metaKey({ id }));
        return text === null ? undefined : chatMetaToDomain({ dto: ChatMetaDtoSchema.parse(JSON.parse(text)) });
      },
      list({ storage }: { storage: ListStorage }) {
        return listRecords({ prefix: chatMetas, storage, decode: ({ text }) => storedChatMeta({ dto: ChatMetaDtoSchema.parse(JSON.parse(text)) }) });
      },
      write({ meta, storage }: { meta: ChatMeta, storage: WriteStorage }) {
        storage.setItem(metaKey({ id: meta.id }), chatMetaText({ meta }));
      },
    },
    chatContents: {
      read({ id, storage }: { id: ChatId, storage: ReadStorage }): ChatContent | undefined {
        const text = storage.getItem(contentKey({ id }));
        return text === null ? undefined : readChatContent({ text });
      },
      write({ id, content, storage }: { id: ChatId, content: ChatContent, storage: WriteStorage }) {
        storage.setItem(contentKey({ id }), chatContentText({ content }));
      },
    },
    chatGroups: {
      capture({ id, storage }: { id: ChatGroupId, storage: ReadStorage }): (() => StoredChatGroup) | undefined {
        const text = storage.getItem(groupKey({ id }));
        return text === null ? undefined : () => storedChatGroup({ dto: ChatGroupDtoSchema.parse(JSON.parse(text)) });
      },
      list({ storage }: { storage: ListStorage }) {
        return listRecords({ prefix: chatGroups, storage, decode: ({ text }) => storedChatGroup({ dto: ChatGroupDtoSchema.parse(JSON.parse(text)) }) });
      },
      write({ chatGroup, storage }: { chatGroup: ChatGroup, storage: WriteStorage }) {
        storage.setItem(groupKey({ id: chatGroup.id }), chatGroupText({ chatGroup }));
      },
      remove({ id, storage }: { id: ChatGroupId, storage: Pick<Storage, 'removeItem'> }) {
        storage.removeItem(groupKey({ id }));
      },
    },
    chats: {
      read({ id, storage }: { id: ChatId, storage: ReadStorage }) {
        const metaText = storage.getItem(metaKey({ id }));
        const contentText = storage.getItem(contentKey({ id }));
        return decodeChat({ metaText: metaText ?? undefined, contentText: contentText ?? undefined });
      },
      remove({ id, storage }: { id: ChatId, storage: Pick<Storage, 'removeItem'> }) {
        storage.removeItem(metaKey({ id }));
        storage.removeItem(contentKey({ id }));
      },
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
