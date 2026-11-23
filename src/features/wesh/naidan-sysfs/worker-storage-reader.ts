// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Replace the mapper dependency with the storage service API.
import { chatContentToDomain, chatMetaToDomain, hierarchyToDomain, lmParametersToDomain } from '@/00-storage/mapper/mappers';
import { idToRaw, toChatGroupId, toChatId } from '@/01-models/ids';
import type { BinaryObjectId, ChatGroupId, ChatId } from '@/01-models/ids';
import type { ChatGroup } from '@/01-models/types';
import { OPFSStorageProvider } from '@/00-storage/service/opfs-storage';
import {
  naidanSysfsRemoteBinaryObjectSchema,
  naidanSysfsRemoteChatContentPayloadSchema,
  naidanSysfsRemoteChatGroupPayloadSchema,
  naidanSysfsRemoteChatMetaPayloadSchema,
  naidanSysfsRemoteChatPayloadSchema,
  naidanSysfsRemoteChatSummarySchema,
  naidanSysfsRemoteSidebarItemSchema,
} from './remote-reader-schema';
import { createNaidanSysfsBinaryObject } from './binary-object-metadata';
import { redactSysfsConnectionSettings, redactSysfsSidebarItem } from './redact-connection-settings';
import type {
  NaidanSysfsRemoteChatGroupPayload,
  NaidanSysfsRemoteChatPayload,
  NaidanSysfsRemoteReader,
  NaidanSysfsStorageReader,
} from './types';

export async function createOpfsNaidanSysfsStorageReader(): Promise<NaidanSysfsStorageReader> {
  const provider = new OPFSStorageProvider();
  await provider.init();

  return {
    async loadHierarchy() {
      const dto = await provider.loadHierarchy();
      return dto ? hierarchyToDomain({ dto }) : { items: [] };
    },
    async getSidebarStructure() {
      return (await provider.getSidebarStructure()).map(item => redactSysfsSidebarItem({ item }));
    },
    async listChats() {
      return provider.listChats();
    },
    async listChatGroups() {
      return (await provider.listChatGroups()).map(value => redactSysfsConnectionSettings({ value }));
    },
    async loadChatMeta({ chatId }: { chatId: ChatId }) {
      const value = await provider.loadChatMeta({ id: chatId });
      return value === null ? undefined : redactSysfsConnectionSettings({ value });
    },
    async loadChatContent({ chatId }: { chatId: ChatId }) {
      return (await provider.loadChatContent({ id: chatId })) ?? undefined;
    },
    async loadChat({ chatId }: { chatId: ChatId }) {
      const value = await provider.loadChat({ id: chatId });
      return value === null ? undefined : redactSysfsConnectionSettings({ value });
    },
    async loadChatGroup({ chatGroupId }: { chatGroupId: ChatGroupId }) {
      const value = await provider.loadChatGroup({ id: chatGroupId });
      return value === null ? undefined : redactSysfsConnectionSettings({ value });
    },
    async *listBinaryObjects() {
      for await (const object of provider.listBinaryObjects()) {
        yield createNaidanSysfsBinaryObject({ object: { ...object, id: idToRaw({ id: object.id }) } });
      }
    },
    async getBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }) {
      const object = await provider.getBinaryObject({ binaryObjectId });
      return object === null ? undefined : createNaidanSysfsBinaryObject({ object: { ...object, id: idToRaw({ id: object.id }) } });
    },
    async getBinaryObjectBlob({ binaryObjectId }: { binaryObjectId: BinaryObjectId }) {
      return (await provider.getFile({ binaryObjectId })) ?? undefined;
    },
  };
}

function remoteChatGroupPayloadToDomain({
  payload,
}: {
  payload: NaidanSysfsRemoteChatGroupPayload,
}): ChatGroup {
  const metadata = chatMetaToDomain({
    dto: {
      id: payload.dto.id,
      title: null,
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
      endpoint: payload.dto.endpoint,
      modelId: payload.dto.modelId,
      titleGeneration: payload.dto.titleGeneration,
      currentLeafId: undefined,
      originChatId: undefined,
      originMessageId: undefined,
      systemPrompt: payload.dto.systemPrompt,
      lmParameters: payload.dto.lmParameters,
      mounts: payload.dto.mounts,
    },
  });

  return {
    id: toChatGroupId({ raw: payload.dto.id }),
    name: payload.dto.name,
    isCollapsed: payload.dto.isCollapsed,
    updatedAt: payload.dto.updatedAt,
    items: payload.items.map(item => ({
      id: item.id,
      type: 'chat',
      chat: {
        id: toChatId({ raw: item.chat.id }),
        title: item.chat.title,
        updatedAt: item.chat.updatedAt,
        groupId: item.chat.groupId === undefined || item.chat.groupId === null ? undefined : toChatGroupId({ raw: item.chat.groupId }),
      },
    })),
    endpoint: metadata.endpoint,
    modelId: payload.dto.modelId,
    titleGeneration: metadata.titleGeneration,
    systemPrompt: metadata.systemPrompt,
    lmParameters: lmParametersToDomain({ dto: payload.dto.lmParameters }),
    mounts: metadata.mounts,
  };
}

async function loadRemoteChatMeta({
  remoteReader,
  chatId,
}: {
  remoteReader: NaidanSysfsRemoteReader,
  chatId: string,
}) {
  const payload = await remoteReader.loadChatMeta({ chatId });
  if (payload === undefined) {
    return undefined;
  }
  const metadata = chatMetaToDomain({ dto: naidanSysfsRemoteChatMetaPayloadSchema.parse(payload).dto });
  metadata.groupId = payload.groupId === undefined || payload.groupId === null ? payload.groupId : toChatGroupId({ raw: payload.groupId });
  return metadata;
}

