// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Replace the mapper dependency with the storage service API.
import { chatContentToDto, chatGroupToDto, chatMetaToDto } from '@/00-storage/mapper/mappers';
import { idToRaw, toBinaryObjectId, toChatGroupId, toChatId } from '@/01-models/ids';
import type { ChatGroupId, ChatId } from '@/01-models/ids';
import type { ChatGroup, SidebarItem } from '@/01-models/types';
import { storageService } from '@/00-storage/service';
import type { WeshMount } from '@/features/wesh/types';
import type { WeshWorkerMount } from '@/features/wesh/worker/types';
import { getEffectiveWeshMounts } from '@/features/wesh/mount-policy';
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
import { redactSysfsConnectionSettings } from './redact-connection-settings';
import type {
  NaidanSysfsBinaryObject,
  NaidanSysfsRemoteChatGroupPayload,
  NaidanSysfsRemoteChatSidebarItem,
  NaidanSysfsRemoteReader,
  NaidanSysfsRemoteSidebarItem,
} from './types';

export function createNaidanSysfsRemoteReaderForMounts({
  mounts,
}: {
  mounts: Array<WeshMount | WeshWorkerMount>,
}): NaidanSysfsRemoteReader | undefined {
  for (const mount of getEffectiveWeshMounts({ mounts })) {
    switch (mount.type) {
    case 'directory':
    case 'managed_directory':
      continue;
    case 'naidan_sysfs':
      switch (mount.storageType) {
      case 'local':
      case 'memory':
        return createNaidanSysfsRemoteReader({ storageType: mount.storageType });
      case 'opfs':
        continue;
      default: {
        const _ex: never = mount.storageType;
        throw new Error(`Unhandled naidan sysfs storage type: ${String(_ex)}`);
      }
      }
    default: {
      const _ex: never = mount;
      throw new Error(`Unhandled wesh mount type: ${String(_ex)}`);
    }
    }
  }

  return undefined;
}

function assertStorageTypeMatches({
  expectedStorageType,
}: {
  expectedStorageType: 'local' | 'memory',
}): void {
  const currentStorageType = storageService.getCurrentType();
  if (currentStorageType !== expectedStorageType) {
    throw new Error(`Naidan sysfs remote reader expected ${expectedStorageType} storage, received: ${currentStorageType}`);
  }
}

/**
 * Sysfs chat output follows the current normalized message structure and may
 * change as that model evolves. Storage mappers retain support for older saved
 * data; that does not require preserving older public sysfs layouts.
 */
