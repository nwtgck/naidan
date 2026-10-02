import { iterateAttachmentParts } from '@/00-storage/service/message-attachments';
import { readLegacyUploadedFileMetadata, remapLegacyUploadedFileReferences } from '@/00-storage/service/legacy-uploaded-file-content';
import { createLegacyUploadedFileId } from '@/00-storage/service/legacy-uploaded-file-id';
import { generateId } from '@/01-models/id';
import { idToRaw } from '@/01-models/ids';
import type { BinaryObjectId, ChatGroupId, ChatId, VolumeId } from '@/01-models/ids';
import type { Chat, Settings, ChatGroup, SidebarItem, MessageNode, ChatMeta, ChatContent, StorageSnapshot, BinaryObject, Volume, VolumeType } from '@/01-models/types';
import {
  type ChatMetaDto,
  type ChatGroupDto,
  type HierarchyDto,
  type MigrationChunkDto,
  ChatMetaSchemaDto,
  ChatGroupSchemaDto,
  SettingsSchemaDto,
  HierarchySchemaDto,
  ChatContentSchemaDto,
  type VolumeDto,
  type VolumeIndexDto,
  VolumeIndexSchemaDto,
} from '@/00-storage/00-dto/dto';
import {
  chatToDomain,
  chatToDto,
  chatGroupToDomain,
  chatGroupToDto,
  settingsToDomain,
  settingsToDto,
  hierarchyToDomain,
  hierarchyToDto,
  chatMetaToDto,
  chatMetaToDomain,
  chatContentToDto,
  chatContentToDomain,
  buildSidebarItemsFromHierarchy,
  binaryObjectToDomain,
  volumeToDomain,
  volumeToDto,
} from '@/00-storage/mapper/mappers';
import { IStorageProvider } from '@/00-storage/service/interface';
import {
  getNaidanOpfsSpecialFileSystemDirectoryName,
  NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
} from '@/00-storage/service/opfs/naidan-opfs-root-directory-registry';
import type { StorageDirectoryHandle } from '@/00-storage/service/storage-file-system/types';
import {
  NaidanOpfsLayoutDirectoryHandle,
  type NaidanOpfsLayoutFileHandle,
} from './layout-handle';

import {
  type MigrationStateDto,
  type BinaryShardIndexDto,
  MigrationStateSchemaDto,
  BinaryShardIndexSchemaDto,
} from '@/00-storage/00-dto/dto';
import { toBinaryObjectId, toChatGroupId, toChatId } from '@/01-models/ids';
import { promiseAllKeyed } from '@/utils/promise';
import {
  createBlobStorageBinaryObjectReadHandle,
  materializeStorageBinaryObjectAsBlob,
  openStorageBinaryObjectWriteSourceStream,
  runWithStorageBinaryObjectReadHandleClose,
} from '@/00-storage/service/binary-object-io';
import type {
  StorageBinaryObjectReadHandle,
  StorageBinaryObjectWriteSource,
} from '@/00-storage/service/binary-object-io';
import type { StorageVolumeAccess } from '@/00-storage/service/volume-access';
import { HostVolumeDB } from '@/00-storage/service/opfs/host-volume-db';
import type { OpfsSpecialFileSystemType } from '@/00-storage/service/opfs/opfs-transition-backend';
import {
  copyStorageDirectory,
  createDirectStorageDirectoryTransferSource,
  createStorageDirectoryTransferSource,
  createStorageFileSystemDirectoryTransferTarget,
} from '@/00-storage/service/storage-directory-transfer';
import { writeStorageReadableStream } from '@/00-storage/service/storage-file-system/io';

const MIGRATION_V1_UPLOADED_FILES_TO_BINARY_OBJECTS = 'v1_uploaded_files_to_binary_objects';

const PLAIN_STORAGE_ENTRY_NAMES = new Set([
  'settings.json',
  'hierarchy.json',
  'chat-metas',
  'chat-contents',
  'chat-groups',
  'binary-objects',
  'volumes',
  'migration-state.json',
  'uploaded-files',
]);

const ENCRYPTION_CONTROL_ENTRY_NAMES = new Set([
  'encryption-state',
  'encrypted-stores',
]);

type BinaryShardIndex = BinaryShardIndexDto;

function isNotFoundError({ error }: { error: unknown }): boolean {
  return error instanceof DOMException
    ? error.name === 'NotFoundError'
    : error instanceof Error
      && (error.name === 'NotFoundError'
        || error.message.startsWith('NotFoundError')
        || ('code' in error && error.code === 8));
}

async function ignoreMissingStorageEntry({ operation }: {
  operation: () => Promise<void>;
}): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!isNotFoundError({ error })) {
      throw error;
    }
  }
}

async function writeLayoutText({ fileHandle, value }: {
  fileHandle: NaidanOpfsLayoutFileHandle;
  value: string;
}): Promise<void> {
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(value);
    await writable.close();
  } catch (cause: unknown) {
    try {
      await writable.abort({ reason: cause });
    } catch (cleanupCause: unknown) {
      throw new AggregateError([cause, cleanupCause], 'layout text write and cleanup both failed');
    }
    throw cause;
  }
}

function blobSlicePosition({ position, size }: { position: number; size: number }): number {
  const integer = Number.isNaN(position) ? 0 : Math.trunc(position);
  return integer < 0 ? Math.max(size + integer, 0) : Math.min(integer, size);
}

function binaryObjectReader({ handle, mimeType }: {
  handle: StorageBinaryObjectReadHandle;
  mimeType: string;
}): StorageBinaryObjectReadHandle {
  const close = () => handle.close();
  switch (handle.backing.type) {
  case 'direct_blob':
    return { ...createBlobStorageBinaryObjectReadHandle({ blob: handle.backing.blob, mimeType }), close };
  case 'reader_only': break;
  default: {
    const _ex: never = handle.backing;
    throw new Error(`Unhandled binary object read backing: ${String(_ex)}`);
  }
  }

  // Preserve this adapter's Blob ranges without changing the filesystem's exact-range reads.
  const size = handle.size;
  return {
    backing: { type: 'reader_only' }, size, mimeType, close,
    async read({ buffer, offset, length, position, signal }) {
      signal?.throwIfAborted();
      const end = Math.min(position + length, size);
      if (end <= position || length <= 0) return { bytesRead: 0 };
      const start = blobSlicePosition({ position, size });
      const sliceEnd = blobSlicePosition({ position: end, size });
      const destinationOffset = Math.trunc(offset);
      if (destinationOffset < 0 || destinationOffset > buffer.byteLength) {
        throw new RangeError('read destination offset exceeds the supplied buffer');
      }
      const boundedLength = Math.max(0, Math.min(sliceEnd - start, buffer.byteLength - destinationOffset));
      if (boundedLength === 0) return { bytesRead: 0 };
      return await handle.read({ buffer, offset: destinationOffset, length: boundedLength, position: start, signal });
    },
    stream({ start, end, signal }) {
      signal?.throwIfAborted();
      const sliceStart = blobSlicePosition({ position: start, size });
      const sliceEnd = end === undefined ? size : blobSlicePosition({ position: end, size });
      return handle.stream({ start: sliceStart, end: Math.max(sliceStart, sliceEnd), signal });
    },
  };
}

