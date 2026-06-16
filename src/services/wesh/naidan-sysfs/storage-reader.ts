import {
  chatContentToDomain,
  chatContentToDto,
  chatGroupToDto,
  chatMetaToDomain,
  chatMetaToDto,
  hierarchyToDomain,
  lmParametersToDomain,
} from '@/models/mappers'
import type { ChatContentDto } from '@/models/dto'
import { idToRaw, toBinaryObjectId, toChatGroupId, toChatId } from '@/models/ids'
import type { BinaryObjectId, ChatGroupId, ChatId } from '@/models/ids'
import type { ChatGroup, SidebarItem } from '@/models/types'
import { storageService } from '@/services/storage'
import { OPFSStorageProvider } from '@/services/storage/opfs-storage'
import type { WeshMount } from '@/services/wesh/types'
import type { WeshWorkerMount } from '@/services/wesh/worker/types'
import {
  naidanSysfsRemoteBinaryObjectSchema,
  naidanSysfsRemoteChatContentPayloadSchema,
  naidanSysfsRemoteChatGroupPayloadSchema,
  naidanSysfsRemoteChatMetaPayloadSchema,
  naidanSysfsRemoteChatSummarySchema,
  naidanSysfsRemoteSidebarItemSchema,
} from './remote-reader-schema'
import { createNaidanSysfsBinaryObject } from './binary-object-metadata'
import type {
  NaidanSysfsBinaryObject,
  NaidanSysfsRemoteChatGroupPayload,
  NaidanSysfsRemoteChatSidebarItem,
  NaidanSysfsRemoteReader,
  NaidanSysfsRemoteSidebarItem,
  NaidanSysfsStorageReader,
} from './types'

export function createNaidanSysfsRemoteReaderForMounts({
  mounts,
}: {
  mounts: Array<WeshMount | WeshWorkerMount>;
}): NaidanSysfsRemoteReader | undefined {
  for (const mount of mounts) {
    switch (mount.type) {
    case 'directory':
      continue
    case 'naidan_sysfs':
      switch (mount.storageType) {
      case 'local':
      case 'memory':
        return createNaidanSysfsRemoteReader({ storageType: mount.storageType })
      case 'opfs':
        continue
      default: {
        const _ex: never = mount.storageType
        throw new Error(`Unhandled naidan sysfs storage type: ${String(_ex)}`)
      }
      }
    default: {
      const _ex: never = mount
      throw new Error(`Unhandled wesh mount type: ${String(_ex)}`)
    }
    }
  }

  return undefined
}

function assertStorageTypeMatches({
  expectedStorageType,
}: {
  expectedStorageType: 'local' | 'memory';
}): void {
  const currentStorageType = storageService.getCurrentType()
  if (currentStorageType !== expectedStorageType) {
    throw new Error(`Naidan sysfs remote reader expected ${expectedStorageType} storage, received: ${currentStorageType}`)
  }
}

export async function createOpfsNaidanSysfsStorageReader(): Promise<NaidanSysfsStorageReader> {
  const provider = new OPFSStorageProvider()
  await provider.init()

  return {
    async loadHierarchy() {
      const dto = await provider.loadHierarchy()
      return dto ? hierarchyToDomain({ dto }) : { items: [] }
    },
    async getSidebarStructure() {
      return provider.getSidebarStructure()
    },
    async listChats() {
      return provider.listChats()
    },
    async listChatGroups() {
      return provider.listChatGroups()
    },
    async loadChatMeta({ chatId }: { chatId: ChatId }) {
      return (await provider.loadChatMeta({ id: chatId })) ?? undefined
    },
    async loadChatContent({ chatId }: { chatId: ChatId }) {
      return (await provider.loadChatContent({ id: chatId })) ?? undefined
    },
    async loadChat({ chatId }: { chatId: ChatId }) {
      return (await provider.loadChat({ id: chatId })) ?? undefined
    },
    async loadChatGroup({ chatGroupId }: { chatGroupId: ChatGroupId }) {
      return (await provider.loadChatGroup({ id: chatGroupId })) ?? undefined
    },
    async *listBinaryObjects() {
      for await (const object of provider.listBinaryObjects()) {
        yield createNaidanSysfsBinaryObject({ object: { ...object, id: idToRaw({ id: object.id }) } })
      }
    },
    async getBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }) {
      const object = await provider.getBinaryObject({ binaryObjectId })
      return object === null ? undefined : createNaidanSysfsBinaryObject({ object: { ...object, id: idToRaw({ id: object.id }) } })
    },
    async getBinaryObjectBlob({ binaryObjectId }: { binaryObjectId: BinaryObjectId }) {
      return (await provider.getFile({ binaryObjectId })) ?? undefined
    },
  }
}