export function createNaidanSysfsRemoteReader({
  storageType,
}: {
  storageType: 'local' | 'memory',
}): NaidanSysfsRemoteReader {
  return {
    storageType,
    async getSidebarStructure() {
      assertStorageTypeMatches({ expectedStorageType: storageType });
      return naidanSysfsRemoteSidebarItemSchema.array().parse(
        (await storageService.getSidebarStructure()).map(item => createRemoteSidebarItem({ item })),
      );
    },
    async listChats() {
      assertStorageTypeMatches({ expectedStorageType: storageType });
      return naidanSysfsRemoteChatSummarySchema.array().parse((await storageService.listChats()).map(chat => ({
        ...chat,
        id: idToRaw({ id: chat.id }),
        groupId: chat.groupId === undefined || chat.groupId === null ? chat.groupId : idToRaw({ id: chat.groupId }),
      })));
    },
    async listChatGroups() {
      assertStorageTypeMatches({ expectedStorageType: storageType });
      return naidanSysfsRemoteChatGroupPayloadSchema.array().parse(
        (await storageService.listChatGroups()).map(chatGroup => createRemoteChatGroupPayload({ chatGroup })),
      );
    },
    async loadChatMeta({ chatId }: { chatId: string }) {
      assertStorageTypeMatches({ expectedStorageType: storageType });
      const metadata = await storageService.loadChatMeta({ id: toChatId({ raw: chatId }) });
      if (metadata === null) {
        return undefined;
      }
      return naidanSysfsRemoteChatMetaPayloadSchema.parse({
        dto: chatMetaToDto({ domain: redactSysfsConnectionSettings({ value: metadata }) }),
        groupId: metadata.groupId === undefined || metadata.groupId === null ? metadata.groupId : idToRaw({ id: metadata.groupId }),
      });
    },
    async loadChatContent({ chatId }: { chatId: string }) {
      assertStorageTypeMatches({ expectedStorageType: storageType });
      const content = await storageService.loadChatContent({ id: toChatId({ raw: chatId }) });
      if (content === null) {
        return undefined;
      }
      return naidanSysfsRemoteChatContentPayloadSchema.parse(chatContentToDto({ domain: content }));
    },
    async loadChat({ chatId }: { chatId: string }) {
      assertStorageTypeMatches({ expectedStorageType: storageType });
      const chat = await storageService.loadChat({ id: toChatId({ raw: chatId }) });
      if (chat === null) {
        return undefined;
      }
      return naidanSysfsRemoteChatPayloadSchema.parse({
        metadata: {
          dto: chatMetaToDto({ domain: redactSysfsConnectionSettings({ value: chat }) }),
          groupId: chat.groupId === undefined || chat.groupId === null
            ? chat.groupId
            : idToRaw({ id: chat.groupId }),
        },
        content: chatContentToDto({ domain: chat }),
      });
    },
    async loadChatGroup({ chatGroupId }: { chatGroupId: string }) {
      assertStorageTypeMatches({ expectedStorageType: storageType });
      const chatGroup = await storageService.loadChatGroup({ id: toChatGroupId({ raw: chatGroupId }) });
      if (chatGroup === null) {
        return undefined;
      }
      return naidanSysfsRemoteChatGroupPayloadSchema.parse(createRemoteChatGroupPayload({ chatGroup }));
    },
    async listBinaryObjects() {
      assertStorageTypeMatches({ expectedStorageType: storageType });
      const objects: NaidanSysfsBinaryObject[] = [];
      for await (const object of storageService.listBinaryObjects()) {
        objects.push(naidanSysfsRemoteBinaryObjectSchema.parse(createNaidanSysfsBinaryObject({
          object: {
            ...object,
            id: idToRaw({ id: object.id }),
          },
        })));
      }
      return objects;
    },
    async getBinaryObject({ binaryObjectId }: { binaryObjectId: string }) {
      assertStorageTypeMatches({ expectedStorageType: storageType });
      const object = await storageService.getBinaryObject({ binaryObjectId: toBinaryObjectId({ raw: binaryObjectId }) });
      if (object === null) {
        return undefined;
      }
      return naidanSysfsRemoteBinaryObjectSchema.parse(createNaidanSysfsBinaryObject({
        object: {
          ...object,
          id: idToRaw({ id: object.id }),
        },
      }));
    },
    async getBinaryObjectBlob({ binaryObjectId }: { binaryObjectId: string }) {
      assertStorageTypeMatches({ expectedStorageType: storageType });
      return (await storageService.getFile({ binaryObjectId: toBinaryObjectId({ raw: binaryObjectId }) })) ?? undefined;
    },
  };
}

function createRemoteChatSidebarItem({
  chatId,
  title,
  updatedAt,
  groupId,
}: {
  chatId: ChatId,
  title: string | null,
  updatedAt: number,
  groupId: ChatGroupId | null | undefined,
}): NaidanSysfsRemoteChatSidebarItem {
  return {
    id: `chat:${idToRaw({ id: chatId })}`,
    type: 'chat',
    chat: {
      id: idToRaw({ id: chatId }),
      title,
      updatedAt,
      groupId: groupId === undefined || groupId === null ? groupId : idToRaw({ id: groupId }),
    },
  };
}

function createRemoteChatGroupPayload({
  chatGroup,
}: {
  chatGroup: ChatGroup,
}): NaidanSysfsRemoteChatGroupPayload {
  return naidanSysfsRemoteChatGroupPayloadSchema.parse({
    dto: chatGroupToDto({ domain: redactSysfsConnectionSettings({ value: chatGroup }) }),
    items: chatGroup.items.map(item => createRemoteChatSidebarItem({
      chatId: item.chat.id,
      title: item.chat.title,
      updatedAt: item.chat.updatedAt,
      groupId: item.chat.groupId,
    })),
  });
}

function createRemoteSidebarItem({
  item,
}: {
  item: SidebarItem,
}): NaidanSysfsRemoteSidebarItem {
  switch (item.type) {
  case 'chat':
    return createRemoteChatSidebarItem({
      chatId: item.chat.id,
      title: item.chat.title,
      updatedAt: item.chat.updatedAt,
      groupId: item.chat.groupId,
    });
  case 'chat_group':
    return {
      id: item.id,
      type: 'chat_group',
      chatGroup: createRemoteChatGroupPayload({ chatGroup: item.chatGroup }),
    };
  default: {
    const _ex: never = item;
    throw new Error(`Unhandled sidebar item type: ${String(_ex)}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