export class NaidanOpfsStorageBackend extends IStorageProvider {
  constructor({ namespaceRoot, hostVolumeDB }: {
    namespaceRoot: StorageDirectoryHandle;
    hostVolumeDB: HostVolumeDB;
  }) {
    super();
    this.namespaceRoot = namespaceRoot;
    this.hostVolumeDB = hostVolumeDB;
  }

  private readonly namespaceRoot: StorageDirectoryHandle;
  private root: NaidanOpfsLayoutDirectoryHandle | undefined;
  readonly canPersistBinary = true;

  private async readChatRecord({ directory, id }: {
    directory: 'chat-metas' | 'chat-contents',
    id: ChatId,
  }): Promise<string | null> {
    await this.ensureRoot();
    const dir = await this.getDir({ name: directory });
    let fileHandle: NaidanOpfsLayoutFileHandle;
    try {
      fileHandle = await dir.getFileHandle(`${idToRaw({ id })}.json`);
    } catch (error) {
      // Only a missing entry at lookup means absence. An acquired handle that
      // later fails to read must never let an updater overwrite an empty chat.
      if (isNotFoundError({ error })) return null;
      throw error;
    }
    const file = await fileHandle.getFile();
    return file.text();
  }

  private async loadUnhydratedChatContent({ id }: { id: ChatId }): Promise<ChatContent | null> {
    const rawContent = await this.readChatRecord({ directory: 'chat-contents', id });
    if (rawContent === null) return null;
    return chatContentToDomain({
      dto: ChatContentSchemaDto.parse(JSON.parse(rawContent)),
    });
  }

  async init(): Promise<void> {
    await this.ensureRoot();
    await this.runMigrations();
  }

  private async ensureRoot(): Promise<void> {
    if (this.root === undefined) {
      this.root = new NaidanOpfsLayoutDirectoryHandle({
        handle: await this.namespaceRoot.getDirectoryHandle({
          name: NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
          create: true,
        }),
      });
    }
  }

  private async loadMigrationState(): Promise<MigrationStateDto> {
    try {
      const fileHandle = await this.root!.getFileHandle('migration-state.json');
      const file = await fileHandle.getFile();
      return MigrationStateSchemaDto.parse(JSON.parse(await file.text()));
    } catch {
      return { completedMigrations: [] };
    }
  }

  private async saveMigrationState({ state }: { state: MigrationStateDto }): Promise<void> {
    const fileHandle = await this.root!.getFileHandle('migration-state.json', { create: true }) as NaidanOpfsLayoutFileHandle;
    await writeLayoutText({ fileHandle, value: JSON.stringify(state) });
  }

  private async runMigrations(): Promise<void> {
    const state = await this.loadMigrationState();
    const completed = new Set(state.completedMigrations.map(m => m.name));

    if (!completed.has(MIGRATION_V1_UPLOADED_FILES_TO_BINARY_OBJECTS)) {
      const outcome = await this.migrateV1UploadedFilesToBinaryObjects();
      // Unreadable or unwritten content may still reference the legacy directory.
      // Leave it retryable while allowing unrelated readable chats to be used.
      switch (outcome) {
      case 'deferred': return;
      case 'completed': break;
      default: {
        const _ex: never = outcome;
        throw new Error(`Unhandled migration outcome: ${_ex}`);
      }
      }
      state.completedMigrations.push({
        name: MIGRATION_V1_UPLOADED_FILES_TO_BINARY_OBJECTS,
        completedAt: Date.now(),
      });
      await this.saveMigrationState({ state });
    }
  }