export function createNaidanSysfsRemoteReader({
  storageType,
}: {
  storageType: 'local' | 'memory';
}): NaidanSysfsRemoteReader {
  return {
    storageType,
    async getSidebarStructure() {
      assertStorageTypeMatches({ expectedStorageType: storageType })
      return naidanSysfsRemoteSidebarItemSchema.array().parse(
        (await storageService.getSidebarStructure()).map(item => createRemoteSidebarItem({ item })),
      )
    },
    async listChats() {
      assertStorageTypeMatches({ expectedStorageType: storageType })
      return naidanSysfsRemoteChatSummarySchema.array().parse((await storageService.listChats()).map(chat => ({
        ...chat,
        id: idToRaw({ id: chat.id }),
        groupId: chat.groupId === undefined || chat.groupId === null ? chat.groupId : idToRaw({ id: chat.groupId }),
      })))
    },
    async listChatGroups() {
      assertStorageTypeMatches({ expectedStorageType: storageType })
      return naidanSysfsRemoteChatGroupPayloadSchema.array().parse(
        (await storageService.listChatGroups()).map(chatGroup => createRemoteChatGroupPayload({ chatGroup })),
      )
    },
    async loadChatMeta({ chatId }: { chatId: string }) {
      assertStorageTypeMatches({ expectedStorageType: storageType })
      const metadata = await storageService.loadChatMeta({ id: toChatId({ raw: chatId }) })
      if (metadata === null) {
        return undefined
      }
      return naidanSysfsRemoteChatMetaPayloadSchema.parse({
        dto: chatMetaToDto({ domain: metadata }),
        groupId: metadata.groupId === undefined || metadata.groupId === null ? metadata.groupId : idToRaw({ id: metadata.groupId }),
      })
    },
    async loadChatContent({ chatId }: { chatId: string }) {
      assertStorageTypeMatches({ expectedStorageType: storageType })
      const content = await storageService.loadChatContent({ id: toChatId({ raw: chatId }) })
      if (content === null) {
        return undefined
      }
      return naidanSysfsRemoteChatContentPayloadSchema.parse(chatContentToDto({ domain: content }))
    },
    async loadChatGroup({ chatGroupId }: { chatGroupId: string }) {
      assertStorageTypeMatches({ expectedStorageType: storageType })
      const chatGroup = await storageService.loadChatGroup({ id: toChatGroupId({ raw: chatGroupId }) })
      if (chatGroup === null) {
        return undefined
      }
      return naidanSysfsRemoteChatGroupPayloadSchema.parse(createRemoteChatGroupPayload({ chatGroup }))
    },
    async listBinaryObjects() {
      assertStorageTypeMatches({ expectedStorageType: storageType })
      const objects: NaidanSysfsBinaryObject[] = []
      for await (const object of storageService.listBinaryObjects()) {
        objects.push(naidanSysfsRemoteBinaryObjectSchema.parse(createNaidanSysfsBinaryObject({
          object: {
            ...object,
            id: idToRaw({ id: object.id }),
          },
        })))
      }
      return objects
    },
    async getBinaryObject({ binaryObjectId }: { binaryObjectId: string }) {
      assertStorageTypeMatches({ expectedStorageType: storageType })
      const object = await storageService.getBinaryObject({ binaryObjectId: toBinaryObjectId({ raw: binaryObjectId }) })
      if (object === null) {
        return undefined
      }
      return naidanSysfsRemoteBinaryObjectSchema.parse(createNaidanSysfsBinaryObject({
        object: {
          ...object,
          id: idToRaw({ id: object.id }),
        },
      }))
    },
    async getBinaryObjectBlob({ binaryObjectId }: { binaryObjectId: string }) {
      assertStorageTypeMatches({ expectedStorageType: storageType })
      return (await storageService.getFile({ binaryObjectId: toBinaryObjectId({ raw: binaryObjectId }) })) ?? undefined
    },
  }
}

