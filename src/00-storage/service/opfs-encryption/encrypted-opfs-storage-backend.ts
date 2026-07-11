import { generateId } from '@/01-models/id';
import {
  idToRaw,
  toBinaryObjectId,
  toChatGroupId,
  toChatId,
} from '@/01-models/ids';
import type {
  BinaryObjectId,
  ChatGroupId,
  ChatId,
  VolumeId,
} from '@/01-models/ids';
import type {
  BinaryObject,
  Chat,
  ChatContent,
  ChatGroup,
  ChatMeta,
  MessageNode,
  Settings,
  SidebarItem,
  StorageSnapshot,
  Volume,
  VolumeType,
} from '@/01-models/types';
import {
  BinaryShardIndexSchemaDto,
  ChatContentSchemaDto,
  ChatGroupSchemaDto,
  ChatMetaSchemaDto,
  HierarchySchemaDto,
  SettingsSchemaDto,
  VolumeIndexSchemaDto,
  type BinaryShardIndexDto,
  type ChatGroupDto,
  type ChatMetaDto,
  type HierarchyDto,
  type MigrationChunkDto,
  type StorageBinaryObjectWriteSource,
  type VolumeDto,
  type VolumeIndexDto,
} from '@/00-storage/00-dto/dto';
import {
  EncryptedChatGroupShardIndexSchemaDto,
  EncryptedChatMetaShardIndexSchemaDto,
  EncryptedStoreManifestSchemaDto,
  type EncryptedChatGroupShardIndexDto,
  type EncryptedChatMetaShardIndexDto,
  type EncryptedStoreManifestDto,
} from '@/00-storage/00-dto/encryption.dto';
import {
  binaryObjectToDomain,
  buildSidebarItemsFromHierarchy,
  chatContentToDomain,
  chatContentToDto,
  chatGroupToDomain,
  chatGroupToDto,
  chatMetaToDomain,
  chatMetaToDto,
  chatToDomain,
  chatToDto,
  hierarchyToDomain,
  hierarchyToDto,
  settingsToDomain,
  settingsToDto,
  volumeToDomain,
  volumeToDto,
} from '@/00-storage/mapper/mappers';
import { promiseAllKeyed } from '@/utils/promise';
import { IStorageProvider } from '@/00-storage/service/interface';
import type { StorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';
import type { StorageVolumeAccess } from '@/00-storage/service/volume-access';
import { HostVolumeDB } from '@/00-storage/service/opfs/host-volume-db';
import type { OpfsSpecialFileSystemType } from '@/00-storage/service/opfs/opfs-transition-backend';
import { openStorageBinaryObjectWriteSourceStream } from '@/00-storage/service/binary-object-io';
import {
  copyStorageDirectory,
  createStorageDirectoryTransferSource,
} from '@/00-storage/service/storage-directory-transfer';
import { EncryptedObjectStore } from './encrypted-object-store';
import { EncryptedJsonObjectStore } from './encrypted-json-object-store';
import { EncryptedFileStore } from './encrypted-file-store';
import { EncryptedFileSystemStore } from './encrypted-file-system-store';
import { createEncryptedStorageDirectoryTransferTarget } from './encrypted-storage-directory-transfer';
import type { EncryptedStoreRuntimeKeys } from './types';

const EMPTY_MANIFEST: EncryptedStoreManifestDto = {
  chatMetaShardIds: [],
  chatGroupShardIds: [],
  binaryObjectShardIds: [],
  volumeShardIds: [],
  fileSystems: [],
};

function getLogicalShard({ id }: { id: string }): string {
  return id.slice(-2).toLowerCase();
}

function assertShardIds({
  shardIds,
  fieldName,
}: {
  shardIds: string[],
  fieldName: string,
}): void {
  const seenShardIds = new Set<string>();
  for (const shardId of shardIds) {
    if (seenShardIds.has(shardId)) {
      throw new Error(`${fieldName} contains a duplicate shard ID: ${shardId}`);
    }
    seenShardIds.add(shardId);
  }
}

function assertEncryptedStoreManifest({
  manifest,
}: {
  manifest: EncryptedStoreManifestDto,
}): void {
  assertShardIds({ shardIds: manifest.chatMetaShardIds, fieldName: 'Chat metadata shards' });
  assertShardIds({ shardIds: manifest.chatGroupShardIds, fieldName: 'Chat group shards' });
  assertShardIds({ shardIds: manifest.binaryObjectShardIds, fieldName: 'Binary object shards' });
  assertShardIds({ shardIds: manifest.volumeShardIds, fieldName: 'Volume shards' });

  const seenIds = new Set<string>();
  const seenRootDirectoryIds = new Set<string>();
  const seenVolumeIds = new Set<string>();
  const seenSpecialTypes = new Set<'chat_wesh' | 'debug_wesh' | 'tmp'>();
  for (const fileSystem of manifest.fileSystems) {
    if (fileSystem.id.length === 0 || fileSystem.rootDirectoryId.length === 0) {
      throw new Error('Encrypted store filesystem IDs must not be empty');
    }
    if (seenIds.has(fileSystem.id)) {
      throw new Error(`Encrypted store manifest contains a duplicate filesystem ID: ${fileSystem.id}`);
    }
    seenIds.add(fileSystem.id);
    if (seenRootDirectoryIds.has(fileSystem.rootDirectoryId)) {
      throw new Error(`Encrypted store manifest contains a duplicate root directory ID: ${fileSystem.rootDirectoryId}`);
    }
    seenRootDirectoryIds.add(fileSystem.rootDirectoryId);

    switch (fileSystem.type) {
    case 'opfs_volume':
      if (seenVolumeIds.has(fileSystem.sourceId)) {
        throw new Error(`Encrypted store manifest contains a duplicate OPFS volume source ID: ${fileSystem.sourceId}`);
      }
      seenVolumeIds.add(fileSystem.sourceId);
      break;
    case 'chat_wesh':
    case 'debug_wesh':
    case 'tmp':
      if (seenSpecialTypes.has(fileSystem.type)) {
        throw new Error(`Encrypted store manifest contains a duplicate special filesystem: ${fileSystem.type}`);
      }
      seenSpecialTypes.add(fileSystem.type);
      break;
    default: {
      const _ex: never = fileSystem;
      throw new Error(`Unhandled encrypted filesystem manifest entry: ${String(_ex)}`);
    }
    }
  }
}

function assertLogicalIdsForShard({
  ids,
  shard,
  fieldName,
}: {
  ids: string[],
  shard: string,
  fieldName: string,
}): void {
  const seenIds = new Set<string>();
  for (const id of ids) {
    if (getLogicalShard({ id }) !== shard) {
      throw new Error(`${fieldName} contains an ID outside shard ${shard}: ${JSON.stringify(id)}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`${fieldName} contains a duplicate ID: ${id}`);
    }
    seenIds.add(id);
  }
}

function assertBinaryShardIndex({
  index,
  shard,
}: {
  index: BinaryShardIndexDto,
  shard: string,
}): void {
  for (const [id, object] of Object.entries(index.objects)) {
    if (object.id !== id || getLogicalShard({ id }) !== shard) {
      throw new Error(`Binary object index entry does not belong to shard ${shard}: ${JSON.stringify(id)}`);
    }
  }
}

function assertVolumeShardIndex({
  index,
  shard,
}: {
  index: VolumeIndexDto,
  shard: string,
}): void {
  for (const [id, volume] of Object.entries(index.volumes)) {
    if (volume.id !== id || getLogicalShard({ id }) !== shard) {
      throw new Error(`Volume index entry does not belong to shard ${shard}: ${JSON.stringify(id)}`);
    }
  }
}

export class EncryptedOPFSStorageBackend extends IStorageProvider {
  constructor({
    storeDirectory,
    keys,
  }: {
    storeDirectory: FileSystemDirectoryHandle,
    keys: EncryptedStoreRuntimeKeys,
  }) {
    super();
    this.storeDirectory = storeDirectory;
    this.keys = keys;
    this.objectStore = new EncryptedObjectStore({ storeDirectory, keys });
    this.jsonStore = new EncryptedJsonObjectStore({ objectStore: this.objectStore });
    this.fileStore = new EncryptedFileStore({ objectStore: this.objectStore });
    this.fileSystemStore = new EncryptedFileSystemStore({
      objectStore: this.objectStore,
      fileStore: this.fileStore,
    });
  }

  readonly canPersistBinary = true;
  private readonly storeDirectory: FileSystemDirectoryHandle;
  private readonly keys: EncryptedStoreRuntimeKeys;
  private readonly objectStore: EncryptedObjectStore;
  private readonly jsonStore: EncryptedJsonObjectStore;
  private readonly fileStore: EncryptedFileStore;
  private readonly fileSystemStore: EncryptedFileSystemStore;
  private readonly hostVolumeDB = new HostVolumeDB();

  async init(): Promise<void> {
    if (await this.loadManifest() === undefined) {
      throw new Error('Encrypted store manifest is missing');
    }
  }

  async initializeNewStore(): Promise<void> {
    if (await this.loadManifest() !== undefined) {
      throw new Error('Encrypted store manifest already exists');
    }
    await this.saveManifest({ manifest: structuredClone(EMPTY_MANIFEST) });
  }

  async listChatMetasRaw(): Promise<ChatMetaDto[]> {
    const manifest = await this.loadManifest() ?? EMPTY_MANIFEST;
    const hierarchy = await this.loadHierarchy() ?? { items: [] };
    const chatIds = new Set<string>();
    for (const shard of manifest.chatMetaShardIds) {
      const index = await this.loadChatMetaShard({ shard });
      for (const chatId of index.chatIds) {
        chatIds.add(chatId);
      }
    }
    for (const item of hierarchy.items) {
      switch (item.type) {
      case 'chat':
        chatIds.add(item.id);
        break;
      case 'chat_group':
        for (const chatId of item.chat_ids) {
          chatIds.add(chatId);
        }
        break;
      default: {
        const _ex: never = item;
        throw new Error(`Unhandled hierarchy item type: ${String(_ex)}`);
      }
      }
    }

    const result: ChatMetaDto[] = [];
    for (const chatId of chatIds) {
      const dto = await this.jsonStore.read({
        locator: { namespace: 'chat_meta', key: chatId },
        schema: ChatMetaSchemaDto,
      });
      if (dto !== undefined) {
        result.push(dto);
      }
    }
    return result;
  }

  async listChatGroupsRaw(): Promise<ChatGroupDto[]> {
    const manifest = await this.loadManifest() ?? EMPTY_MANIFEST;
    const hierarchy = await this.loadHierarchy() ?? { items: [] };
    const chatGroupIds = new Set<string>();
    for (const shard of manifest.chatGroupShardIds) {
      const index = await this.loadChatGroupShard({ shard });
      for (const chatGroupId of index.chatGroupIds) {
        chatGroupIds.add(chatGroupId);
      }
    }
    for (const item of hierarchy.items) {
      switch (item.type) {
      case 'chat':
        continue;
      case 'chat_group':
        chatGroupIds.add(item.id);
        break;
      default: {
        const _ex: never = item;
        throw new Error(`Unhandled hierarchy item: ${((_ex satisfies never) as { readonly type: string }).type}`);
      }
      }
    }
    const result: ChatGroupDto[] = [];
    for (const chatGroupId of chatGroupIds) {
      const dto = await this.jsonStore.read({
        locator: { namespace: 'chat_group', key: chatGroupId },
        schema: ChatGroupSchemaDto,
      });
      if (dto !== undefined) {
        result.push(dto);
      }
    }
    return result;
  }

  async loadHierarchy(): Promise<HierarchyDto | null> {
    return await this.jsonStore.read({
      locator: { namespace: 'singleton', key: 'hierarchy' },
      schema: HierarchySchemaDto,
    }) ?? { items: [] };
  }

  async saveHierarchy({ hierarchy }: { hierarchy: HierarchyDto }): Promise<void> {
    await this.jsonStore.write({
      locator: { namespace: 'singleton', key: 'hierarchy' },
      value: hierarchy,
    });
  }

  async saveChatMeta({ meta }: { meta: ChatMeta }): Promise<void> {
    const rawId = idToRaw({ id: meta.id });
    await this.jsonStore.write({
      locator: { namespace: 'chat_meta', key: rawId },
      value: chatMetaToDto({ domain: meta }),
    });
    const shard = this.getShard({ id: rawId });
    const index = await this.loadChatMetaShard({ shard });
    if (!index.chatIds.includes(rawId)) {
      index.chatIds.push(rawId);
      index.chatIds.sort();
      await this.saveChatMetaShard({ shard, index });
      await this.addManifestShard({ type: 'chat_meta', shard });
    }
  }

  async saveChatContent({ id, content }: { id: ChatId, content: ChatContent }): Promise<void> {
    await this.jsonStore.write({
      locator: { namespace: 'chat_content', key: idToRaw({ id }) },
      value: chatContentToDto({ domain: content }),
    });
  }

  async loadChat({ id }: { id: ChatId }): Promise<Chat | null> {
    const rawId = idToRaw({ id });
    const { meta, content } = await promiseAllKeyed({
      meta: this.jsonStore.read({
        locator: { namespace: 'chat_meta', key: rawId },
        schema: ChatMetaSchemaDto,
      }),
      content: this.jsonStore.read({
        locator: { namespace: 'chat_content', key: rawId },
        schema: ChatContentSchemaDto,
      }),
    });
    if (meta === undefined || content === undefined) {
      return null;
    }
    const chat = chatToDomain({
      dto: {
        ...meta,
        ...content,
        experimental: meta.experimental,
        messages: undefined,
      },
    });
    await this.hydrateAttachments({ nodes: chat.root.items });
    return chat;
  }

  async loadChatMeta({ id }: { id: ChatId }): Promise<ChatMeta | null> {
    const dto = await this.jsonStore.read({
      locator: { namespace: 'chat_meta', key: idToRaw({ id }) },
      schema: ChatMetaSchemaDto,
    });
    if (dto === undefined) {
      return null;
    }
    const meta = chatMetaToDomain({ dto });
    const hierarchy = await this.loadHierarchy();
    for (const item of hierarchy?.items ?? []) {
      if (item.type === 'chat_group' && item.chat_ids.includes(idToRaw({ id }))) {
        meta.groupId = toChatGroupId({ raw: item.id });
        break;
      }
    }
    return meta;
  }

  async loadChatContent({ id }: { id: ChatId }): Promise<ChatContent | null> {
    const content = await this.loadChatContentWithoutAttachments({ id });
    if (content === null) {
      return null;
    }
    await this.hydrateAttachments({ nodes: content.root.items });
    return content;
  }

  async loadChatContentWithoutAttachments({ id }: { id: ChatId }): Promise<ChatContent | null> {
    const dto = await this.jsonStore.read({
      locator: { namespace: 'chat_content', key: idToRaw({ id }) },
      schema: ChatContentSchemaDto,
    });
    return dto === undefined ? null : chatContentToDomain({ dto });
  }

  async deleteChat({ id }: { id: ChatId }): Promise<void> {
    const rawId = idToRaw({ id });
    const shard = this.getShard({ id: rawId });
    const index = await this.loadChatMetaShard({ shard });
    if (index.chatIds.includes(rawId)) {
      index.chatIds = index.chatIds.filter(chatId => chatId !== rawId);
      await this.saveChatMetaShard({ shard, index });
    }
    await Promise.all([
      this.jsonStore.delete({ locator: { namespace: 'chat_meta', key: rawId } }),
      this.jsonStore.delete({ locator: { namespace: 'chat_content', key: rawId } }),
    ]);
  }

  async saveChatGroup({ chatGroup }: { chatGroup: ChatGroup }): Promise<void> {
    const rawId = idToRaw({ id: chatGroup.id });
    await this.jsonStore.write({
      locator: { namespace: 'chat_group', key: rawId },
      value: chatGroupToDto({ domain: chatGroup }),
    });
    const shard = this.getShard({ id: rawId });
    const index = await this.loadChatGroupShard({ shard });
    if (!index.chatGroupIds.includes(rawId)) {
      index.chatGroupIds.push(rawId);
      index.chatGroupIds.sort();
      await this.saveChatGroupShard({ shard, index });
      await this.addManifestShard({ type: 'chat_group', shard });
    }
  }

  async loadChatGroup({ id }: { id: ChatGroupId }): Promise<ChatGroup | null> {
    const dto = await this.jsonStore.read({
      locator: { namespace: 'chat_group', key: idToRaw({ id }) },
      schema: ChatGroupSchemaDto,
    });
    if (dto === undefined) {
      return null;
    }
    const { hierarchy, chatMetas } = await promiseAllKeyed({
      hierarchy: this.loadHierarchy(),
      chatMetas: this.listChatMetasRaw(),
    });
    return chatGroupToDomain({
      dto,
      hierarchy: hierarchyToDomain({ dto: hierarchy ?? { items: [] } }),
      chatMetas: chatMetas.map(meta => chatMetaToDomain({ dto: meta })),
    });
  }

  async deleteChatGroup({ id }: { id: ChatGroupId }): Promise<void> {
    const rawId = idToRaw({ id });
    const shard = this.getShard({ id: rawId });
    const index = await this.loadChatGroupShard({ shard });
    if (index.chatGroupIds.includes(rawId)) {
      index.chatGroupIds = index.chatGroupIds.filter(chatGroupId => chatGroupId !== rawId);
      await this.saveChatGroupShard({ shard, index });
    }
    await this.jsonStore.delete({
      locator: { namespace: 'chat_group', key: rawId },
    });
  }

  async getSidebarStructure(): Promise<SidebarItem[]> {
    const { rawHierarchy, rawMetas, rawGroups } = await promiseAllKeyed({
      rawHierarchy: this.loadHierarchy(),
      rawMetas: this.listChatMetasRaw(),
      rawGroups: this.listChatGroupsRaw(),
    });
    const hierarchy = hierarchyToDomain({ dto: rawHierarchy ?? { items: [] } });
    const chatMetas = rawMetas.map(dto => chatMetaToDomain({ dto }));
    const chatGroups = rawGroups.map(dto => chatGroupToDomain({ dto, hierarchy, chatMetas }));
    return buildSidebarItemsFromHierarchy({ hierarchy, chatMetas, chatGroups });
  }

  async saveSettings({ settings }: { settings: Settings }): Promise<void> {
    await this.jsonStore.write({
      locator: { namespace: 'singleton', key: 'settings' },
      value: settingsToDto({ domain: settings }),
    });
  }

  async loadSettings(): Promise<Settings | null> {
    const dto = await this.jsonStore.read({
      locator: { namespace: 'singleton', key: 'settings' },
      schema: SettingsSchemaDto,
    });
    return dto === undefined ? null : settingsToDomain({ dto });
  }

  async writeBinaryObject({ source, binaryObjectId, name, mimeType, size, createdAt, signal }: {
    source: StorageBinaryObjectWriteSource,
    binaryObjectId: BinaryObjectId,
    name: string,
    mimeType: string,
    size: number,
    createdAt: number,
    signal: AbortSignal | undefined,
  }): Promise<void> {
    const rawId = idToRaw({ id: binaryObjectId });
    await this.fileStore.write({
      fileId: `binary/${rawId}`,
      source: openStorageBinaryObjectWriteSourceStream({ source }),
      logicalSize: size,
      modifiedAt: createdAt,
      signal,
    });
    const shard = this.getShard({ id: rawId });
    const index = await this.loadBinaryShard({ shard });
    index.objects[rawId] = {
      id: rawId,
      mimeType,
      size,
      createdAt,
      name,
    };
    await this.saveBinaryShard({ shard, index });
    await this.addManifestShard({ type: 'binary_object', shard });
  }

  async openBinaryObject({ binaryObjectId }: {
    binaryObjectId: BinaryObjectId,
  }): Promise<StorageBinaryObjectReadHandle | null> {
    const rawId = idToRaw({ id: binaryObjectId });
    const metadata = await this.getBinaryObject({ binaryObjectId });
    if (metadata === null) {
      return null;
    }
    return await this.fileStore.open({
      fileId: `binary/${rawId}`,
      mimeType: metadata.mimeType,
    });
  }

  async getBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<BinaryObject | null> {
    const rawId = idToRaw({ id: binaryObjectId });
    const index = await this.loadBinaryShard({ shard: this.getShard({ id: rawId }) });
    const dto = index.objects[rawId];
    return dto === undefined ? null : binaryObjectToDomain({ dto });
  }

  async hasAttachments(): Promise<boolean> {
    const manifest = await this.loadManifest() ?? EMPTY_MANIFEST;
    for (const shard of manifest.binaryObjectShardIds) {
      const index = await this.loadBinaryShard({ shard });
      if (Object.keys(index.objects).length > 0) {
        return true;
      }
    }
    return false;
  }

  async *listBinaryObjects(): AsyncIterable<BinaryObject> {
    const manifest = await this.loadManifest() ?? EMPTY_MANIFEST;
    for (const shard of manifest.binaryObjectShardIds) {
      const index = await this.loadBinaryShard({ shard });
      for (const dto of Object.values(index.objects)) {
        yield binaryObjectToDomain({ dto });
      }
    }
  }

  async deleteBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<void> {
    const rawId = idToRaw({ id: binaryObjectId });
    const shard = this.getShard({ id: rawId });
    const index = await this.loadBinaryShard({ shard });
    delete index.objects[rawId];
    await this.saveBinaryShard({ shard, index });
    await this.fileStore.delete({ fileId: `binary/${rawId}` });
  }

  async clearAll(): Promise<void> {
    throw new Error('Encrypted storage must be cleared through the encryption transition coordinator');
  }

  async dump(): Promise<StorageSnapshot> {
    const { settings, hierarchy, rawMetas, rawGroups } = await promiseAllKeyed({
      settings: this.loadSettings(),
      hierarchy: this.loadHierarchy(),
      rawMetas: this.listChatMetasRaw(),
      rawGroups: this.listChatGroupsRaw(),
    });
    const hierarchyDomain = hierarchyToDomain({ dto: hierarchy ?? { items: [] } });
    const chatMetas = rawMetas.map(dto => chatMetaToDomain({ dto }));
    const chatGroups = rawGroups.map(dto => chatGroupToDomain({
      dto,
      hierarchy: hierarchyDomain,
      chatMetas,
    }));

    const contentStream = async function* (this: EncryptedOPFSStorageBackend): AsyncGenerator<MigrationChunkDto> {
      for (const meta of rawMetas) {
        const chat = await this.loadChat({ id: toChatId({ raw: meta.id }) });
        if (chat !== null) {
          yield { type: 'chat', data: chatToDto({ domain: chat }) };
        }
      }
      for await (const binaryObject of this.listBinaryObjects()) {
        const handle = await this.openBinaryObject({ binaryObjectId: binaryObject.id });
        if (handle === null) {
          continue;
        }
        try {
          yield {
            type: 'binary_object',
            id: idToRaw({ id: binaryObject.id }),
            name: binaryObject.name ?? 'file',
            mimeType: binaryObject.mimeType,
            size: binaryObject.size,
            createdAt: binaryObject.createdAt,
            source: {
              type: 'stream',
              stream: handle.stream({ start: 0, end: undefined, signal: undefined }),
            },
          };
        } finally {
          await handle.close();
        }
      }
    };

    return {
      structure: {
        settings: settings ?? {
          titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
          providerProfiles: [],
          mounts: [],
          storageType: 'opfs',
          endpoint: { type: 'openai', url: '', httpHeaders: undefined },
        },
        hierarchy: hierarchyDomain,
        chatMetas,
        chatGroups,
      },
      contentStream: contentStream.call(this),
    };
  }

  async restore({ snapshot }: { snapshot: StorageSnapshot }): Promise<void> {
    const { structure, contentStream } = snapshot;
    await this.saveSettings({ settings: structure.settings });
    await this.saveHierarchy({ hierarchy: hierarchyToDto({ domain: structure.hierarchy }) });
    for (const meta of structure.chatMetas) {
      await this.saveChatMeta({ meta });
    }
    for (const group of structure.chatGroups) {
      await this.saveChatGroup({ chatGroup: group });
    }
    for await (const chunk of contentStream) {
      switch (chunk.type) {
      case 'chat': {
        const chat = chatToDomain({ dto: chunk.data });
        await this.saveChatContent({ id: chat.id, content: chat });
        await this.saveChatMeta({ meta: chat });
        break;
      }
      case 'binary_object':
        await this.writeBinaryObject({
          source: chunk.source,
          binaryObjectId: toBinaryObjectId({ raw: chunk.id }),
          name: chunk.name,
          mimeType: chunk.mimeType,
          size: chunk.size,
          createdAt: chunk.createdAt,
          signal: undefined,
        });
        break;
      default: {
        const _ex: never = chunk;
        throw new Error(`Unhandled migration chunk: ${String(_ex)}`);
      }
      }
    }
  }

  async *listVolumes(): AsyncIterable<Volume> {
    const manifest = await this.loadManifest() ?? EMPTY_MANIFEST;
    for (const shard of manifest.volumeShardIds) {
      const index = await this.loadVolumeShard({ shard });
      for (const dto of Object.values(index.volumes)) {
        yield volumeToDomain({ dto });
      }
    }
  }

  async createVolume({
    name,
    type,
    sourceHandle,
  }: {
    name: string,
    type: VolumeType,
    sourceHandle: FileSystemDirectoryHandle,
  }): Promise<Volume> {
    const id = generateId<VolumeId>();
    const rawId = idToRaw({ id });
    const createdAt = Date.now();
    const shard = this.getShard({ id: rawId });
    let fileSystemRootId: string | undefined;

    try {
      let volumeDto: VolumeDto;
      switch (type) {
      case 'opfs': {
        fileSystemRootId = await this.fileSystemStore.createFileSystem();
        await this.fileSystemStore.importDirectory({
          rootDirectoryId: fileSystemRootId,
          source: sourceHandle,
          destinationPath: '/',
          signal: undefined,
        });
        volumeDto = {
          type: 'opfs',
          id: rawId,
          name,
          createdAt,
        };
        const manifest = await this.loadManifest() ?? structuredClone(EMPTY_MANIFEST);
        manifest.fileSystems.push({
          id: String(generateId()),
          type: 'opfs_volume',
          sourceId: rawId,
          rootDirectoryId: fileSystemRootId,
        });
        await this.saveManifest({ manifest });
        break;
      }
      case 'host':
        await this.hostVolumeDB.put({ id: rawId, handle: sourceHandle });
        volumeDto = {
          type: 'host',
          id: rawId,
          name,
          createdAt,
        };
        break;
      default: {
        const _ex: never = type;
        throw new Error(`Unhandled encrypted volume type: ${String(_ex)}`);
      }
      }

      const index = await this.loadVolumeShard({ shard });
      index.volumes[rawId] = volumeDto;
      await this.saveVolumeShard({ shard, index });
      await this.addManifestShard({ type: 'volume', shard });
      return volumeToDomain({ dto: volumeDto });
    } catch (error) {
      if (fileSystemRootId !== undefined) {
        const manifest = await this.loadManifest().catch(() => undefined);
        if (manifest !== undefined) {
          const nextFileSystems = manifest.fileSystems.filter(candidate => !(
            candidate.type === 'opfs_volume'
            && candidate.sourceId === rawId
            && candidate.rootDirectoryId === fileSystemRootId
          ));
          if (nextFileSystems.length !== manifest.fileSystems.length) {
            manifest.fileSystems = nextFileSystems;
            await this.saveManifest({ manifest }).catch(() => {});
          }
        }
        await this.fileSystemStore.deleteFileSystem({
          rootDirectoryId: fileSystemRootId,
        }).catch(() => {});
      }
      switch (type) {
      case 'host':
        await this.hostVolumeDB.delete({ id: rawId }).catch(() => {});
        break;
      case 'opfs':
        break;
      default: {
        const _ex: never = type;
        throw new Error(`Unhandled volume type: ${String(_ex)}`);
      }
      }
      throw error;
    }
  }

  async createVolumeFromFiles({
    name,
    entries,
    onProgress,
    signal,
  }: {
    name: string,
    entries: Array<{ file: File, relativePath: string }>,
    onProgress?: ({ processed, total }: { processed: number, total: number }) => void,
    signal?: AbortSignal,
  }): Promise<Volume> {
    const id = generateId<VolumeId>();
    const rawId = idToRaw({ id });
    const createdAt = Date.now();
    const shard = this.getShard({ id: rawId });
    const rootDirectoryId = await this.fileSystemStore.createFileSystem();

    try {
      for (const [index, entry] of entries.entries()) {
        signal?.throwIfAborted();
        const pathParts = entry.relativePath.split('/').filter(Boolean);
        const fileName = pathParts.pop();
        if (fileName === undefined) {
          throw new Error(`Volume import path has no filename: ${entry.relativePath}`);
        }
        const parentPath = `/${pathParts.join('/')}`;
        await this.fileSystemStore.createDirectory({
          rootDirectoryId,
          path: parentPath,
          recursive: true,
        });
        await this.fileSystemStore.writeFile({
          rootDirectoryId,
          path: `${parentPath}/${fileName}`,
          source: entry.file.stream(),
          logicalSize: entry.file.size,
          modifiedAt: entry.file.lastModified,
          signal,
        });
        onProgress?.({ processed: index + 1, total: entries.length });
      }

      const volumeDto: VolumeDto = {
        type: 'opfs',
        id: rawId,
        name,
        createdAt,
      };
      const manifest = await this.loadManifest() ?? structuredClone(EMPTY_MANIFEST);
      manifest.fileSystems.push({
        id: String(generateId()),
        type: 'opfs_volume',
        sourceId: rawId,
        rootDirectoryId,
      });
      await this.saveManifest({ manifest });
      const index = await this.loadVolumeShard({ shard });
      index.volumes[rawId] = volumeDto;
      await this.saveVolumeShard({ shard, index });
      await this.addManifestShard({ type: 'volume', shard });
      return volumeToDomain({ dto: volumeDto });
    } catch (error) {
      const manifest = await this.loadManifest().catch(() => undefined);
      if (manifest !== undefined) {
        const nextFileSystems = manifest.fileSystems.filter(candidate => !(
          candidate.type === 'opfs_volume'
          && candidate.sourceId === rawId
          && candidate.rootDirectoryId === rootDirectoryId
        ));
        if (nextFileSystems.length !== manifest.fileSystems.length) {
          manifest.fileSystems = nextFileSystems;
          await this.saveManifest({ manifest }).catch(() => {});
        }
      }
      await this.fileSystemStore.deleteFileSystem({ rootDirectoryId }).catch(() => {});
      throw error;
    }
  }

  async openVolume({
    volumeId,
  }: {
    volumeId: VolumeId,
  }): Promise<StorageVolumeAccess | null> {
    const rawId = idToRaw({ id: volumeId });
    const index = await this.loadVolumeShard({ shard: this.getShard({ id: rawId }) });
    const volume = index.volumes[rawId];
    if (volume === undefined) {
      return null;
    }
    switch (volume.type) {
    case 'host': {
      const handle = await this.hostVolumeDB.get({ id: rawId });
      return handle === undefined
        ? null
        : { type: 'direct_directory', handle };
    }
    case 'opfs': {
      const fileSystem = await this.getVolumeFileSystem({ volumeId: rawId });
      if (fileSystem === undefined) {
        throw new Error(`Encrypted volume filesystem is missing: ${rawId}`);
      }
      return this.createEncryptedDirectoryAccess({
        rootDirectoryId: fileSystem.rootDirectoryId,
      });
    }
    default: {
      const _ex: never = volume;
      throw new Error(`Unhandled encrypted volume: ${String(_ex)}`);
    }
    }
  }

  async deleteVolume({ volumeId }: { volumeId: VolumeId }): Promise<void> {
    const rawId = idToRaw({ id: volumeId });
    const shard = this.getShard({ id: rawId });
    const index = await this.loadVolumeShard({ shard });
    const volume = index.volumes[rawId];
    if (volume === undefined) {
      return;
    }

    delete index.volumes[rawId];
    await this.saveVolumeShard({ shard, index });

    switch (volume.type) {
    case 'host':
      await this.hostVolumeDB.delete({ id: rawId });
      break;
    case 'opfs': {
      const manifest = await this.loadManifest() ?? structuredClone(EMPTY_MANIFEST);
      const fileSystem = manifest.fileSystems.find(candidate => (
        candidate.type === 'opfs_volume' && candidate.sourceId === rawId
      ));
      if (fileSystem !== undefined) {
        manifest.fileSystems = manifest.fileSystems.filter(
          candidate => candidate.id !== fileSystem.id,
        );
        await this.saveManifest({ manifest });
        await this.fileSystemStore.deleteFileSystem({
          rootDirectoryId: fileSystem.rootDirectoryId,
        });
      }
      break;
    }
    default: {
      const _ex: never = volume;
      throw new Error(`Unhandled encrypted volume: ${String(_ex)}`);
    }
    }
  }

  async renameVolume({
    volumeId,
    name,
  }: {
    volumeId: VolumeId,
    name: string,
  }): Promise<void> {
    const rawId = idToRaw({ id: volumeId });
    const shard = this.getShard({ id: rawId });
    const index = await this.loadVolumeShard({ shard });
    const volume = index.volumes[rawId];
    if (volume === undefined) {
      throw new Error(`Encrypted volume not found: ${rawId}`);
    }
    index.volumes[rawId] = { ...volume, name };
    await this.saveVolumeShard({ shard, index });
  }

  async importVolumeForTransition({
    volume,
    sourceAccess,
    signal,
  }: {
    volume: Volume,
    sourceAccess: StorageVolumeAccess,
    signal: AbortSignal | undefined,
  }): Promise<void> {
    const rawId = idToRaw({ id: volume.id });
    const shard = this.getShard({ id: rawId });
    switch (volume.type) {
    case 'host': {
      switch (sourceAccess.type) {
      case 'direct_directory':
        await this.hostVolumeDB.put({ id: rawId, handle: sourceAccess.handle });
        break;
      case 'encrypted_directory':
        throw new Error('Host volume transition source must be a direct directory');
      default: {
        const _ex: never = sourceAccess;
        throw new Error(`Unhandled host volume source: ${((_ex satisfies never) as { readonly type: string }).type}`);
      }
      }
      break;
    }
    case 'opfs': {
      const existing = await this.getVolumeFileSystem({ volumeId: rawId });
      if (existing !== undefined) {
        await this.fileSystemStore.deleteFileSystem({
          rootDirectoryId: existing.rootDirectoryId,
        });
      }
      const rootDirectoryId = await this.fileSystemStore.createFileSystem();
      const targetAccess = this.createEncryptedDirectoryAccess({ rootDirectoryId });
      try {
        await copyStorageDirectory({
          source: await createStorageDirectoryTransferSource({ access: sourceAccess }),
          target: createEncryptedStorageDirectoryTransferTarget({ access: targetAccess }),
          signal,
        });
        const manifest = await this.loadManifest() ?? structuredClone(EMPTY_MANIFEST);
        manifest.fileSystems = manifest.fileSystems.filter(candidate => (
          candidate.type !== 'opfs_volume' || candidate.sourceId !== rawId
        ));
        manifest.fileSystems.push({
          id: String(generateId()),
          type: 'opfs_volume',
          sourceId: rawId,
          rootDirectoryId,
        });
        await this.saveManifest({ manifest });
      } catch (error) {
        await this.fileSystemStore.deleteFileSystem({ rootDirectoryId }).catch(() => {});
        throw error;
      }
      break;
    }
    default:
      throw new Error(`Unhandled transition volume type: ${String(volume.type)}`);
    }
    const index = await this.loadVolumeShard({ shard });
    index.volumes[rawId] = volumeToDto({ domain: volume });
    await this.saveVolumeShard({ shard, index });
    await this.addManifestShard({ type: 'volume', shard });
  }

  async openSpecialFileSystemForTransition({
    type,
    create,
  }: {
    type: OpfsSpecialFileSystemType,
    create: boolean,
  }): Promise<StorageVolumeAccess | null> {
    const manifest = await this.loadManifest() ?? structuredClone(EMPTY_MANIFEST);
    let fileSystem = manifest.fileSystems.find(candidate => candidate.type === type);
    if (fileSystem === undefined && create) {
      const rootDirectoryId = await this.fileSystemStore.createFileSystem();
      const createdFileSystem = {
        id: String(generateId()),
        type,
        rootDirectoryId,
      } as Extract<EncryptedStoreManifestDto['fileSystems'][number], {
        type: typeof type,
      }>;
      manifest.fileSystems.push(createdFileSystem);
      await this.saveManifest({ manifest });
      fileSystem = createdFileSystem;
    }
    return fileSystem === undefined
      ? null
      : this.createEncryptedDirectoryAccess({
        rootDirectoryId: fileSystem.rootDirectoryId,
      });
  }

  async openSpecialFileSystemDirectory({
    type,
    path,
    create,
  }: {
    type: OpfsSpecialFileSystemType,
    path: string,
    create: boolean,
  }): Promise<StorageVolumeAccess | null> {
    const rootAccess = await this.openSpecialFileSystemForTransition({ type, create });
    if (rootAccess === null) {
      return null;
    }
    const encryptedRootAccess = (() => {
      switch (rootAccess.type) {
      case 'encrypted_directory':
        return rootAccess;
      case 'direct_directory':
        throw new Error('Encrypted OPFS special filesystem returned direct directory access');
      default: {
        const _ex: never = rootAccess;
        throw new Error(`Unhandled storage volume access: ${((_ex satisfies never) as { readonly type: string }).type}`);
      }
      }
    })();
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    if (normalizedPath === '/') {
      return encryptedRootAccess;
    }
    const directoryId = create
      ? await this.fileSystemStore.createDirectory({
        rootDirectoryId: encryptedRootAccess.rootDirectoryId,
        path: normalizedPath,
        recursive: true,
      })
      : await (async () => {
        const resolved = await this.fileSystemStore.tryResolve({
          rootDirectoryId: encryptedRootAccess.rootDirectoryId,
          path: normalizedPath,
        });
        if (resolved === undefined) {
          return undefined;
        }
        const entry = resolved.entry;
        if (entry === undefined) {
          throw new Error(`Encrypted special filesystem path has no entry: ${normalizedPath}`);
        }
        switch (entry.type) {
        case 'directory':
          return entry.directoryId;
        case 'file':
        case 'symlink':
          throw new Error(`Encrypted special filesystem path is not a directory: ${normalizedPath}`);
        default: {
          const _ex: never = entry;
          throw new Error(`Unhandled encrypted filesystem entry: ${((_ex satisfies never) as { readonly type: string }).type}`);
        }
        }
      })();
    return directoryId === undefined
      ? null
      : this.createEncryptedDirectoryAccess({ rootDirectoryId: directoryId });
  }

  async removeSpecialFileSystemEntry({
    type,
    path,
    recursive,
  }: {
    type: OpfsSpecialFileSystemType,
    path: string,
    recursive: boolean,
  }): Promise<void> {
    const rootAccess = await this.openSpecialFileSystemForTransition({ type, create: false });
    if (rootAccess === null) {
      return;
    }
    const encryptedRootAccess = (() => {
      switch (rootAccess.type) {
      case 'encrypted_directory':
        return rootAccess;
      case 'direct_directory':
        throw new Error('Encrypted OPFS special filesystem returned direct directory access');
      default: {
        const _ex: never = rootAccess;
        throw new Error(`Unhandled storage volume access: ${((_ex satisfies never) as { readonly type: string }).type}`);
      }
      }
    })();
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    if (normalizedPath === '/') {
      throw new Error('Removing a special filesystem root requires removeSpecialFileSystemForTransition()');
    }
    const resolved = await this.fileSystemStore.tryResolve({
      rootDirectoryId: encryptedRootAccess.rootDirectoryId,
      path: normalizedPath,
    });
    if (resolved === undefined) {
      return;
    }
    await this.fileSystemStore.remove({
      rootDirectoryId: encryptedRootAccess.rootDirectoryId,
      path: normalizedPath,
      recursive,
    });
  }

  async removeSpecialFileSystemForTransition({
    type,
  }: {
    type: OpfsSpecialFileSystemType,
  }): Promise<void> {
    const manifest = await this.loadManifest() ?? structuredClone(EMPTY_MANIFEST);
    const fileSystem = manifest.fileSystems.find(candidate => candidate.type === type);
    if (fileSystem === undefined) {
      return;
    }
    await this.fileSystemStore.deleteFileSystem({
      rootDirectoryId: fileSystem.rootDirectoryId,
    });
    manifest.fileSystems = manifest.fileSystems.filter(
      candidate => candidate.id !== fileSystem.id,
    );
    await this.saveManifest({ manifest });
  }

  private async loadVolumeShard({ shard }: { shard: string }): Promise<VolumeIndexDto> {
    const index = await this.jsonStore.read({
      locator: { namespace: 'volume_index', key: shard },
      schema: VolumeIndexSchemaDto,
    }) ?? { volumes: {} };
    assertVolumeShardIndex({ index, shard });
    return index;
  }

  private async saveVolumeShard({
    shard,
    index,
  }: {
    shard: string,
    index: VolumeIndexDto,
  }): Promise<void> {
    assertVolumeShardIndex({ index, shard });
    await this.jsonStore.write({
      locator: { namespace: 'volume_index', key: shard },
      value: index,
    });
  }

  private async getVolumeFileSystem({
    volumeId,
  }: {
    volumeId: string,
  }): Promise<Extract<EncryptedStoreManifestDto['fileSystems'][number], { type: 'opfs_volume' }> | undefined> {
    const manifest = await this.loadManifest() ?? EMPTY_MANIFEST;
    return manifest.fileSystems.find((candidate): candidate is Extract<
      EncryptedStoreManifestDto['fileSystems'][number],
      { type: 'opfs_volume' }
    > => candidate.type === 'opfs_volume' && candidate.sourceId === volumeId);
  }

  private createEncryptedDirectoryAccess({
    rootDirectoryId,
  }: {
    rootDirectoryId: string,
  }): Extract<StorageVolumeAccess, { type: 'encrypted_directory' }> {
    return {
      type: 'encrypted_directory',
      storeDirectory: this.storeDirectory,
      rootDirectoryId,
      objectEncryptionKey: this.keys.objectEncryptionKey,
      objectAddressKey: this.keys.objectAddressKey,
    };
  }

  private getShard({ id }: { id: string }): string {
    return getLogicalShard({ id });
  }

  private async hydrateAttachments({ nodes }: { nodes: MessageNode[] }): Promise<void> {
    const cache = new Map<string, BinaryShardIndexDto>();
    const visit = async ({ items }: { items: MessageNode[] }): Promise<void> => {
      for (const node of items) {
        for (const [index, attachment] of (node.attachments ?? []).entries()) {
          switch (attachment.status) {
          case 'persisted': {
            const rawId = idToRaw({ id: attachment.binaryObjectId });
            const shard = this.getShard({ id: rawId });
            let shardIndex = cache.get(shard);
            if (shardIndex === undefined) {
              shardIndex = await this.loadBinaryShard({ shard });
              cache.set(shard, shardIndex);
            }
            const metadata = shardIndex.objects[rawId];
            if (metadata === undefined) {
              node.attachments![index] = { ...attachment, status: 'missing' };
            } else {
              attachment.mimeType = metadata.mimeType;
              attachment.size = metadata.size;
              attachment.uploadedAt = metadata.createdAt;
            }
            break;
          }
          case 'memory':
          case 'missing':
            break;
          default: {
            const _ex: never = attachment;
            throw new Error(`Unhandled attachment: ${String(_ex)}`);
          }
          }
        }
        await visit({ items: node.replies.items });
      }
    };
    await visit({ items: nodes });
  }

  private async loadBinaryShard({ shard }: { shard: string }): Promise<BinaryShardIndexDto> {
    const index = await this.jsonStore.read({
      locator: { namespace: 'binary_shard_index', key: shard },
      schema: BinaryShardIndexSchemaDto,
    }) ?? { objects: {} };
    assertBinaryShardIndex({ index, shard });
    return index;
  }

  private async loadChatMetaShard({ shard }: { shard: string }): Promise<EncryptedChatMetaShardIndexDto> {
    const index = await this.jsonStore.read({
      locator: { namespace: 'chat_meta_shard_index', key: shard },
      schema: EncryptedChatMetaShardIndexSchemaDto,
    }) ?? { chatIds: [] };
    assertLogicalIdsForShard({
      ids: index.chatIds,
      shard,
      fieldName: 'Chat metadata shard index',
    });
    return index;
  }

  private async saveChatMetaShard({
    shard,
    index,
  }: {
    shard: string,
    index: EncryptedChatMetaShardIndexDto,
  }): Promise<void> {
    assertLogicalIdsForShard({
      ids: index.chatIds,
      shard,
      fieldName: 'Chat metadata shard index',
    });
    await this.jsonStore.write({
      locator: { namespace: 'chat_meta_shard_index', key: shard },
      value: index,
    });
  }

  private async loadChatGroupShard({ shard }: { shard: string }): Promise<EncryptedChatGroupShardIndexDto> {
    const index = await this.jsonStore.read({
      locator: { namespace: 'chat_group_shard_index', key: shard },
      schema: EncryptedChatGroupShardIndexSchemaDto,
    }) ?? { chatGroupIds: [] };
    assertLogicalIdsForShard({
      ids: index.chatGroupIds,
      shard,
      fieldName: 'Chat group shard index',
    });
    return index;
  }

  private async saveChatGroupShard({
    shard,
    index,
  }: {
    shard: string,
    index: EncryptedChatGroupShardIndexDto,
  }): Promise<void> {
    assertLogicalIdsForShard({
      ids: index.chatGroupIds,
      shard,
      fieldName: 'Chat group shard index',
    });
    await this.jsonStore.write({
      locator: { namespace: 'chat_group_shard_index', key: shard },
      value: index,
    });
  }

  private async saveBinaryShard({ shard, index }: {
    shard: string,
    index: BinaryShardIndexDto,
  }): Promise<void> {
    assertBinaryShardIndex({ index, shard });
    await this.jsonStore.write({
      locator: { namespace: 'binary_shard_index', key: shard },
      value: index,
    });
  }

  private async loadManifest(): Promise<EncryptedStoreManifestDto | undefined> {
    const manifest = await this.jsonStore.read({
      locator: { namespace: 'singleton', key: 'store_manifest' },
      schema: EncryptedStoreManifestSchemaDto,
    });
    if (manifest !== undefined) {
      assertEncryptedStoreManifest({ manifest });
    }
    return manifest;
  }

  private async saveManifest({ manifest }: { manifest: EncryptedStoreManifestDto }): Promise<void> {
    assertEncryptedStoreManifest({ manifest });
    await this.jsonStore.write({
      locator: { namespace: 'singleton', key: 'store_manifest' },
      value: manifest,
    });
  }

  private async addManifestShard({ type, shard }: {
    type: 'chat_meta' | 'chat_group' | 'binary_object' | 'volume',
    shard: string,
  }): Promise<void> {
    const manifest = await this.loadManifest() ?? structuredClone(EMPTY_MANIFEST);
    const target = (() => {
      switch (type) {
      case 'chat_meta':
        return manifest.chatMetaShardIds;
      case 'chat_group':
        return manifest.chatGroupShardIds;
      case 'binary_object':
        return manifest.binaryObjectShardIds;
      case 'volume':
        return manifest.volumeShardIds;
      default: {
        const _ex: never = type;
        throw new Error(`Unhandled manifest shard type: ${String(_ex)}`);
      }
      }
    })();
    if (!target.includes(shard)) {
      target.push(shard);
      target.sort();
      await this.saveManifest({ manifest });
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  assertBinaryShardIndex,
  assertEncryptedStoreManifest,
  assertLogicalIdsForShard,
  assertVolumeShardIndex,
};