  private async migrateV1UploadedFilesToBinaryObjects(): Promise<'completed' | 'deferred'> {
    let legacyDir: NaidanOpfsLayoutDirectoryHandle;
    try {
      legacyDir = await this.root!.getDirectoryHandle('uploaded-files');
    } catch (error) {
      // Only failure to locate the source directory means migration is unnecessary.
      // A missing file later in the copy/write sequence must not mark success.
      if (isNotFoundError({ error })) return 'completed';
      throw error;
    }
    try {
      console.log(`[NaidanOpfsStorageBackend] Starting migration: ${MIGRATION_V1_UPLOADED_FILES_TO_BINARY_OBJECTS}`);

      // Read one document at a time; keep only metadata, not all conversation bodies.
      const contentDir = await this.getDir({ name: 'chat-contents' });
      const metadata = new Map<string, Map<string, { mimeType: string, createdAt: number } | undefined>>();
      let deferred = false;
      for await (const entry of contentDir.values()) {
        const entryKind = entry.kind;
        switch (entryKind) {
        case 'file':
          if (entry.name.endsWith('.json')) {
            try {
              const file = await (entry as NaidanOpfsLayoutFileHandle).getFile();
              for (const { attachmentId, name, mimeType, createdAt } of readLegacyUploadedFileMetadata({ serialized: await file.text() })) {
                let files = metadata.get(attachmentId);
                if (!files) {
                  files = new Map(); metadata.set(attachmentId, files);
                }
                const previous = files.get(name);
                if (files.has(name) && (previous?.mimeType !== mimeType || previous.createdAt !== createdAt)) {
                  // One binary index cannot preserve contradictory legacy metadata.
                  files.set(name, undefined);
                  deferred = true;
                } else {
                  files.set(name, { mimeType, createdAt });
                }
              }
            } catch (error) {
              deferred = true;
              console.warn(`[NaidanOpfsStorageBackend] Cannot read legacy attachment metadata: ${entry.name}`, error);
            }
          }
          break;
        case 'directory': deferred = true; break;
        default: {
          const _ex: never = entryKind;
          throw new Error(`Unhandled content entry: ${_ex}`);
        }
        }
      }

      // 1. Copy each source file to a stable migration ID before changing references.
      const idMap = new Map<string, Map<string, string>>();

      for await (const attachmentDirEntry of legacyDir.values()) {
        const entryKind = attachmentDirEntry.kind;
        switch (entryKind) {
        case 'directory': {
          const attachmentId = attachmentDirEntry.name;
          for await (const fileEntry of (attachmentDirEntry as NaidanOpfsLayoutDirectoryHandle).values()) {
            const fileKind = fileEntry.kind;
            switch (fileKind) {
            case 'file': {
              const blob = await (fileEntry as NaidanOpfsLayoutFileHandle).getFile();
              const sourceMetadata = metadata.get(attachmentId);
              const recorded = sourceMetadata?.get(fileEntry.name);
              if (sourceMetadata?.has(fileEntry.name) && recorded === undefined) {
                // Retain the source and its references for a later explicit repair.
                continue;
              }
              const newBinaryObjectId = await createLegacyUploadedFileId({ attachmentId, name: fileEntry.name });
              const existing = await this.getBinaryObject({ binaryObjectId: newBinaryObjectId });
              await this.writeBinaryObject({
                source: { type: 'direct_blob', blob },
                binaryObjectId: newBinaryObjectId,
                name: fileEntry.name,
                mimeType: recorded?.mimeType ?? existing?.mimeType ?? (blob.type || 'application/octet-stream'),
                size: blob.size,
                signal: undefined,
                createdAt: recorded?.createdAt ?? existing?.createdAt ?? Date.now(),
              });
              let files = idMap.get(attachmentId);
              if (!files) {
                files = new Map(); idMap.set(attachmentId, files);
              }
              files.set(fileEntry.name, idToRaw({ id: newBinaryObjectId }));
              break;
            }
            case 'directory':
              deferred = true;
              break;
            default: {
              const _ex: never = fileKind;
              throw new Error(`Unhandled file kind: ${_ex}`);
            }
            }
          }
          break;
        }
        case 'file':
          deferred = true;
          break;
        default: {
          const _ex: never = entryKind;
          throw new Error(`Unhandled entry kind: ${_ex}`);
        }
        }
      }

      // 2. Reread current content and rewrite only references whose copies succeeded.
      for await (const entry of contentDir.values()) {
        const entryKind = entry.kind;
        switch (entryKind) {
        case 'file': {
          if (entry.name.endsWith('.json')) {
            try {
              const file = await (entry as NaidanOpfsLayoutFileHandle).getFile();
              const rewritten = remapLegacyUploadedFileReferences({
                serialized: await file.text(),
                binaryObjectIds: idMap,
              });
              if (rewritten.unresolvedReferences > 0) deferred = true;
              if (rewritten.serialized !== undefined) {
                const writable = await (entry as NaidanOpfsLayoutFileHandle).createWritable();
                try {
                  await writable.write(rewritten.serialized);
                  await writable.close();
                } catch (error) {
                  try {
                    await writable.abort({ reason: error });
                  } catch { /* The original failure remains authoritative. */ }
                  throw error;
                }
              }
            } catch (jsonErr) {
              deferred = true;
              console.warn(`[NaidanOpfsStorageBackend] Retaining legacy files because chat content could not be migrated: ${entry.name}`, jsonErr);
            }
          }
          break;
        }
        case 'directory':
          deferred = true;
          break;
        default: {
          const _ex: never = entryKind;
          throw new Error(`Unhandled entry kind: ${_ex}`);
        }
        }
      }

      // Do not delete a directory that may still be needed by failed documents.
      if (deferred) return 'deferred';

      // 3. Cleanup, after every inspected chat reference was committed.
      await this.root!.removeEntry('uploaded-files', { recursive: true });
      console.log(`[NaidanOpfsStorageBackend] Migration completed: ${MIGRATION_V1_UPLOADED_FILES_TO_BINARY_OBJECTS}`);
      return 'completed';
    } catch (error) {
      console.error(`[NaidanOpfsStorageBackend] Migration failed: ${MIGRATION_V1_UPLOADED_FILES_TO_BINARY_OBJECTS}`, error);
      throw error;
    }
  }

  private async getDir({ name, parent = this.root! }: { name: string, parent?: NaidanOpfsLayoutDirectoryHandle }): Promise<NaidanOpfsLayoutDirectoryHandle> {
    await this.ensureRoot();
    return await parent.getDirectoryHandle(name, { create: true });
  }

  // --- Binary Object Storage (Sharded) ---

  private getBinaryObjectShardPath({ id }: { id: BinaryObjectId }): string {
    return idToRaw({ id }).slice(-2).toLowerCase();
  }

  private async getBinaryObjectsDir(): Promise<NaidanOpfsLayoutDirectoryHandle> {
    return await this.getDir({ name: 'binary-objects' });
  }

  private async getShardDir({ shard }: { shard: string }): Promise<NaidanOpfsLayoutDirectoryHandle> {
    const baseDir = await this.getBinaryObjectsDir();
    return await this.getDir({ name: shard, parent: baseDir });
  }

  private async loadShardIndex({ shard }: { shard: string }): Promise<BinaryShardIndex> {
    const dir = await this.getShardDir({ shard });
    let fileHandle: NaidanOpfsLayoutFileHandle;
    try {
      fileHandle = await dir.getFileHandle('index.json');
    } catch (error) {
      if (isNotFoundError({ error })) return { objects: {} };
      throw error;
    }
    const file = await fileHandle.getFile();
    return BinaryShardIndexSchemaDto.parse(JSON.parse(await file.text()));
  }

  private async saveShardIndex({ shard, index }: { shard: string, index: BinaryShardIndex }): Promise<void> {
    const dir = await this.getShardDir({ shard: shard });
    const fileHandle = await dir.getFileHandle('index.json', { create: true }) as NaidanOpfsLayoutFileHandle;
    await writeLayoutText({ fileHandle, value: JSON.stringify(index) });
  }

  private async hydrateAttachments({ nodes }: { nodes: MessageNode[] }): Promise<void> {
    const shardCache = new Map<string, BinaryShardIndex>();

    for (const part of iterateAttachmentParts({ nodes })) {
      const att = part.attachment;
      switch (att.status) {
      case 'persisted': {
        const shard = this.getBinaryObjectShardPath({ id: att.binaryObjectId });
        let index = shardCache.get(shard);
        if (!index) {
          index = await this.loadShardIndex({ shard });
          shardCache.set(shard, index);
        }
        const meta = index.objects[idToRaw({ id: att.binaryObjectId })];
        if (meta) {
          att.mimeType = meta.mimeType;
          att.size = meta.size;
          att.uploadedAt = meta.createdAt;
        } else {
          part.attachment = { ...att, status: 'missing' };
        }
        break;
      }
      case 'memory':
      case 'missing':
        break;
      default: {
        const _ex: never = att;
        throw new Error(`Unhandled attachment status: ${_ex}`);
      }
      }
    }
  }

  // --- Internal Data Access ---

  async listChatMetasRaw(): Promise<ChatMetaDto[]> {
    try {
      const dir = await this.getDir({ name: 'chat-metas' });
      const dtos: ChatMetaDto[] = [];
      for await (const entry of dir.values()) {
        const kind = entry.kind;
        switch (kind) {
        case 'file': {
          if (entry.name.endsWith('.json')) {
            const file = await (entry as NaidanOpfsLayoutFileHandle).getFile();
            dtos.push(ChatMetaSchemaDto.parse(JSON.parse(await file.text())));
          }
          break;
        }
        case 'directory':
          break;
        default: {
          const _ex: never = kind;
          throw new Error(`Unhandled entry kind: ${_ex}`);
        }
        }
      }
      return dtos;
    } catch {
      return [];
    }
  }