function createRemoteChatSidebarItem({
  chatId,
  title,
  updatedAt,
  groupId,
}: {
  chatId: ChatId;
  title: string | null;
  updatedAt: number;
  groupId: ChatGroupId | null | undefined;
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
  }
}

function createRemoteChatGroupPayload({
  chatGroup,
}: {
  chatGroup: ChatGroup;
}): NaidanSysfsRemoteChatGroupPayload {
  return {
    dto: chatGroupToDto({ domain: chatGroup }),
    items: chatGroup.items.map(item => createRemoteChatSidebarItem({
      chatId: item.chat.id,
      title: item.chat.title,
      updatedAt: item.chat.updatedAt,
      groupId: item.chat.groupId,
    })),
  }
}

function createRemoteSidebarItem({
  item,
}: {
  item: SidebarItem;
}): NaidanSysfsRemoteSidebarItem {
  switch (item.type) {
  case 'chat':
    return createRemoteChatSidebarItem({
      chatId: item.chat.id,
      title: item.chat.title,
      updatedAt: item.chat.updatedAt,
      groupId: item.chat.groupId,
    })
  case 'chat_group':
    return {
      id: item.id,
      type: 'chat_group',
      chatGroup: createRemoteChatGroupPayload({ chatGroup: item.chatGroup }),
    }
  default: {
    const _ex: never = item
    throw new Error(`Unhandled sidebar item type: ${String(_ex)}`)
  }
  }
}

function remoteChatGroupPayloadToDomain({
  payload,
}: {
  payload: NaidanSysfsRemoteChatGroupPayload;
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
      autoTitleEnabled: payload.dto.autoTitleEnabled,
      titleModelId: payload.dto.titleModelId,
      currentLeafId: undefined,
      originChatId: undefined,
      originMessageId: undefined,
      systemPrompt: payload.dto.systemPrompt,
      lmParameters: payload.dto.lmParameters,
      mounts: payload.dto.mounts,
    },
  })

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
    autoTitleEnabled: payload.dto.autoTitleEnabled,
    titleModelId: payload.dto.titleModelId,
    systemPrompt: metadata.systemPrompt,
    lmParameters: lmParametersToDomain({ dto: payload.dto.lmParameters }),
    mounts: metadata.mounts,
  }
}

async function loadRemoteChatMeta({
  remoteReader,
  chatId,
}: {
  remoteReader: NaidanSysfsRemoteReader;
  chatId: string;
}) {
  const payload = await remoteReader.loadChatMeta({ chatId })
  if (payload === undefined) {
    return undefined
  }
  const metadata = chatMetaToDomain({ dto: naidanSysfsRemoteChatMetaPayloadSchema.parse(payload).dto })
  metadata.groupId = payload.groupId === undefined || payload.groupId === null ? payload.groupId : toChatGroupId({ raw: payload.groupId })
  return metadata
}

async function loadRemoteChatContent({
  remoteReader,
  chatId,
}: {
  remoteReader: NaidanSysfsRemoteReader;
  chatId: string;
}) {
  const payload = await remoteReader.loadChatContent({ chatId })
  if (payload === undefined) {
    return undefined
  }
  return chatContentToDomain({
    dto: naidanSysfsRemoteChatContentPayloadSchema.parse(payload) as ChatContentDto,
  })
}

