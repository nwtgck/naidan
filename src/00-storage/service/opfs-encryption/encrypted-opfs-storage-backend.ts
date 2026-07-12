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
  ChatContentSchemaDto,
  ChatGroupSchemaDto,
  ChatMetaSchemaDto,
  HierarchySchemaDto,
  SettingsSchemaDto,
  VolumeIndexSchemaDto,
  type BinaryObjectDto,
  type ChatGroupDto,
  type ChatMetaDto,
  type HierarchyDto,
  type MigrationChunkDto,
  type StorageBinaryObjectWriteSource,
  type VolumeDto,
  type VolumeIndexDto,
} from '@/00-storage/00-dto/dto';
import {
  EncryptedBinaryShardIndexSchemaDto,
  EncryptedChatGroupShardIndexSchemaDto,
  EncryptedChatMetaShardIndexSchemaDto,
  NaidanEncryptedStoreManifestSchemaDto,
  type EncryptedBinaryShardIndexDto,
  type EncryptedChatGroupShardIndexDto,
  type EncryptedChatMetaShardIndexDto,
  type NaidanEncryptedCollectionTypeDto,
  type NaidanEncryptedStoreManifestDto,
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
import {
  EncryptedObjectStore,
  type EncryptedObjectLocator,
} from './encrypted-object-store';
import {
  EncryptedObjectTransactionCoordinator,
  type EncryptedObjectMutationOperation,
} from './encrypted-object-transaction-coordinator';
import { EncryptedJsonObjectStore } from './encrypted-json-object-store';
import { EncryptedFileStore } from './encrypted-file-store';
import { EncryptedFileSystemStore } from './encrypted-file-system-store';
import { createEncryptedStorageDirectoryTransferTarget } from './encrypted-storage-directory-transfer';
import { createEncryptionOpaqueId } from './encryption-key-manager';
import type { EncryptedStoreRuntimeKeys } from './types';
import type { EncryptedStorageDebugCapability } from './encrypted-storage-debug-capability';

const UTF8 = new TextEncoder();

const COLLECTION_TYPES = [
  'chat_meta',
  'chat_group',
  'binary_object',
  'volume',
] as const satisfies readonly NaidanEncryptedCollectionTypeDto[];

const EMPTY_MANIFEST: NaidanEncryptedStoreManifestDto = {
  collections: COLLECTION_TYPES.map(type => ({ type, shardIds: [] })),
};

const CHAT_WESH_FILE_SYSTEM_ID = 'system/chat-wesh';
const DEBUG_WESH_FILE_SYSTEM_ID = 'system/debug-wesh';
const TMP_FILE_SYSTEM_ID = 'system/tmp';

function getVolumeFileSystemId({ volumeId }: { volumeId: string }): string {
  return `volume/${volumeId}`;
}

type DirectDirectoryAccess = Extract<StorageVolumeAccess, { type: 'direct_directory' }>;
type EncryptedDirectoryAccess = Extract<StorageVolumeAccess, { type: 'encrypted_directory' }>;

function requireDirectDirectoryAccess({
  access,
  context,
}: {
  access: StorageVolumeAccess,
  context: string,
}): DirectDirectoryAccess {
  switch (access.type) {
  case 'direct_directory':
    return access;
  case 'encrypted_directory':
    throw new Error(`${context} must be a direct directory`);
  default: {
    const _ex: never = access;
    throw new Error(`Unhandled storage volume access: ${String(_ex)}`);
  }
  }
}

function requireEncryptedDirectoryAccess({
  access,
  context,
}: {
  access: StorageVolumeAccess,
  context: string,
}): EncryptedDirectoryAccess {
  switch (access.type) {
  case 'direct_directory':
    throw new Error(`${context} must be an encrypted directory`);
  case 'encrypted_directory':
    return access;
  default: {
    const _ex: never = access;
    throw new Error(`Unhandled storage volume access: ${String(_ex)}`);
  }
  }
}

function getSpecialFileSystemId({
  type,
}: {
  type: OpfsSpecialFileSystemType,
}): string {
  switch (type) {
  case 'chat_wesh':
    return CHAT_WESH_FILE_SYSTEM_ID;
  case 'debug_wesh':
    return DEBUG_WESH_FILE_SYSTEM_ID;
  case 'tmp':
    return TMP_FILE_SYSTEM_ID;
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled OPFS special filesystem type: ${String(_ex)}`);
  }
  }
}

function getCollection({
  manifest,
  type,
}: {
  manifest: NaidanEncryptedStoreManifestDto,
  type: NaidanEncryptedCollectionTypeDto,
}): NaidanEncryptedStoreManifestDto['collections'][number] {
  const collection = manifest.collections.find(candidate => candidate.type === type);
  if (collection === undefined) {
    throw new Error(`Encrypted store manifest is missing collection: ${type}`);
  }
  return collection;
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
    if (!/^[0-9a-f]{2}$/u.test(shardId)) {
      throw new Error(`${fieldName} contains an invalid shard ID: ${shardId}`);
    }
    if (seenShardIds.has(shardId)) {
      throw new Error(`${fieldName} contains a duplicate shard ID: ${shardId}`);
    }
    seenShardIds.add(shardId);
  }
}

function assertEncryptedStoreManifest({
  manifest,
}: {
  manifest: NaidanEncryptedStoreManifestDto,
}): void {
  const seenTypes = new Set<NaidanEncryptedCollectionTypeDto>();
  for (const collection of manifest.collections) {
    if (seenTypes.has(collection.type)) {
      throw new Error(`Encrypted store manifest contains a duplicate collection: ${collection.type}`);
    }
    seenTypes.add(collection.type);
    assertShardIds({
      shardIds: collection.shardIds,
      fieldName: `Encrypted ${collection.type} collection`,
    });
  }
  for (const expectedType of COLLECTION_TYPES) {
    if (!seenTypes.has(expectedType)) {
      throw new Error(`Encrypted store manifest is missing collection: ${expectedType}`);
    }
  }
}

function assertUniqueIds({
  ids,
  fieldName,
}: {
  ids: string[],
  fieldName: string,
}): void {
  const seenIds = new Set<string>();
  for (const id of ids) {
    if (id.length === 0 || seenIds.has(id)) {
      throw new Error(`${fieldName} contains an invalid or duplicate ID: ${JSON.stringify(id)}`);
    }
    seenIds.add(id);
  }
}

function assertBinaryShardIndex({
  index,
}: {
  index: EncryptedBinaryShardIndexDto,
}): void {
  for (const [id, entry] of Object.entries(index.objects)) {
    if (entry.metadata.id !== id) {
      throw new Error(`Binary object index key does not match its DTO ID: ${JSON.stringify(id)}`);
    }
    if (entry.fileId.length === 0) {
      throw new Error(`Binary object index contains an empty file ID: ${JSON.stringify(id)}`);
    }
  }
}

function assertVolumeShardIndex({
  index,
}: {
  index: VolumeIndexDto,
}): void {
  for (const [id, volume] of Object.entries(index.volumes)) {
    if (volume.id !== id) {
      throw new Error(`Volume index key does not match its DTO ID: ${JSON.stringify(id)}`);
    }
  }
}

function jsonWriteOperation({
  locator,
  value,
}: {
  locator: EncryptedObjectLocator,
  value: unknown,
}): EncryptedObjectMutationOperation {
  return {
    type: 'write',
    locator,
    plaintext: UTF8.encode(JSON.stringify(value)),
  };
}

function deleteOperation({
  locator,
}: {
  locator: EncryptedObjectLocator,
}): EncryptedObjectMutationOperation {
  return { type: 'delete', locator };
}

export class EncryptedOPFSStorageBackend extends IStorageProvider {
  constructor({
    encryptedStoreId,
    storeDirectory,
    keys,
  }: {
    encryptedStoreId: string,
    storeDirectory: FileSystemDirectoryHandle,
    keys: EncryptedStoreRuntimeKeys,
  }) {
    super();
    this.encryptedStoreId = encryptedStoreId;
    this.storeDirectory = storeDirectory;
    this.keys = keys;
    this.objectStore = new EncryptedObjectStore({
      storeDirectory,
      keys,
      area: 'durable',
    });
    this.temporaryObjectStore = new EncryptedObjectStore({
      storeDirectory,
      keys,
      area: 'temporary',
    });
    this.jsonStore = new EncryptedJsonObjectStore({ objectStore: this.objectStore });
    this.fileStore = new EncryptedFileStore({ objectStore: this.objectStore });
    this.fileSystemStore = new EncryptedFileSystemStore({
      objectStore: this.objectStore,
      fileStore: this.fileStore,
    });
    this.temporaryFileSystemStore = new EncryptedFileSystemStore({
      objectStore: this.temporaryObjectStore,
      fileStore: new EncryptedFileStore({ objectStore: this.temporaryObjectStore }),
    });
    this.storeTransactionCoordinator = new EncryptedObjectTransactionCoordinator({
      objectStore: this.objectStore,
      scopeId: 'naidan-store',
      lockName: `naidan/opfs-encryption/store/${encryptedStoreId}`,
    });
  }

  readonly canPersistBinary = true;
  private readonly encryptedStoreId: string;
  private readonly storeDirectory: FileSystemDirectoryHandle;
  private readonly keys: EncryptedStoreRuntimeKeys;
  private readonly objectStore: EncryptedObjectStore;
  private readonly temporaryObjectStore: EncryptedObjectStore;
  private readonly jsonStore: EncryptedJsonObjectStore;
  private readonly fileStore: EncryptedFileStore;
  private readonly fileSystemStore: EncryptedFileSystemStore;
  private readonly temporaryFileSystemStore: EncryptedFileSystemStore;
  private readonly storeTransactionCoordinator: EncryptedObjectTransactionCoordinator;
  private readonly hostVolumeDB = new HostVolumeDB();


  createDebugCapability({
    storageRoot,
  }: {
    storageRoot: FileSystemDirectoryHandle,
  }): EncryptedStorageDebugCapability {
    return {
      storageRoot,
      storeDirectory: this.storeDirectory,
      encryptedStoreId: this.encryptedStoreId,
      objectEncryptionKey: this.keys.objectEncryptionKey,
      objectAddressKey: this.keys.objectAddressKey,
    };
  }

  async init(): Promise<void> {
    // A persisted write-ahead log is a committed intent. Recover it before
    // exposing any Naidan-level reads so no caller can observe an intermediate
    // collection/index state after a tab or browser interruption.
    await this.storeTransactionCoordinator.recover();
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
    return await this.storeTransactionCoordinator.read({
      run: async () => await this.listChatMetasRawUnsafe(),
    });
  }

  private async listChatMetasRawUnsafe(): Promise<ChatMetaDto[]> {
    const manifest = await this.requireManifest();
    const hierarchy = await this.loadHierarchy() ?? { items: [] };
    const chatIds = new Set<string>();
    for (const shard of getCollection({ manifest, type: 'chat_meta' }).shardIds) {
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
    return await this.storeTransactionCoordinator.read({
      run: async () => await this.listChatGroupsRawUnsafe(),
    });
  }

  private async listChatGroupsRawUnsafe(): Promise<ChatGroupDto[]> {
    const manifest = await this.requireManifest();
    const hierarchy = await this.loadHierarchy() ?? { items: [] };
    const chatGroupIds = new Set<string>();
    for (const shard of getCollection({ manifest, type: 'chat_group' }).shardIds) {
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
    await this.storeTransactionCoordinator.mutate({
      prepare: async () => {
        const shard = await this.getShard({ type: 'chat_meta', id: rawId });
        const index = await this.loadChatMetaShard({ shard });
        if (!index.chatIds.includes(rawId)) {
          index.chatIds.push(rawId);
          index.chatIds.sort();
        }
        const manifest = await this.loadManifestWithShard({ type: 'chat_meta', shard });
        return {
          operations: [
            jsonWriteOperation({
              locator: { namespace: 'chat_meta', key: rawId },
              value: chatMetaToDto({ domain: meta }),
            }),
            jsonWriteOperation({
              locator: { namespace: 'chat_meta_shard_index', key: shard },
              value: index,
            }),
            jsonWriteOperation({
              locator: { namespace: 'singleton', key: 'store_manifest' },
              value: manifest,
            }),
          ],
        };
      },
      result: async () => undefined,
    });
  }

  async saveChatContent({ id, content }: { id: ChatId, content: ChatContent }): Promise<void> {
    await this.jsonStore.write({
      locator: { namespace: 'chat_content', key: idToRaw({ id }) },
      value: chatContentToDto({ domain: content }),
    });
  }

  async loadChat({ id }: { id: ChatId }): Promise<Chat | null> {
    return await this.storeTransactionCoordinator.read({
      run: async () => {
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
      },
    });
  }

  async loadChatMeta({ id }: { id: ChatId }): Promise<ChatMeta | null> {
    return await this.storeTransactionCoordinator.read({
      run: async () => {
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
      },
    });
  }

  async loadChatContent({ id }: { id: ChatId }): Promise<ChatContent | null> {
    return await this.storeTransactionCoordinator.read({
      run: async () => {
        const content = await this.loadChatContentWithoutAttachmentsUnsafe({ id });
        if (content === null) {
          return null;
        }
        await this.hydrateAttachments({ nodes: content.root.items });
        return content;
      },
    });
  }

  async loadChatContentWithoutAttachments({ id }: { id: ChatId }): Promise<ChatContent | null> {
    return await this.storeTransactionCoordinator.read({
      run: async () => await this.loadChatContentWithoutAttachmentsUnsafe({ id }),
    });
  }

  private async loadChatContentWithoutAttachmentsUnsafe({
    id,
  }: {
    id: ChatId,
  }): Promise<ChatContent | null> {
    const dto = await this.jsonStore.read({
      locator: { namespace: 'chat_content', key: idToRaw({ id }) },
      schema: ChatContentSchemaDto,
    });
    return dto === undefined ? null : chatContentToDomain({ dto });
  }

  async deleteChat({ id }: { id: ChatId }): Promise<void> {
    const rawId = idToRaw({ id });
    await this.storeTransactionCoordinator.mutate({
      prepare: async () => {
        const shard = await this.getShard({ type: 'chat_meta', id: rawId });
        const index = await this.loadChatMetaShard({ shard });
        index.chatIds = index.chatIds.filter(chatId => chatId !== rawId);
        return {
          operations: [
            jsonWriteOperation({
              locator: { namespace: 'chat_meta_shard_index', key: shard },
              value: index,
            }),
            deleteOperation({ locator: { namespace: 'chat_meta', key: rawId } }),
            deleteOperation({ locator: { namespace: 'chat_content', key: rawId } }),
          ],
        };
      },
      result: async () => undefined,
    });
  }

  async saveChatGroup({ chatGroup }: { chatGroup: ChatGroup }): Promise<void> {
    const rawId = idToRaw({ id: chatGroup.id });
    await this.storeTransactionCoordinator.mutate({
      prepare: async () => {
        const shard = await this.getShard({ type: 'chat_group', id: rawId });
        const index = await this.loadChatGroupShard({ shard });
        if (!index.chatGroupIds.includes(rawId)) {
          index.chatGroupIds.push(rawId);
          index.chatGroupIds.sort();
        }
        const manifest = await this.loadManifestWithShard({ type: 'chat_group', shard });
        return {
          operations: [
            jsonWriteOperation({
              locator: { namespace: 'chat_group', key: rawId },
              value: chatGroupToDto({ domain: chatGroup }),
            }),
            jsonWriteOperation({
              locator: { namespace: 'chat_group_shard_index', key: shard },
              value: index,
            }),
            jsonWriteOperation({
              locator: { namespace: 'singleton', key: 'store_manifest' },
              value: manifest,
            }),
          ],
        };
      },
      result: async () => undefined,
    });
  }

  async loadChatGroup({ id }: { id: ChatGroupId }): Promise<ChatGroup | null> {
    return await this.storeTransactionCoordinator.read({
      run: async () => {
        const dto = await this.jsonStore.read({
          locator: { namespace: 'chat_group', key: idToRaw({ id }) },
          schema: ChatGroupSchemaDto,
        });
        if (dto === undefined) {
          return null;
        }
        const { hierarchy, chatMetas } = await promiseAllKeyed({
          hierarchy: this.loadHierarchy(),
          chatMetas: this.listChatMetasRawUnsafe(),
        });
        return chatGroupToDomain({
          dto,
          hierarchy: hierarchyToDomain({ dto: hierarchy ?? { items: [] } }),
          chatMetas: chatMetas.map(meta => chatMetaToDomain({ dto: meta })),
        });
      },
    });
  }

  async deleteChatGroup({ id }: { id: ChatGroupId }): Promise<void> {
    const rawId = idToRaw({ id });
    await this.storeTransactionCoordinator.mutate({
      prepare: async () => {
        const shard = await this.getShard({ type: 'chat_group', id: rawId });
        const index = await this.loadChatGroupShard({ shard });
        index.chatGroupIds = index.chatGroupIds.filter(chatGroupId => chatGroupId !== rawId);
        return {
          operations: [
            jsonWriteOperation({
              locator: { namespace: 'chat_group_shard_index', key: shard },
              value: index,
            }),
            deleteOperation({ locator: { namespace: 'chat_group', key: rawId } }),
          ],
        };
      },
      result: async () => undefined,
    });
  }

  async getSidebarStructure(): Promise<SidebarItem[]> {
    return await this.storeTransactionCoordinator.read({
      run: async () => {
        const { rawHierarchy, rawMetas, rawGroups } = await promiseAllKeyed({
          rawHierarchy: this.loadHierarchy(),
          rawMetas: this.listChatMetasRawUnsafe(),
          rawGroups: this.listChatGroupsRawUnsafe(),
        });
        const hierarchy = hierarchyToDomain({ dto: rawHierarchy ?? { items: [] } });
        const chatMetas = rawMetas.map(dto => chatMetaToDomain({ dto }));
        const chatGroups = rawGroups.map(dto => chatGroupToDomain({ dto, hierarchy, chatMetas }));
        return buildSidebarItemsFromHierarchy({ hierarchy, chatMetas, chatGroups });
      },
    });
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

  async removeSettingsForTransition(): Promise<void> {
    await this.jsonStore.delete({
      locator: { namespace: 'singleton', key: 'settings' },
    });
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
    const newFileId = `binary/${rawId}/${createEncryptionOpaqueId()}`;
    await this.fileStore.write({
      fileId: newFileId,
      source: openStorageBinaryObjectWriteSourceStream({ source }),
      size,
      createdAt,
      modifiedAt: createdAt,
      signal,
    });

    let oldFileId: string | undefined;
    const cleanupNewFile = async (): Promise<void> => {
      await this.fileStore.delete({ fileId: newFileId }).catch(() => undefined);
    };
    await this.storeTransactionCoordinator.mutate({
      prepare: async () => {
        try {
          const shard = await this.getShard({ type: 'binary_object', id: rawId });
          const index = await this.loadBinaryShard({ shard });
          oldFileId = index.objects[rawId]?.fileId;
          const metadata: BinaryObjectDto = {
            id: rawId,
            mimeType,
            size,
            createdAt,
            name,
          };
          index.objects[rawId] = { metadata, fileId: newFileId };
          const manifest = await this.loadManifestWithShard({ type: 'binary_object', shard });
          return {
            operations: [
              jsonWriteOperation({
                locator: { namespace: 'binary_shard_index', key: shard },
                value: index,
              }),
              jsonWriteOperation({
                locator: { namespace: 'singleton', key: 'store_manifest' },
                value: manifest,
              }),
            ],
            cleanupAfterFailure: cleanupNewFile,
            cleanupAfterCommit: async () => {
              if (oldFileId !== undefined && oldFileId !== newFileId) {
                await this.fileStore.delete({ fileId: oldFileId });
              }
            },
          };
        } catch (error) {
          await cleanupNewFile();
          throw error;
        }
      },
      result: async () => undefined,
    });
  }

  async openBinaryObject({ binaryObjectId }: {
    binaryObjectId: BinaryObjectId,
  }): Promise<StorageBinaryObjectReadHandle | null> {
    return await this.storeTransactionCoordinator.read({
      run: async () => {
        const rawId = idToRaw({ id: binaryObjectId });
        const shard = await this.getShard({ type: 'binary_object', id: rawId });
        const entry = (await this.loadBinaryShard({ shard })).objects[rawId];
        if (entry === undefined) {
          return null;
        }
        return await this.fileStore.open({
          fileId: entry.fileId,
          mimeType: entry.metadata.mimeType,
        });
      },
    });
  }

  async getBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<BinaryObject | null> {
    return await this.storeTransactionCoordinator.read({
      run: async () => {
        const rawId = idToRaw({ id: binaryObjectId });
        const shard = await this.getShard({ type: 'binary_object', id: rawId });
        const entry = (await this.loadBinaryShard({ shard })).objects[rawId];
        return entry === undefined ? null : binaryObjectToDomain({ dto: entry.metadata });
      },
    });
  }

  async hasAttachments(): Promise<boolean> {
    return await this.storeTransactionCoordinator.read({
      run: async () => {
        const manifest = await this.requireManifest();
        for (const shard of getCollection({ manifest, type: 'binary_object' }).shardIds) {
          const index = await this.loadBinaryShard({ shard });
          if (Object.keys(index.objects).length > 0) {
            return true;
          }
        }
        return false;
      },
    });
  }

  async *listBinaryObjects(): AsyncIterable<BinaryObject> {
    const binaryObjects = await this.storeTransactionCoordinator.read({
      run: async () => {
        const values: BinaryObject[] = [];
        const manifest = await this.requireManifest();
        for (const shard of getCollection({ manifest, type: 'binary_object' }).shardIds) {
          const index = await this.loadBinaryShard({ shard });
          for (const entry of Object.values(index.objects)) {
            values.push(binaryObjectToDomain({ dto: entry.metadata }));
          }
        }
        return values;
      },
    });
    for (const binaryObject of binaryObjects) {
      yield binaryObject;
    }
  }

  async deleteBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<void> {
    const rawId = idToRaw({ id: binaryObjectId });
    let removedFileId: string | undefined;
    await this.storeTransactionCoordinator.mutate({
      prepare: async () => {
        const shard = await this.getShard({ type: 'binary_object', id: rawId });
        const index = await this.loadBinaryShard({ shard });
        removedFileId = index.objects[rawId]?.fileId;
        delete index.objects[rawId];
        return {
          operations: [jsonWriteOperation({
            locator: { namespace: 'binary_shard_index', key: shard },
            value: index,
          })],
          cleanupAfterCommit: async () => {
            if (removedFileId !== undefined) {
              await this.fileStore.delete({ fileId: removedFileId });
            }
          },
        };
      },
      result: async () => undefined,
    });
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
    const volumes = await this.storeTransactionCoordinator.read({
      run: async () => {
        const values: Volume[] = [];
        const manifest = await this.requireManifest();
        for (const shard of getCollection({ manifest, type: 'volume' }).shardIds) {
          const index = await this.loadVolumeShard({ shard });
          for (const dto of Object.values(index.volumes)) {
            values.push(volumeToDomain({ dto }));
          }
        }
        return values;
      },
    });
    for (const volume of volumes) {
      yield volume;
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
    const shard = await this.getShard({ type: 'volume', id: rawId });
    const volumeDto: VolumeDto = { type, id: rawId, name, createdAt };
    const fileSystemId = getVolumeFileSystemId({ volumeId: rawId });
    const cleanupPreparedVolume = async (): Promise<void> => {
      switch (type) {
      case 'opfs':
        await this.fileSystemStore.deleteFileSystem({ fileSystemId }).catch(() => undefined);
        break;
      case 'host':
        await this.hostVolumeDB.delete({ id: rawId }).catch(() => undefined);
        break;
      default: {
        const _ex: never = type;
        throw new Error(`Unhandled volume type: ${String(_ex)}`);
      }
      }
    };

    try {
      switch (type) {
      case 'opfs': {
        const descriptor = await this.fileSystemStore.createFileSystem({
          fileSystemId,
          createdAt,
        });
        await this.fileSystemStore.importDirectory({
          rootDirectoryId: descriptor.rootDirectoryId,
          source: sourceHandle,
          destinationPath: '/',
          signal: undefined,
        });
        break;
      }
      case 'host':
        await this.hostVolumeDB.put({ id: rawId, handle: sourceHandle });
        break;
      default: {
        const _ex: never = type;
        throw new Error(`Unhandled volume type: ${String(_ex)}`);
      }
      }
    } catch (error) {
      await cleanupPreparedVolume();
      throw error;
    }

    await this.storeTransactionCoordinator.mutate({
      prepare: async () => {
        try {
          const index = await this.loadVolumeShard({ shard });
          index.volumes[rawId] = volumeDto;
          const manifest = await this.loadManifestWithShard({ type: 'volume', shard });
          return {
            operations: [
              jsonWriteOperation({
                locator: { namespace: 'volume_index', key: shard },
                value: index,
              }),
              jsonWriteOperation({
                locator: { namespace: 'singleton', key: 'store_manifest' },
                value: manifest,
              }),
            ],
            cleanupAfterFailure: cleanupPreparedVolume,
          };
        } catch (error) {
          await cleanupPreparedVolume();
          throw error;
        }
      },
      result: async () => undefined,
    });
    return volumeToDomain({ dto: volumeDto });
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
    const shard = await this.getShard({ type: 'volume', id: rawId });
    const fileSystemId = getVolumeFileSystemId({ volumeId: rawId });
    const descriptor = await this.fileSystemStore.createFileSystem({
      fileSystemId,
      createdAt,
    });
    const cleanupPreparedVolume = async (): Promise<void> => {
      await this.fileSystemStore.deleteFileSystem({ fileSystemId }).catch(() => undefined);
    };

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
          rootDirectoryId: descriptor.rootDirectoryId,
          path: parentPath,
          recursive: true,
          createdAt: null,
        });
        await this.fileSystemStore.writeFile({
          rootDirectoryId: descriptor.rootDirectoryId,
          path: `${parentPath}/${fileName}`,
          source: entry.file.stream(),
          size: entry.file.size,
          createdAt: null,
          modifiedAt: entry.file.lastModified,
          signal,
        });
        onProgress?.({ processed: index + 1, total: entries.length });
      }
    } catch (error) {
      await cleanupPreparedVolume();
      throw error;
    }

    const volumeDto: VolumeDto = {
      type: 'opfs',
      id: rawId,
      name,
      createdAt,
    };
    await this.storeTransactionCoordinator.mutate({
      prepare: async () => {
        try {
          const index = await this.loadVolumeShard({ shard });
          index.volumes[rawId] = volumeDto;
          const manifest = await this.loadManifestWithShard({ type: 'volume', shard });
          return {
            operations: [
              jsonWriteOperation({
                locator: { namespace: 'volume_index', key: shard },
                value: index,
              }),
              jsonWriteOperation({
                locator: { namespace: 'singleton', key: 'store_manifest' },
                value: manifest,
              }),
            ],
            cleanupAfterFailure: cleanupPreparedVolume,
          };
        } catch (error) {
          await cleanupPreparedVolume();
          throw error;
        }
      },
      result: async () => undefined,
    });
    return volumeToDomain({ dto: volumeDto });
  }

  async openVolume({
    volumeId,
  }: {
    volumeId: VolumeId,
  }): Promise<StorageVolumeAccess | null> {
    return await this.storeTransactionCoordinator.read({
      run: async () => {
        const rawId = idToRaw({ id: volumeId });
        const shard = await this.getShard({ type: 'volume', id: rawId });
        const volume = (await this.loadVolumeShard({ shard })).volumes[rawId];
        if (volume === undefined) {
          return null;
        }
        switch (volume.type) {
        case 'host': {
          const handle = await this.hostVolumeDB.get({ id: rawId });
          return handle === undefined ? null : { type: 'direct_directory' as const, handle };
        }
        case 'opfs': {
          const fileSystemId = getVolumeFileSystemId({ volumeId: rawId });
          const descriptor = await this.fileSystemStore.openFileSystem({ fileSystemId });
          if (descriptor === undefined) {
            throw new Error(`Encrypted volume filesystem is missing: ${rawId}`);
          }
          return this.createEncryptedDirectoryAccess({
            fileSystemId,
            rootDirectoryId: descriptor.rootDirectoryId,
            physicalArea: 'durable',
          });
        }
        default: {
          const _ex: never = volume;
          throw new Error(`Unhandled encrypted volume: ${String(_ex)}`);
        }
        }
      },
    });
  }

  async deleteVolume({ volumeId }: { volumeId: VolumeId }): Promise<void> {
    const rawId = idToRaw({ id: volumeId });
    const shard = await this.getShard({ type: 'volume', id: rawId });
    let removedVolume: VolumeDto | undefined;
    await this.storeTransactionCoordinator.mutate({
      prepare: async () => {
        const index = await this.loadVolumeShard({ shard });
        removedVolume = index.volumes[rawId];
        if (removedVolume === undefined) {
          return { operations: [] };
        }
        delete index.volumes[rawId];
        return {
          operations: [jsonWriteOperation({
            locator: { namespace: 'volume_index', key: shard },
            value: index,
          })],
          cleanupAfterCommit: async () => {
            switch (removedVolume?.type) {
            case 'host':
              await this.hostVolumeDB.delete({ id: rawId });
              break;
            case 'opfs':
              await this.fileSystemStore.deleteFileSystem({
                fileSystemId: getVolumeFileSystemId({ volumeId: rawId }),
              });
              break;
            case undefined:
              break;
            default: {
              const _ex: never = removedVolume;
              throw new Error(`Unhandled encrypted volume: ${String(_ex)}`);
            }
            }
          },
        };
      },
      result: async () => undefined,
    });
  }

  async renameVolume({
    volumeId,
    name,
  }: {
    volumeId: VolumeId,
    name: string,
  }): Promise<void> {
    const rawId = idToRaw({ id: volumeId });
    const shard = await this.getShard({ type: 'volume', id: rawId });
    await this.storeTransactionCoordinator.mutate({
      prepare: async () => {
        const index = await this.loadVolumeShard({ shard });
        const volume = index.volumes[rawId];
        if (volume === undefined) {
          throw new Error(`Encrypted volume not found: ${rawId}`);
        }
        index.volumes[rawId] = { ...volume, name };
        return {
          operations: [jsonWriteOperation({
            locator: { namespace: 'volume_index', key: shard },
            value: index,
          })],
        };
      },
      result: async () => undefined,
    });
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
    const shard = await this.getShard({ type: 'volume', id: rawId });
    const fileSystemId = getVolumeFileSystemId({ volumeId: rawId });
    switch (volume.type) {
    case 'host': {
      const directSourceAccess = requireDirectDirectoryAccess({
        access: sourceAccess,
        context: 'Host volume transition source',
      });
      await this.hostVolumeDB.put({ id: rawId, handle: directSourceAccess.handle });
      break;
    }
    case 'opfs': {
      await this.fileSystemStore.deleteFileSystem({ fileSystemId });
      const descriptor = await this.fileSystemStore.createFileSystem({
        fileSystemId,
        createdAt: volume.createdAt,
      });
      const targetAccess = this.createEncryptedDirectoryAccess({
        fileSystemId,
        rootDirectoryId: descriptor.rootDirectoryId,
        physicalArea: 'durable',
      });
      try {
        await copyStorageDirectory({
          source: await createStorageDirectoryTransferSource({ access: sourceAccess }),
          target: createEncryptedStorageDirectoryTransferTarget({ access: targetAccess }),
          signal,
        });
      } catch (error) {
        await this.fileSystemStore.deleteFileSystem({ fileSystemId }).catch(() => undefined);
        throw error;
      }
      break;
    }
    default: {
      const _ex: never = volume.type;
      throw new Error(`Unhandled transition volume type: ${String(_ex)}`);
    }
    }

    await this.storeTransactionCoordinator.mutate({
      prepare: async () => {
        const index = await this.loadVolumeShard({ shard });
        index.volumes[rawId] = volumeToDto({ domain: volume });
        const manifest = await this.loadManifestWithShard({ type: 'volume', shard });
        return {
          operations: [
            jsonWriteOperation({
              locator: { namespace: 'volume_index', key: shard },
              value: index,
            }),
            jsonWriteOperation({
              locator: { namespace: 'singleton', key: 'store_manifest' },
              value: manifest,
            }),
          ],
        };
      },
      result: async () => undefined,
    });
  }

  async openSpecialFileSystemForTransition({
    type,
    create,
  }: {
    type: OpfsSpecialFileSystemType,
    create: boolean,
  }): Promise<StorageVolumeAccess | null> {
    const fileSystemId = getSpecialFileSystemId({ type });
    const { store, physicalArea } = this.getSpecialFileSystemStore({ type });
    const descriptor = create
      ? await store.getOrCreateFileSystem({ fileSystemId, createdAt: Date.now() })
      : await store.openFileSystem({ fileSystemId });
    return descriptor === undefined
      ? null
      : this.createEncryptedDirectoryAccess({
        fileSystemId,
        rootDirectoryId: descriptor.rootDirectoryId,
        physicalArea,
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
    const openedRootAccess = await this.openSpecialFileSystemForTransition({ type, create });
    if (openedRootAccess === null) {
      return null;
    }
    const rootAccess = requireEncryptedDirectoryAccess({
      access: openedRootAccess,
      context: 'Encrypted OPFS special filesystem root',
    });
    const { store } = this.getSpecialFileSystemStore({ type });
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    if (normalizedPath === '/') {
      return rootAccess;
    }
    const directoryId = create
      ? await store.createDirectory({
        rootDirectoryId: rootAccess.rootDirectoryId,
        path: normalizedPath,
        recursive: true,
      })
      : await (async () => {
        const resolved = await store.tryResolve({
          rootDirectoryId: rootAccess.rootDirectoryId,
          path: normalizedPath,
        });
        if (resolved === undefined) {
          return undefined;
        }
        const entry = resolved.entry;
        if (entry === undefined) {
          throw new Error(`Encrypted special filesystem path is not a directory: ${normalizedPath}`);
        }
        switch (entry.type) {
        case 'file':
        case 'symlink':
          throw new Error(`Encrypted special filesystem path is not a directory: ${normalizedPath}`);
        case 'directory':
          return entry.directoryId;
        default: {
          const _ex: never = entry;
          throw new Error(`Unhandled encrypted filesystem entry: ${String(_ex)}`);
        }
        }
      })();
    return directoryId === undefined
      ? null
      : this.createEncryptedDirectoryAccess({
        fileSystemId: rootAccess.fileSystemId,
        rootDirectoryId: directoryId,
        physicalArea: rootAccess.physicalArea,
      });
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
    const openedRootAccess = await this.openSpecialFileSystemForTransition({ type, create: false });
    if (openedRootAccess === null) {
      return;
    }
    const rootAccess = requireEncryptedDirectoryAccess({
      access: openedRootAccess,
      context: 'Encrypted OPFS special filesystem root',
    });
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    if (normalizedPath === '/') {
      throw new Error('Removing a special filesystem root requires removeSpecialFileSystemForTransition()');
    }
    const { store } = this.getSpecialFileSystemStore({ type });
    if (await store.tryResolve({
      rootDirectoryId: rootAccess.rootDirectoryId,
      path: normalizedPath,
    }) === undefined) {
      return;
    }
    await store.remove({
      rootDirectoryId: rootAccess.rootDirectoryId,
      path: normalizedPath,
      recursive,
    });
  }

  async removeSpecialFileSystemForTransition({
    type,
  }: {
    type: OpfsSpecialFileSystemType,
  }): Promise<void> {
    const { store } = this.getSpecialFileSystemStore({ type });
    await store.deleteFileSystem({ fileSystemId: getSpecialFileSystemId({ type }) });
  }

  private async loadVolumeShard({ shard }: { shard: string }): Promise<VolumeIndexDto> {
    if (!await this.hasRegisteredCollectionShard({ type: 'volume', shard })) {
      return { volumes: {} };
    }
    const index = await this.jsonStore.read({
      locator: { namespace: 'volume_index', key: shard },
      schema: VolumeIndexSchemaDto,
    });
    if (index === undefined) {
      throw new Error(`Registered encrypted volume shard index is missing: ${shard}`);
    }
    assertVolumeShardIndex({ index });
    await this.assertIdsForShard({
      type: 'volume',
      ids: Object.keys(index.volumes),
      shard,
      fieldName: 'Volume shard index',
    });
    return index;
  }

  private createEncryptedDirectoryAccess({
    fileSystemId,
    rootDirectoryId,
    physicalArea,
  }: {
    fileSystemId: string,
    rootDirectoryId: string,
    physicalArea: 'durable' | 'temporary',
  }): Extract<StorageVolumeAccess, { type: 'encrypted_directory' }> {
    return {
      type: 'encrypted_directory',
      storeDirectory: this.storeDirectory,
      encryptedStoreId: this.encryptedStoreId,
      fileSystemId,
      physicalArea,
      rootDirectoryId,
      objectEncryptionKey: this.keys.objectEncryptionKey,
      objectAddressKey: this.keys.objectAddressKey,
    };
  }

  private getSpecialFileSystemStore({
    type,
  }: {
    type: OpfsSpecialFileSystemType,
  }): {
    readonly store: EncryptedFileSystemStore,
    readonly physicalArea: 'durable' | 'temporary',
  } {
    switch (type) {
    case 'chat_wesh':
    case 'debug_wesh':
      return { store: this.fileSystemStore, physicalArea: 'durable' };
    case 'tmp':
      return { store: this.temporaryFileSystemStore, physicalArea: 'temporary' };
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled OPFS special filesystem type: ${String(_ex)}`);
    }
    }
  }

  private async getShard({
    type,
    id,
  }: {
    type: NaidanEncryptedCollectionTypeDto,
    id: string,
  }): Promise<string> {
    return await this.objectStore.getLogicalShard({
      locator: { namespace: `collection_member/${type}`, key: id },
    });
  }

  private async assertIdsForShard({
    type,
    ids,
    shard,
    fieldName,
  }: {
    type: NaidanEncryptedCollectionTypeDto,
    ids: string[],
    shard: string,
    fieldName: string,
  }): Promise<void> {
    assertUniqueIds({ ids, fieldName });
    for (const id of ids) {
      const actual = await this.getShard({ type, id });
      if (actual !== shard) {
        throw new Error(`${fieldName} contains an ID assigned to ${actual}, expected ${shard}`);
      }
    }
  }

  private async loadManifestWithShard({
    type,
    shard,
  }: {
    type: NaidanEncryptedCollectionTypeDto,
    shard: string,
  }): Promise<NaidanEncryptedStoreManifestDto> {
    const manifest = structuredClone(await this.requireManifest());
    const collection = getCollection({ manifest, type });
    if (!collection.shardIds.includes(shard)) {
      collection.shardIds.push(shard);
      collection.shardIds.sort();
    }
    assertEncryptedStoreManifest({ manifest });
    return manifest;
  }

  private async hydrateAttachments({ nodes }: { nodes: MessageNode[] }): Promise<void> {
    const cache = new Map<string, EncryptedBinaryShardIndexDto>();
    const visit = async ({ items }: { items: MessageNode[] }): Promise<void> => {
      for (const node of items) {
        for (const [index, attachment] of (node.attachments ?? []).entries()) {
          switch (attachment.status) {
          case 'persisted': {
            const rawId = idToRaw({ id: attachment.binaryObjectId });
            const shard = await this.getShard({ type: 'binary_object', id: rawId });
            let shardIndex = cache.get(shard);
            if (shardIndex === undefined) {
              shardIndex = await this.loadBinaryShard({ shard });
              cache.set(shard, shardIndex);
            }
            const metadata = shardIndex.objects[rawId];
            if (metadata === undefined) {
              node.attachments![index] = { ...attachment, status: 'missing' };
            } else {
              attachment.mimeType = metadata.metadata.mimeType;
              attachment.size = metadata.metadata.size;
              attachment.uploadedAt = metadata.metadata.createdAt;
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

  private async loadBinaryShard({ shard }: { shard: string }): Promise<EncryptedBinaryShardIndexDto> {
    if (!await this.hasRegisteredCollectionShard({ type: 'binary_object', shard })) {
      return { objects: {} };
    }
    const index = await this.jsonStore.read({
      locator: { namespace: 'binary_shard_index', key: shard },
      schema: EncryptedBinaryShardIndexSchemaDto,
    });
    if (index === undefined) {
      throw new Error(`Registered encrypted binary shard index is missing: ${shard}`);
    }
    assertBinaryShardIndex({ index });
    await this.assertIdsForShard({
      type: 'binary_object',
      ids: Object.keys(index.objects),
      shard,
      fieldName: 'Binary object shard index',
    });
    return index;
  }

  private async loadChatMetaShard({ shard }: { shard: string }): Promise<EncryptedChatMetaShardIndexDto> {
    if (!await this.hasRegisteredCollectionShard({ type: 'chat_meta', shard })) {
      return { chatIds: [] };
    }
    const index = await this.jsonStore.read({
      locator: { namespace: 'chat_meta_shard_index', key: shard },
      schema: EncryptedChatMetaShardIndexSchemaDto,
    });
    if (index === undefined) {
      throw new Error(`Registered encrypted chat metadata shard index is missing: ${shard}`);
    }
    await this.assertIdsForShard({
      type: 'chat_meta',
      ids: index.chatIds,
      shard,
      fieldName: 'Chat metadata shard index',
    });
    return index;
  }

  private async loadChatGroupShard({ shard }: { shard: string }): Promise<EncryptedChatGroupShardIndexDto> {
    if (!await this.hasRegisteredCollectionShard({ type: 'chat_group', shard })) {
      return { chatGroupIds: [] };
    }
    const index = await this.jsonStore.read({
      locator: { namespace: 'chat_group_shard_index', key: shard },
      schema: EncryptedChatGroupShardIndexSchemaDto,
    });
    if (index === undefined) {
      throw new Error(`Registered encrypted chat group shard index is missing: ${shard}`);
    }
    await this.assertIdsForShard({
      type: 'chat_group',
      ids: index.chatGroupIds,
      shard,
      fieldName: 'Chat group shard index',
    });
    return index;
  }

  private async hasRegisteredCollectionShard({
    type,
    shard,
  }: {
    type: NaidanEncryptedCollectionTypeDto,
    shard: string,
  }): Promise<boolean> {
    const manifest = await this.requireManifest();
    return getCollection({ manifest, type }).shardIds.includes(shard);
  }

  private async requireManifest(): Promise<NaidanEncryptedStoreManifestDto> {
    const manifest = await this.loadManifest();
    if (manifest === undefined) {
      throw new Error('Encrypted store manifest is missing');
    }
    return manifest;
  }

  private async loadManifest(): Promise<NaidanEncryptedStoreManifestDto | undefined> {
    const manifest = await this.jsonStore.read({
      locator: { namespace: 'singleton', key: 'store_manifest' },
      schema: NaidanEncryptedStoreManifestSchemaDto,
    });
    if (manifest !== undefined) {
      assertEncryptedStoreManifest({ manifest });
    }
    return manifest;
  }

  private async saveManifest({ manifest }: { manifest: NaidanEncryptedStoreManifestDto }): Promise<void> {
    assertEncryptedStoreManifest({ manifest });
    await this.jsonStore.write({
      locator: { namespace: 'singleton', key: 'store_manifest' },
      value: manifest,
    });
  }

}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  assertBinaryShardIndex,
  assertEncryptedStoreManifest,
  assertVolumeShardIndex,
};