  async listChatGroupsRaw(): Promise<ChatGroupDto[]> {
    try {
      const dir = await this.getDir({ name: 'chat-groups' });
      const dtos: ChatGroupDto[] = [];
      for await (const entry of dir.values()) {
        const kind = entry.kind;
        switch (kind) {
        case 'file': {
          if (entry.name.endsWith('.json')) {
            const file = await (entry as NaidanOpfsLayoutFileHandle).getFile();
            dtos.push(ChatGroupSchemaDto.parse(JSON.parse(await file.text())));
          }
          break;
        }
        case 'directory':
          break;
        default: {
          const _ex: never = kind;
          throw new Error(`Unhandled entry kind: ${_ex}`);
        }
        }
      }
      return dtos;
    } catch {
      return [];
    }
  }

  // --- Hierarchy Management ---

  async loadHierarchy(): Promise<HierarchyDto | null> {
    await this.ensureRoot();
    try {
      const fileHandle = await this.root!.getFileHandle('hierarchy.json');
      const file = await fileHandle.getFile();
      return HierarchySchemaDto.parse(JSON.parse(await file.text()));
    } catch {
      // If file doesn't exist or is invalid, return empty hierarchy
      return { items: [] };
    }
  }

  async saveHierarchy({ hierarchy }: { hierarchy: HierarchyDto }): Promise<void> {
    await this.ensureRoot();
    const fileHandle = await this.root!.getFileHandle('hierarchy.json', { create: true }) as NaidanOpfsLayoutFileHandle;
    await writeLayoutText({ fileHandle, value: JSON.stringify(hierarchy) });
  }

  // --- Persistence Implementation ---

  async saveChatMeta({ meta }: { meta: ChatMeta }): Promise<void> {
    const dto = chatMetaToDto({ domain: meta });
    ChatMetaSchemaDto.parse(dto);
    const dir = await this.getDir({ name: 'chat-metas' });
    const fileHandle = await dir.getFileHandle(`${idToRaw({ id: meta.id })}.json`, { create: true }) as NaidanOpfsLayoutFileHandle;
    await writeLayoutText({ fileHandle, value: JSON.stringify(dto) });
  }

  async saveChatContent({ id, content }: { id: ChatId, content: ChatContent }): Promise<void> {
    const dto = chatContentToDto({ domain: content });
    ChatContentSchemaDto.parse(dto);
    const dir = await this.getDir({ name: 'chat-contents' });
    const fileHandle = await dir.getFileHandle(`${idToRaw({ id })}.json`, { create: true }) as NaidanOpfsLayoutFileHandle;
    await writeLayoutText({ fileHandle, value: JSON.stringify(dto) });
  }

  async loadChat({ id }: { id: ChatId }): Promise<Chat | null> {
    const rawMeta = await this.readChatRecord({ directory: 'chat-metas', id });
    const rawContent = await this.readChatRecord({ directory: 'chat-contents', id });
    const meta = rawMeta === null ? null : ChatMetaSchemaDto.parse(JSON.parse(rawMeta));
    const content = rawContent === null ? null : ChatContentSchemaDto.parse(JSON.parse(rawContent));
    if (meta === null || content === null) return null;

    const chat = chatToDomain({ dto: { ...meta, ...content, experimental: meta.experimental, messages: undefined } });

    // Resolve groupId from hierarchy
    const hierarchy = await this.loadHierarchy();
    if (hierarchy) {
      const group = hierarchy.items.find(i => i.type === 'chat_group' && i.chat_ids.includes(idToRaw({ id })));
      if (group) chat.groupId = toChatGroupId({ raw: group.id });
    }

    // Hydrate attachments with metadata from BinaryObject indices
    await this.hydrateAttachments({ nodes: chat.root.items });

    return chat;
  }

  async loadChatMeta({ id }: { id: ChatId }): Promise<ChatMeta | null> {
    const rawMeta = await this.readChatRecord({ directory: 'chat-metas', id });
    if (rawMeta === null) return null;
    const meta = chatMetaToDomain({ dto: ChatMetaSchemaDto.parse(JSON.parse(rawMeta)) });

    // Resolve groupId from hierarchy
    const hierarchy = await this.loadHierarchy();
    if (hierarchy) {
      const group = hierarchy.items.find(i => i.type === 'chat_group' && i.chat_ids.includes(idToRaw({ id })));
      if (group) meta.groupId = toChatGroupId({ raw: group.id });
    }

    return meta;
  }

  async loadChatContent({ id }: { id: ChatId }): Promise<ChatContent | null> {
    const content = await this.loadUnhydratedChatContent({ id });
    if (content === null) return null;

    await this.hydrateAttachments({ nodes: content.root.items });
    return content;
  }

  async loadChatContentWithoutAttachments({ id }: { id: ChatId }): Promise<ChatContent | null> {
    return this.loadUnhydratedChatContent({ id });
  }

  async deleteChat({ id }: { id: ChatId }): Promise<void> {
    const fileName = `${idToRaw({ id })}.json`;
    await ignoreMissingStorageEntry({ operation: async () => {
      const metaDir = await this.getDir({ name: 'chat-metas' });
      await metaDir.removeEntry(fileName);
    } });
    await ignoreMissingStorageEntry({ operation: async () => {
      const contentDir = await this.getDir({ name: 'chat-contents' });
      await contentDir.removeEntry(fileName);
    } });
  }

  async saveChatGroup({ chatGroup }: { chatGroup: ChatGroup }): Promise<void> {
    const dto = chatGroupToDto({ domain: chatGroup });
    ChatGroupSchemaDto.parse(dto);
    const dir = await this.getDir({ name: 'chat-groups' });
    const fileHandle = await dir.getFileHandle(`${idToRaw({ id: chatGroup.id })}.json`, { create: true }) as NaidanOpfsLayoutFileHandle;
    await writeLayoutText({ fileHandle, value: JSON.stringify(dto) });
  }

  async loadChatGroup({ id }: { id: ChatGroupId }): Promise<ChatGroup | null> {
    try {
      const dir = await this.getDir({ name: 'chat-groups' });
      const file = await (await dir.getFileHandle(`${idToRaw({ id })}.json`)).getFile();
      const groupDto = ChatGroupSchemaDto.parse(JSON.parse(await file.text()));

      const { hierarchy, allMetas } = await promiseAllKeyed({
        hierarchy: this.loadHierarchy(),
        allMetas: this.listChatMetasRaw(),
      });

      const chatMetas = allMetas.map(dto => chatMetaToDomain({ dto }));
      const h = hierarchyToDomain({ dto: hierarchy || { items: [] } });
      return chatGroupToDomain({ dto: groupDto, hierarchy: h, chatMetas });
    } catch {
      return null;
    }
  }