export function createRemoteNaidanSysfsStorageReader({
  remoteReader,
}: {
  remoteReader: NaidanSysfsRemoteReader;
}): NaidanSysfsStorageReader {
  return {
    async loadHierarchy() {
      const items = naidanSysfsRemoteSidebarItemSchema.array().parse(await remoteReader.getSidebarStructure())
      const chatGroupItems = items.filter(
        (item): item is Extract<typeof item, { type: 'chat_group' }> => item.type === 'chat_group',
      )
      const chatItems = items.filter(
        (item): item is Extract<typeof item, { type: 'chat' }> => item.type === 'chat',
      )
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
      }
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
          }
        case 'chat_group':
          return {
            id: item.id,
            type: 'chat_group',
            chatGroup: remoteChatGroupPayloadToDomain({ payload: item.chatGroup }),
          }
        default: {
          const _ex: never = item
          throw new Error(`Unhandled remote sidebar item type: ${String(_ex)}`)
        }
        }
      })
    },
    async listChats() {
      return naidanSysfsRemoteChatSummarySchema.array().parse(await remoteReader.listChats()).map(chat => ({
        id: toChatId({ raw: chat.id }),
        title: chat.title,
        updatedAt: chat.updatedAt,
        groupId: chat.groupId === undefined || chat.groupId === null ? chat.groupId : toChatGroupId({ raw: chat.groupId }),
      }))
    },
    async listChatGroups() {
      return naidanSysfsRemoteChatGroupPayloadSchema.array().parse(await remoteReader.listChatGroups()).map(payload =>
        remoteChatGroupPayloadToDomain({ payload }),
      )
    },
    async loadChatMeta({ chatId }: { chatId: ChatId }) {
      return loadRemoteChatMeta({ remoteReader, chatId: idToRaw({ id: chatId }) })
    },
    async loadChatContent({ chatId }: { chatId: ChatId }) {
      return loadRemoteChatContent({ remoteReader, chatId: idToRaw({ id: chatId }) })
    },
    async loadChat({ chatId }: { chatId: ChatId }) {
      const [metadata, content] = await Promise.all([
        loadRemoteChatMeta({ remoteReader, chatId: idToRaw({ id: chatId }) }),
        loadRemoteChatContent({ remoteReader, chatId: idToRaw({ id: chatId }) }),
      ])
      if (metadata === undefined || content === undefined) {
        return undefined
      }
      return {
        ...metadata,
        root: content.root,
        currentLeafId: content.currentLeafId ?? metadata.currentLeafId,
      }
    },
    async loadChatGroup({ chatGroupId }: { chatGroupId: ChatGroupId }) {
      const chatGroup = await remoteReader.loadChatGroup({ chatGroupId: idToRaw({ id: chatGroupId }) })
      if (chatGroup === undefined) {
        return undefined
      }
      return remoteChatGroupPayloadToDomain({
        payload: naidanSysfsRemoteChatGroupPayloadSchema.parse(chatGroup),
      })
    },
    async *listBinaryObjects() {
      const objects = await remoteReader.listBinaryObjects()
      for (const object of objects) {
        yield naidanSysfsRemoteBinaryObjectSchema.parse(object)
      }
    },
    async getBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }) {
      const object = await remoteReader.getBinaryObject({ binaryObjectId: idToRaw({ id: binaryObjectId }) })
      if (object === undefined) {
        return undefined
      }
      return naidanSysfsRemoteBinaryObjectSchema.parse(object)
    },
    async getBinaryObjectBlob({ binaryObjectId }: { binaryObjectId: BinaryObjectId }) {
      return await remoteReader.getBinaryObjectBlob({ binaryObjectId: idToRaw({ id: binaryObjectId }) })
    },
  }
}