async function loadRemoteChatContent({
  remoteReader,
  chatId,
}: {
  remoteReader: NaidanSysfsRemoteReader,
  chatId: string,
}) {
  const payload = await remoteReader.loadChatContent({ chatId });
  if (payload === undefined) {
    return undefined;
  }
  return chatContentToDomain({
    dto: naidanSysfsRemoteChatContentPayloadSchema.parse(payload),
  });
}

function remoteChatPayloadToDomain({
  payload,
}: {
  payload: NaidanSysfsRemoteChatPayload,
}) {
  const parsed = naidanSysfsRemoteChatPayloadSchema.parse(payload);
  const metadata = chatMetaToDomain({ dto: parsed.metadata.dto });
  metadata.groupId = parsed.metadata.groupId === undefined || parsed.metadata.groupId === null
    ? parsed.metadata.groupId
    : toChatGroupId({ raw: parsed.metadata.groupId });
  const content = chatContentToDomain({
    dto: parsed.content,
  });
  return {
    ...metadata,
    root: content.root,
    currentLeafId: content.currentLeafId ?? metadata.currentLeafId,
  };
}

export function createRemoteNaidanSysfsStorageReader({
  remoteReader,
}: {
  remoteReader: NaidanSysfsRemoteReader,
}): NaidanSysfsStorageReader {
  return {
    async loadHierarchy() {
      const items = naidanSysfsRemoteSidebarItemSchema.array().parse(await remoteReader.getSidebarStructure());
      const chatGroupItems = items.filter(
        (item): item is Extract<typeof item, { type: 'chat_group' }> => item.type === 'chat_group',
      );
      const chatItems = items.filter(
        (item): item is Extract<typeof item, { type: 'chat' }> => item.type === 'chat',
      );
      return {
        items: [
          ...chatGroupItems.map(item => ({
            type: 'chat_group' as const,
            id: toChatGroupId({ raw: item.chatGroup.dto.id }),
            chat_ids: item.chatGroup.items.map(chatItem => toChatId({ raw: chatItem.chat.id })),
          })),
          ...chatItems.map(item => ({
            type: 'chat' as const,
            id: toChatId({ raw: item.chat.id }),
          })),
        ],
      };
    },
    async getSidebarStructure() {
      return naidanSysfsRemoteSidebarItemSchema.array().parse(await remoteReader.getSidebarStructure()).map(item => {
        switch (item.type) {
        case 'chat':
          return {
            id: item.id,
            type: 'chat',
            chat: {
              id: toChatId({ raw: item.chat.id }),
              title: item.chat.title,
              updatedAt: item.chat.updatedAt,
              groupId: item.chat.groupId === undefined || item.chat.groupId === null ? undefined : toChatGroupId({ raw: item.chat.groupId }),
            },
          };
        case 'chat_group':
          return {
            id: item.id,
            type: 'chat_group',
            chatGroup: remoteChatGroupPayloadToDomain({ payload: item.chatGroup }),
          };
        default: {
          const _ex: never = item;
          throw new Error(`Unhandled remote sidebar item type: ${String(_ex)}`);
        }
        }
      });
    },
    async listChats() {
      return naidanSysfsRemoteChatSummarySchema.array().parse(await remoteReader.listChats()).map(chat => ({
        id: toChatId({ raw: chat.id }),
        title: chat.title,
        updatedAt: chat.updatedAt,
        groupId: chat.groupId === undefined || chat.groupId === null ? chat.groupId : toChatGroupId({ raw: chat.groupId }),
      }));
    },
    async listChatGroups() {
      return naidanSysfsRemoteChatGroupPayloadSchema.array().parse(await remoteReader.listChatGroups()).map(payload =>
        remoteChatGroupPayloadToDomain({ payload }),
      );
    },
    async loadChatMeta({ chatId }: { chatId: ChatId }) {
      return loadRemoteChatMeta({ remoteReader, chatId: idToRaw({ id: chatId }) });
    },
    async loadChatContent({ chatId }: { chatId: ChatId }) {
      return loadRemoteChatContent({ remoteReader, chatId: idToRaw({ id: chatId }) });
    },
    async loadChat({ chatId }: { chatId: ChatId }) {
      const payload = await remoteReader.loadChat({ chatId: idToRaw({ id: chatId }) });
      if (payload === undefined) {
        return undefined;
      }
      return remoteChatPayloadToDomain({ payload });
    },
    async loadChatGroup({ chatGroupId }: { chatGroupId: ChatGroupId }) {
      const chatGroup = await remoteReader.loadChatGroup({ chatGroupId: idToRaw({ id: chatGroupId }) });
      if (chatGroup === undefined) {
        return undefined;
      }
      return remoteChatGroupPayloadToDomain({
        payload: naidanSysfsRemoteChatGroupPayloadSchema.parse(chatGroup),
      });
    },
    async *listBinaryObjects() {
      const objects = await remoteReader.listBinaryObjects();
      for (const object of objects) {
        yield naidanSysfsRemoteBinaryObjectSchema.parse(object);
      }
    },
    async getBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }) {
      const object = await remoteReader.getBinaryObject({ binaryObjectId: idToRaw({ id: binaryObjectId }) });
      if (object === undefined) {
        return undefined;
      }
      return naidanSysfsRemoteBinaryObjectSchema.parse(object);
    },
    async getBinaryObjectBlob({ binaryObjectId }: { binaryObjectId: BinaryObjectId }) {
      return await remoteReader.getBinaryObjectBlob({ binaryObjectId: idToRaw({ id: binaryObjectId }) });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