  async deleteChatGroup({ id }: { id: ChatGroupId }): Promise<void> {
    await ignoreMissingStorageEntry({ operation: async () => {
      const dir = await this.getDir({ name: 'chat-groups' });
      await dir.removeEntry(`${idToRaw({ id })}.json`);
    } });
  }

  public override async getSidebarStructure(): Promise<SidebarItem[]> {
    const { rawHierarchy, rawMetas, rawGroups } = await promiseAllKeyed({
      rawHierarchy: this.loadHierarchy(),
      rawMetas: this.listChatMetasRaw(),
      rawGroups: this.listChatGroupsRaw(),
    });

    const hierarchy = hierarchyToDomain({ dto: rawHierarchy || { items: [] } });
    const chatMetas = rawMetas.map(dto => chatMetaToDomain({ dto }));
    const chatGroups = rawGroups.map(dto => chatGroupToDomain({ dto, hierarchy, chatMetas }));

    return buildSidebarItemsFromHierarchy({ hierarchy, chatMetas, chatGroups });
  }

  // --- Binary Object Storage ---

  async writeBinaryObject({ source, binaryObjectId, name, mimeType, size, createdAt, signal }: {
    source: StorageBinaryObjectWriteSource,
    binaryObjectId: BinaryObjectId,
    name: string,
    mimeType: string,
    size: number,
    createdAt: number,
    signal: AbortSignal | undefined,
  }): Promise<void> {
    const shard = this.getBinaryObjectShardPath({ id: binaryObjectId });
    const dir = await this.getShardDir({ shard });
    const binFileName = `${idToRaw({ id: binaryObjectId })}.bin`;
    // Validate existing metadata before creating or replacing the binary body.
    const index = await this.loadShardIndex({ shard });
    const fileHandle = await dir.getFileHandle(binFileName, { create: true });
    const stream = openStorageBinaryObjectWriteSourceStream({ source });

    await writeStorageReadableStream({
      fileHandle: fileHandle.handle,
      source: stream,
      expectedSize: size,
      signal,
      onBytesWritten: undefined,
    });

    const persistedFile = await fileHandle.handle.stat();
    if (persistedFile.size !== size) {
      throw new Error(`Binary object size mismatch: expected ${size}, wrote ${persistedFile.size}`);
    }

    const markerName = `.${binFileName}.complete`;
    await dir.getFileHandle(markerName, { create: true });

    index.objects[idToRaw({ id: binaryObjectId })] = {
      id: idToRaw({ id: binaryObjectId }),
      mimeType,
      size,
      createdAt,
      name,
    };
    await this.saveShardIndex({ shard, index });
  }

  async openBinaryObject({ binaryObjectId }: {
    binaryObjectId: BinaryObjectId,
  }): Promise<StorageBinaryObjectReadHandle | null> {
    let readable: StorageBinaryObjectReadHandle | undefined;
    try {
      const shard = this.getBinaryObjectShardPath({ id: binaryObjectId });
      const dir = await this.getShardDir({ shard });
      const rawId = idToRaw({ id: binaryObjectId });
      const fileName = `${rawId}.bin`;
      await dir.getFileHandle(`.${fileName}.complete`);

      const fileHandle = await dir.getFileHandle(fileName);
      // Resolve metadata before acquiring a live reader so an index failure cannot orphan it.
      const index = await this.loadShardIndex({ shard });
      readable = await fileHandle.handle.openReadable({ mimeType: 'application/octet-stream' });
      return binaryObjectReader({ handle: readable, mimeType: index.objects[rawId]?.mimeType ?? readable.mimeType });
    } catch (error) {
      let failure: unknown = error;
      if (readable !== undefined) {
        try {
          await readable.close();
        } catch (closeFailure: unknown) {
          failure = new AggregateError([error, closeFailure], 'Binary object open and reader cleanup both failed');
        }
      }
      console.error('Failed to open file from OPFS storage:', failure);
      return null;
    }
  }

  async getBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<BinaryObject | null> {
    try {
      const shard = this.getBinaryObjectShardPath({ id: binaryObjectId });
      const index = await this.loadShardIndex({ shard: shard });
      const dto = index.objects[idToRaw({ id: binaryObjectId })];
      return dto === undefined ? null : binaryObjectToDomain({ dto });
    } catch (e) {
      console.error('Failed to get binary object info:', e);
      return null;
    }
  }

  async hasAttachments(): Promise<boolean> {
    try {
      const baseDir = await this.getBinaryObjectsDir();
      for await (const entry of baseDir.values()) {
        const kind = entry.kind;
        switch (kind) {
        case 'directory': {
          // Check if shard has any files other than index.json
          for await (const shardEntry of (entry as NaidanOpfsLayoutDirectoryHandle).values()) {
            if (shardEntry.name !== 'index.json') return true;
          }
          break;
        }
        case 'file':
          break;
        default: {
          const _ex: never = kind;
          throw new Error(`Unhandled entry kind: ${_ex}`);
        }
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async *listBinaryObjects(): AsyncIterable<BinaryObject> {
    await this.ensureRoot();
    try {
      const baseDir = await this.getBinaryObjectsDir();
      for await (const shardEntry of baseDir.values()) {
        const kind = shardEntry.kind;
        switch (kind) {
        case 'directory': {
          const index = await this.loadShardIndex({ shard: shardEntry.name });
          for (const obj of Object.values(index.objects)) {
            yield binaryObjectToDomain({ dto: obj });
          }
          break;
        }
        case 'file':
          break;
        default: {
          const _ex: never = kind;
          throw new Error(`Unhandled entry kind: ${_ex}`);
        }
        }
      }
    } catch (e) {
      console.error('[NaidanOpfsStorageBackend] Failed to list binary objects', e);
    }
  }

  async deleteBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<void> {
    await this.ensureRoot();
    const shard = this.getBinaryObjectShardPath({ id: binaryObjectId });
    const dir = await this.getShardDir({ shard: shard });
    const fileName = `${idToRaw({ id: binaryObjectId })}.bin`;
    const markerName = `.${fileName}.complete`;

    await ignoreMissingStorageEntry({ operation: async () => {
      await dir.removeEntry(fileName);
    } });
    await ignoreMissingStorageEntry({ operation: async () => {
      await dir.removeEntry(markerName);
    } });

    const index = await this.loadShardIndex({ shard: shard });
    if (index.objects[idToRaw({ id: binaryObjectId })]) {
      delete index.objects[idToRaw({ id: binaryObjectId })];
      await this.saveShardIndex({ shard: shard, index: index });
    }
  }

  async saveSettings({ settings }: { settings: Settings }): Promise<void> {
    await this.ensureRoot();
    const dto = settingsToDto({ domain: settings });
    const validated = SettingsSchemaDto.parse(dto);
    const fileHandle = await this.root!.getFileHandle('settings.json', { create: true }) as NaidanOpfsLayoutFileHandle;
    await writeLayoutText({ fileHandle, value: JSON.stringify(validated) });
  }

  async loadSettings(): Promise<Settings | null> {
    await this.ensureRoot();
    try {
      const fileHandle = await this.root!.getFileHandle('settings.json');
      const file = await fileHandle.getFile();
      return settingsToDomain({ dto: SettingsSchemaDto.parse(JSON.parse(await file.text())) });
    } catch {
      return null;
    }
  }

  async removeSettingsForTransition(): Promise<void> {
    await this.ensureRoot();
    try {
      await this.root!.removeEntry('settings.json');
    } catch (error) {
      const isNotFound = error instanceof DOMException
        ? error.name === 'NotFoundError'
        : error instanceof Error && error.name === 'NotFoundError';
      if (!isNotFound) {
        throw error;
      }
    }
  }

  async clearAll(): Promise<void> {
    await this.ensureRoot();
    for await (const key of this.root!.keys()) {
      await this.root!.removeEntry(key, { recursive: true });
    }
  }

  // --- Migration Implementation ---

  async dump(): Promise<StorageSnapshot> {
    await this.ensureRoot();
    const { settings, hierarchy, rawMetas, rawGroups } = await promiseAllKeyed({
      settings: this.loadSettings(),
      hierarchy: this.loadHierarchy(),
      rawMetas: this.listChatMetasRaw(),
      rawGroups: this.listChatGroupsRaw(),
    });

    const h = hierarchyToDomain({ dto: hierarchy || { items: [] } });
    const chatGroups = rawGroups.map(dto => chatGroupToDomain({ dto, hierarchy: h, chatMetas: [] }));
    const chatMetas = rawMetas.map(dto => chatMetaToDomain({ dto }));

    const contentStream = async function* (this: NaidanOpfsStorageBackend): AsyncGenerator<MigrationChunkDto> {
      // 1. Stream all chats
      for (const meta of rawMetas) {
        const chat = await this.loadChat({ id: toChatId({ raw: meta.id }) });
        if (chat) {
          yield { type: 'chat' as const, data: chatToDto({ domain: chat }) };
        }
      }

      // 2. Stream all binary objects directly from storage (independent of chat references)
      // Existing index or stream failures must not finalize a partial backup.
      const baseDir = await this.getBinaryObjectsDir();
      for await (const shardEntry of baseDir.values()) {
        const kind = shardEntry.kind;
        switch (kind) {
        case 'directory': {
          const shard = shardEntry.name;
          const index = await this.loadShardIndex({ shard: shard });
          for (const bId of Object.keys(index.objects)) {
            const meta = index.objects[bId]!;
            const handle = await this.openBinaryObject({
              binaryObjectId: toBinaryObjectId({ raw: bId }),
            });
            if (handle === null) {
              continue;
            }

            const blob = await runWithStorageBinaryObjectReadHandleClose({
              handle,
              operation: async () => await materializeStorageBinaryObjectAsBlob({ handle }),
            });
            yield {
              type: 'binary_object' as const,
              id: bId,
              name: meta.name ?? 'file',
              mimeType: meta.mimeType,
              size: meta.size,
              createdAt: meta.createdAt,
              blob,
            };
          }
          break;
        }
        case 'file':
          break;
        default: {
          const _ex: never = kind;
          throw new Error(`Unhandled entry kind: ${_ex}`);
        }
        }
      }
    };

    return {
      structure: {
        settings: settings || {
          titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
          providerProfiles: [],
          mounts: [],
          storageType: 'opfs',
          endpoint: { type: 'openai', url: '' },
        } satisfies Settings,
        hierarchy: h,
        chatMetas,
        chatGroups,
      },
      contentStream: contentStream.call(this),
    };
  }

  async restore({ snapshot }: { snapshot: StorageSnapshot }): Promise<void> {
    const { structure, contentStream } = snapshot;
    await this.ensureRoot();

    // 1. Restore Structural Metadata
    if (structure.settings) await this.saveSettings({ settings: structure.settings });
    if (structure.hierarchy) await this.saveHierarchy({ hierarchy: hierarchyToDto({ domain: structure.hierarchy }) });
    if (structure.chatMetas) {
      for (const meta of structure.chatMetas) await this.saveChatMeta({ meta });
    }
    if (structure.chatGroups) {
      for (const group of structure.chatGroups) await this.saveChatGroup({ chatGroup: group });
    }

    // 2. Restore Heavy Content
    for await (const chunk of contentStream) {
      const type = chunk.type;
      switch (type) {
      case 'chat': {
        const domainChat = chatToDomain({ dto: chunk.data });
        await this.saveChatContent({ id: domainChat.id, content: domainChat });
        await this.saveChatMeta({ meta: domainChat });
        break;
      }
      case 'binary_object':
        await this.writeBinaryObject({
          source: { type: 'direct_blob', blob: chunk.blob },
          binaryObjectId: toBinaryObjectId({ raw: chunk.id }),
          name: chunk.name,
          mimeType: chunk.mimeType,
          size: chunk.size,
          createdAt: chunk.createdAt,
          signal: undefined,
        });
        break;
      default: {
        const _ex: never = type;
        throw new Error(`Unknown chunk type: ${_ex}`);
      }
      }
    }
  }

  // --- Volume Management ---

  private readonly hostVolumeDB: HostVolumeDB;

  private getVolumeShardPath({ id }: { id: VolumeId }): string {
    return idToRaw({ id }).slice(-2).toLowerCase();
  }

  private async getVolumesBaseDir(): Promise<NaidanOpfsLayoutDirectoryHandle> {
    return await this.getDir({ name: 'volumes' });
  }

  private async getVolumeShardDir({ shard }: { shard: string }): Promise<NaidanOpfsLayoutDirectoryHandle> {
    const baseDir = await this.getVolumesBaseDir();
    return await this.getDir({ name: shard, parent: baseDir });
  }

  private async loadVolumeShardIndex({ shard }: { shard: string }): Promise<VolumeIndexDto> {
    try {
      const dir = await this.getVolumeShardDir({ shard });
      const fileHandle = await dir.getFileHandle('index.json');
      const file = await fileHandle.getFile();
      return VolumeIndexSchemaDto.parse(JSON.parse(await file.text()));
    } catch {
      return { volumes: {} };
    }
  }

  private async saveVolumeShardIndex({ shard, index }: { shard: string, index: VolumeIndexDto }): Promise<void> {
    const dir = await this.getVolumeShardDir({ shard });
    const fileHandle = await dir.getFileHandle('index.json', { create: true }) as NaidanOpfsLayoutFileHandle;
    await writeLayoutText({ fileHandle, value: JSON.stringify(index) });
  }

  private async copyDirectory({ source, destination }: {
    source: FileSystemDirectoryHandle;
    destination: NaidanOpfsLayoutDirectoryHandle;
  }): Promise<void> {
    await copyStorageDirectory({
      source: createDirectStorageDirectoryTransferSource({ root: source }),
      target: createStorageFileSystemDirectoryTransferTarget({ root: destination.handle }),
      signal: undefined,
    });
  }

  async *listVolumes(): AsyncIterable<Volume> {
    await this.ensureRoot();
    try {
      const baseDir = await this.getVolumesBaseDir();
      for await (const shardEntry of baseDir.values()) {
        switch (shardEntry.kind) {
        case 'directory': {
          const index = await this.loadVolumeShardIndex({ shard: shardEntry.name });
          for (const volDto of Object.values(index.volumes)) {
            yield volumeToDomain({ dto: volDto });
          }
          break;
        }
        case 'file':
          break;
        default: {
          throw new Error(`Unhandled entry kind: ${((shardEntry satisfies never) as { readonly kind: string }).kind}`);
        }
        }
      }
    } catch (e) {
      console.error('[NaidanOpfsStorageBackend] Failed to list volumes', e);
    }
  }

  async createVolume({ name, type, sourceHandle }: {
    name: string,
    type: VolumeType,
    sourceHandle: FileSystemDirectoryHandle,
  }): Promise<Volume> {
    const id = generateId<VolumeId>();
    const createdAt = Date.now();
    const shard = this.getVolumeShardPath({ id });

    let volumeDto: VolumeDto;

    switch (type) {
    case 'opfs': {
      const shardDir = await this.getVolumeShardDir({ shard });
      const volumeDir = await shardDir.getDirectoryHandle(idToRaw({ id }), { create: true });
      await this.copyDirectory({ source: sourceHandle, destination: volumeDir });

      volumeDto = {
        type: 'opfs',
        id: idToRaw({ id }),
        name,
        createdAt,
      };
      break;
    }
    case 'host': {
      await this.hostVolumeDB.put({ id: idToRaw({ id }), handle: sourceHandle });
      volumeDto = {
        type: 'host',
        id: idToRaw({ id }),
        name,
        createdAt,
      };
      break;
    }
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled volume type: ${(_ex as { type: string }).type}`);
    }
    }

    const index = await this.loadVolumeShardIndex({ shard });
    index.volumes[idToRaw({ id })] = volumeDto;
    await this.saveVolumeShardIndex({ shard, index });

    return volumeToDomain({ dto: volumeDto });
  }

  async createVolumeFromFiles({ name, entries, onProgress, signal }: {
    name: string,
    entries: Array<{ file: File, relativePath: string }>,
    onProgress?: ({ processed, total }: { processed: number, total: number }) => void,
    signal?: AbortSignal,
  }): Promise<Volume> {
    const id = generateId<VolumeId>();
    const createdAt = Date.now();
    const shard = this.getVolumeShardPath({ id });

    const shardDir = await this.getVolumeShardDir({ shard });
    const volumeDir = await shardDir.getDirectoryHandle(idToRaw({ id }), { create: true });

    for (let i = 0; i < entries.length; i++) {
      if (signal?.aborted) {
        await shardDir.removeEntry(idToRaw({ id }), { recursive: true }).catch(() => {});
        throw new DOMException('Cancelled by user', 'AbortError');
      }

      const entry = entries[i];
      if (!entry) continue;
      const { file, relativePath } = entry;
      const pathParts = relativePath.split('/').filter(Boolean);

      const fileName = pathParts.pop()!;
      let currentDir = volumeDir;

      for (const part of pathParts) {
        currentDir = await currentDir.getDirectoryHandle(part, { create: true });
      }

      const fileHandle = await currentDir.getFileHandle(fileName, { create: true }) as NaidanOpfsLayoutFileHandle;
      await writeStorageReadableStream({
        fileHandle: fileHandle.handle,
        source: file.stream(),
        expectedSize: file.size,
        signal,
        onBytesWritten: undefined,
      });

      if (onProgress) {
        onProgress({ processed: i + 1, total: entries.length });
      }
    }

    const volumeDto: VolumeDto = {
      type: 'opfs',
      id: idToRaw({ id }),
      name,
      createdAt,
    };

    const index = await this.loadVolumeShardIndex({ shard });
    index.volumes[idToRaw({ id })] = volumeDto;
    await this.saveVolumeShardIndex({ shard, index });

    return volumeToDomain({ dto: volumeDto });
  }

  async openVolume({ volumeId }: { volumeId: VolumeId }): Promise<StorageVolumeAccess | null> {
    try {
      const shard = this.getVolumeShardPath({ id: volumeId });
      const index = await this.loadVolumeShardIndex({ shard });
      const volume = index.volumes[idToRaw({ id: volumeId })];

      if (!volume) return null;

      switch (volume.type) {
      case 'opfs': {
        const shardDir = await this.getVolumeShardDir({ shard });
        return {
          type: 'storage_directory',
          handle: (await shardDir.getDirectoryHandle(idToRaw({ id: volumeId }))).handle,
        };
      }
      case 'host': {
        const handle = await this.hostVolumeDB.get({ id: idToRaw({ id: volumeId }) });
        return handle === undefined
          ? null
          : { type: 'direct_directory', handle };
      }
      default: {
        const _ex: never = volume;
        throw new Error(`Unhandled volume type: ${JSON.stringify(_ex)}`);
      }
      }
    } catch (e) {
      console.error('Failed to get volume directory handle:', e);
      return null;
    }
  }

  async renameVolume({ volumeId, name }: { volumeId: VolumeId, name: string }): Promise<void> {
    const shard = this.getVolumeShardPath({ id: volumeId });
    const index = await this.loadVolumeShardIndex({ shard });
    const volume = index.volumes[idToRaw({ id: volumeId })];
    if (!volume) throw new Error(`Volume not found: ${idToRaw({ id: volumeId })}`);
    index.volumes[idToRaw({ id: volumeId })] = { ...volume, name };
    await this.saveVolumeShardIndex({ shard, index });
  }

  async deleteVolume({ volumeId }: { volumeId: VolumeId }): Promise<void> {
    const shard = this.getVolumeShardPath({ id: volumeId });

    try {
      const index = await this.loadVolumeShardIndex({ shard });
      const volume = index.volumes[idToRaw({ id: volumeId })];

      if (volume) {
        switch (volume.type) {
        case 'opfs': {
          const shardDir = await this.getVolumeShardDir({ shard });
          await shardDir.removeEntry(idToRaw({ id: volumeId }), { recursive: true });
          break;
        }
        case 'host':
          await this.hostVolumeDB.delete({ id: idToRaw({ id: volumeId }) });
          break;
        default: {
          const _ex: never = volume;
          throw new Error(`Unhandled volume type: ${JSON.stringify(_ex)}`);
        }
        }

        delete index.volumes[idToRaw({ id: volumeId })];
        await this.saveVolumeShardIndex({ shard, index });
      }
    } catch (e) {
      console.error('Failed to delete volume:', e);
    }
  }

  async assertEncryptionTransitionSupported(): Promise<void> {
    await this.ensureRoot();
    const unsupportedEntries: string[] = [];
    for await (const name of this.root!.keys()) {
      if (
        PLAIN_STORAGE_ENTRY_NAMES.has(name)
        || ENCRYPTION_CONTROL_ENTRY_NAMES.has(name)
      ) {
        continue;
      }
      unsupportedEntries.push(name);
    }
    if (unsupportedEntries.length > 0) {
      unsupportedEntries.sort();
      throw new Error(
        `OPFS storage contains entries that this encryption format cannot migrate: ${unsupportedEntries.join(', ')}`,
      );
    }
  }

  async clearPlainDataForTransition(): Promise<void> {
    await this.ensureRoot();
    for (const name of PLAIN_STORAGE_ENTRY_NAMES) {
      try {
        await this.root!.removeEntry(name, { recursive: true });
      } catch (error) {
        const notFound = error instanceof DOMException
          ? error.name === 'NotFoundError'
          : error instanceof Error && error.message.startsWith('NotFoundError');
        if (!notFound) {
          throw error;
        }
      }
    }
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
    await this.ensureRoot();
    const rawId = idToRaw({ id: volume.id });
    const shard = this.getVolumeShardPath({ id: volume.id });
    switch (volume.type) {
    case 'host': {
      switch (sourceAccess.type) {
      case 'direct_directory':
        await this.hostVolumeDB.put({ id: rawId, handle: sourceAccess.handle });
        break;
      case 'storage_directory':
        throw new Error('Host volume transition source must be a direct directory');
      default: {
        const _ex: never = sourceAccess;
        throw new Error(`Unhandled host volume source: ${((_ex satisfies never) as { readonly type: string }).type}`);
      }
      }
      break;
    }
    case 'opfs': {
      const shardDirectory = await this.getVolumeShardDir({ shard });
      await shardDirectory.removeEntry(rawId, { recursive: true }).catch(() => {});
      const targetDirectory = await shardDirectory.getDirectoryHandle(rawId, { create: true });
      await copyStorageDirectory({
        source: await createStorageDirectoryTransferSource({ access: sourceAccess }),
        target: createStorageFileSystemDirectoryTransferTarget({ root: targetDirectory.handle }),
        signal,
      });
      break;
    }
    default:
      throw new Error(`Unhandled transition volume type: ${String(volume.type)}`);
    }
    const index = await this.loadVolumeShardIndex({ shard });
    index.volumes[rawId] = volumeToDto({ domain: volume });
    await this.saveVolumeShardIndex({ shard, index });
  }

  async openSpecialFileSystemForTransition({
    type,
    create,
  }: {
    type: OpfsSpecialFileSystemType,
    create: boolean,
  }): Promise<StorageVolumeAccess | null> {
    const name = getNaidanOpfsSpecialFileSystemDirectoryName({ type });
    try {
      return {
        type: 'storage_directory',
        handle: await this.namespaceRoot.getDirectoryHandle({ name, create }),
      };
    } catch (error) {
      const notFound = error instanceof DOMException
        ? error.name === 'NotFoundError'
        : error instanceof Error && error.message.startsWith('NotFoundError');
      if (!create && notFound) {
        return null;
      }
      throw error;
    }
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
    const rootDirectory = (() => {
      switch (rootAccess.type) {
      case 'storage_directory':
        return rootAccess.handle;
      case 'direct_directory':
        throw new Error('Naidan OPFS namespace returned an incompatible directory access');
      default: {
        const _ex: never = rootAccess;
        throw new Error(`Unhandled storage volume access: ${((_ex satisfies never) as { readonly type: string }).type}`);
      }
      }
    })();
    let directory = rootDirectory;
    for (const segment of this.getSpecialFileSystemPathSegments({ path })) {
      try {
        directory = await directory.getDirectoryHandle({ name: segment, create });
      } catch (error) {
        const notFound = error instanceof DOMException
          ? error.name === 'NotFoundError'
          : error instanceof Error && error.message.startsWith('NotFoundError');
        if (!create && notFound) {
          return null;
        }
        throw error;
      }
    }
    return {
      type: 'storage_directory',
      handle: directory,
    };
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
    const segments = this.getSpecialFileSystemPathSegments({ path });
    if (segments.length === 0) {
      throw new Error('Removing a special filesystem root requires removeSpecialFileSystemForTransition()');
    }
    const rootAccess = await this.openSpecialFileSystemForTransition({ type, create: false });
    if (rootAccess === null) {
      return;
    }
    const rootDirectory = (() => {
      switch (rootAccess.type) {
      case 'storage_directory':
        return rootAccess.handle;
      case 'direct_directory':
        throw new Error('Naidan OPFS namespace returned an incompatible directory access');
      default: {
        const _ex: never = rootAccess;
        throw new Error(`Unhandled storage volume access: ${((_ex satisfies never) as { readonly type: string }).type}`);
      }
      }
    })();
    let parent = rootDirectory;
    for (const segment of segments.slice(0, -1)) {
      try {
        parent = await parent.getDirectoryHandle({ name: segment, create: false });
      } catch (error) {
        const notFound = error instanceof DOMException
          ? error.name === 'NotFoundError'
          : error instanceof Error && error.message.startsWith('NotFoundError');
        if (notFound) {
          return;
        }
        throw error;
      }
    }
    try {
      await parent.removeEntry({ name: segments.at(-1)!, recursive });
    } catch (error) {
      const notFound = error instanceof DOMException
        ? error.name === 'NotFoundError'
        : error instanceof Error && error.message.startsWith('NotFoundError');
      if (!notFound) {
        throw error;
      }
    }
  }

  async removeSpecialFileSystemForTransition({
    type,
  }: {
    type: OpfsSpecialFileSystemType,
  }): Promise<void> {
    try {
      await this.namespaceRoot.removeEntry({
        name: getNaidanOpfsSpecialFileSystemDirectoryName({ type }),
        recursive: true,
      });
    } catch (error) {
      const notFound = error instanceof DOMException
        ? error.name === 'NotFoundError'
        : error instanceof Error && error.message.startsWith('NotFoundError');
      if (!notFound) {
        throw error;
      }
    }
  }

  private getSpecialFileSystemPathSegments({
    path,
  }: {
    path: string,
  }): string[] {
    const segments = path.split('/').filter(segment => segment.length > 0);
    for (const segment of segments) {
      if (segment === '.' || segment === '..' || segment.includes('\0')) {
        throw new Error(`Invalid OPFS special filesystem path: ${path}`);
      }
    }
    return segments;
  }

}


// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
