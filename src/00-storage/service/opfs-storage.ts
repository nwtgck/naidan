import type { BlobContext } from '@/utils/blob-view';
import { writeReadableStreamToFileHandle } from '@/utils/file-system-stream';
import { iterateAttachmentParts } from './message-attachments';
import { readLegacyUploadedFileMetadata, remapLegacyUploadedFileReferences } from './legacy-uploaded-file-content';
import { createLegacyUploadedFileId } from './legacy-uploaded-file-id';
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
} from '@/00-storage/mapper/mappers';
import { IStorageProvider } from './interface';

import {
  type MigrationStateDto,
  type BinaryShardIndexDto,
  MigrationStateSchemaDto,
  BinaryShardIndexSchemaDto,
} from '@/00-storage/00-dto/dto';
import { toBinaryObjectId, toChatGroupId, toChatId } from '@/01-models/ids';
import { promiseAllKeyed } from '@/utils/promise';

interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>,
}

const MIGRATION_V1_UPLOADED_FILES_TO_BINARY_OBJECTS = 'v1_uploaded_files_to_binary_objects';

type BinaryShardIndex = BinaryShardIndexDto;

/** Byte access failure, not a missing file or an invalid persisted DTO. */
export class OpfsBlobReadError extends Error {
  constructor({ cause }: { cause: unknown }) {
    super('Unable to read OPFS file bytes', { cause });
    this.name = 'OpfsBlobReadError';
  }
}

export class OPFSStorageProvider extends IStorageProvider {
  private root: FileSystemDirectoryHandle | null = null;
  private readonly STORAGE_DIR = 'naidan-storage';
  readonly canPersistBinary: boolean;
  private readonly access: 'read-only' | 'read-write';
  private readonly blobs: BlobContext | undefined;

  constructor({ blobs, access }: {
    blobs?: BlobContext,
    access?: 'read-only' | 'read-write',
  } = {}) {
    super();
    // Borrowed from this provider's owner. Never dispose it or mutate the global
    // storage service: ZIP rollback may still use the same Worker context.
    this.blobs = blobs;
    this.access = access ?? 'read-write';
    switch (this.access) {
    case 'read-only': this.canPersistBinary = false; break;
    case 'read-write': this.canPersistBinary = true; break;
    default: {
      const _ex: never = this.access;
      throw new Error(`Unhandled OPFS access: ${_ex}`);
    }
    }
  }

  private async readFileSnapshot({ handle }: { handle: FileSystemFileHandle }): Promise<File> {
    if (this.blobs === undefined && this.access === 'read-write') return handle.getFile();
    try {
      return await handle.getFile();
    } catch (cause) {
      // The handle has already been found. Failure to obtain its snapshot is
      // not evidence that an index/migration state can be replaced with empty data.
      throw new OpfsBlobReadError({ cause });
    }
  }

  private async readText({ blob }: { blob: Blob }): Promise<string> {
    if (this.blobs === undefined && this.access === 'read-write') return blob.text();
    try {
      return await (this.blobs === undefined ? blob.text() : this.blobs.fromNative({ blob }).text());
    } catch (cause) {
      throw new OpfsBlobReadError({ cause });
    }
  }

  private async writeBlob({ blob, handle }: { blob: Blob, handle: FileSystemFileHandle }): Promise<void> {
    if (this.blobs !== undefined) {
      const source = this.blobs.fromNative({ blob });
      await writeReadableStreamToFileHandle({ source: source.stream(), targetHandle: handle, signal: undefined });
      return;
    }
    // Preserve the existing writer contract for providers without an injected context.
    const writable = await handle.createWritable();
    await writable.write(await blob.arrayBuffer());
    await writable.close();
  }

  /** Read-only is an explicit owner policy, not a replacement for native permissions. */
  private assertWritable(): void {
    switch (this.access) {
    case 'read-write': return;
    case 'read-only': throw new DOMException('OPFS storage is read-only', 'NoModificationAllowedError');
    default: {
      const _ex: never = this.access;
      throw new Error(`Unhandled OPFS access: ${_ex}`);
    }
    }
  }

  private rethrowReadFailure({ error }: { error: unknown }): void {
    if (error instanceof OpfsBlobReadError) throw error;
    switch (this.access) {
    case 'read-write': return; // Preserve legacy optional-record recovery for normal storage owners.
    case 'read-only': throw error; // Absence is handled at lookup, never by swallowing failed iteration/parse.
    default: {
      const _ex: never = this.access;
      throw new Error(`Unhandled OPFS access: ${_ex}`);
    }
    }
  }

  private isMissingEntry({ error }: { error: unknown }): boolean {
    return (error instanceof DOMException || error instanceof Error) && error.name === 'NotFoundError';
  }

  /** Lookups only in a reader; ordinary storage retains its existing create-on-read behavior. */
  private async getReadDirectory({ path }: { path: readonly string[] }): Promise<FileSystemDirectoryHandle | undefined> {
    switch (this.access) {
    case 'read-write': {
      await this.ensureRoot();
      let directory = this.root!;
      for (const name of path) directory = await this.getDir({ name, parent: directory });
      return directory;
    }
    case 'read-only': {
      // Do not cache a missing root: a normal owner can initialize storage later.
      // Re-resolve existing directories as well, rather than retaining removed handles.
      let directory = await navigator.storage.getDirectory();
      for (const name of [this.STORAGE_DIR, ...path]) {
        try {
          directory = await directory.getDirectoryHandle(name);
        } catch (error) {
          if (this.isMissingEntry({ error })) return undefined;
          throw error;
        }
      }
      return directory;
    }
    default: {
      const _ex: never = this.access;
      throw new Error(`Unhandled OPFS access: ${_ex}`);
    }
    }
  }

  private async findReadFile({ directory, name }: {
    directory: FileSystemDirectoryHandle,
    name: string,
  }): Promise<FileSystemFileHandle | undefined> {
    try {
      return await directory.getFileHandle(name);
    } catch (error) {
      if (this.isMissingEntry({ error })) return undefined;
      throw error;
    }
  }

  private async readChatRecord({ directory, id }: {
    directory: 'chat-metas' | 'chat-contents',
    id: ChatId,
  }): Promise<string | null> {
    const dir = await this.getReadDirectory({ path: [directory] });
    if (dir === undefined) return null;
    const fileHandle = await this.findReadFile({ directory: dir, name: `${idToRaw({ id })}.json` });
    if (fileHandle === undefined) return null;
    // An acquired handle that later fails is not permission to overwrite an empty chat.
    const file = await this.readFileSnapshot({ handle: fileHandle });
    return this.readText({ blob: file });
  }

  private async loadUnhydratedChatContent({ id }: { id: ChatId }): Promise<ChatContent | null> {
    const rawContent = await this.readChatRecord({ directory: 'chat-contents', id });
    if (rawContent === null) return null;
    return chatContentToDomain({
      dto: ChatContentSchemaDto.parse(JSON.parse(rawContent)),
    });
  }

  async init(): Promise<void> {
    switch (this.access) {
    case 'read-only':
      // A sysfs mount observes existing data. Only the normal storage owner may
      // migrate legacy attachments, write markers, or initialize an empty store.
      await this.getReadDirectory({ path: [] });
      return;
    case 'read-write':
      await this.ensureRoot();
      await this.runMigrations();
      return;
    default: {
      const _ex: never = this.access;
      throw new Error(`Unhandled OPFS access: ${_ex}`);
    }
    }
  }

  private async ensureRoot(): Promise<void> {
    this.assertWritable();
    if (!this.root) {
      const opfsRoot = await navigator.storage.getDirectory();
      this.root = await opfsRoot.getDirectoryHandle(this.STORAGE_DIR, { create: true });
    }
  }

  private async loadMigrationState(): Promise<MigrationStateDto> {
    try {
      const fileHandle = await this.root!.getFileHandle('migration-state.json');
      const file = await this.readFileSnapshot({ handle: fileHandle });
      return MigrationStateSchemaDto.parse(JSON.parse(await this.readText({ blob: file })));
    } catch (error) {
      if (error instanceof OpfsBlobReadError) throw error;
      return { completedMigrations: [] };
    }
  }

  private async saveMigrationState({ state }: { state: MigrationStateDto }): Promise<void> {
    const fileHandle = await this.root!.getFileHandle('migration-state.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(state));
    await writable.close();
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
    let legacyDir: FileSystemDirectoryHandle;
    try {
      legacyDir = await this.root!.getDirectoryHandle('uploaded-files');
    } catch (error) {
      // Only failure to locate the source directory means migration is unnecessary.
      // A missing file later in the copy/write sequence must not mark success.
      const isNotFound = error instanceof Error && (error.name === 'NotFoundError' || ('code' in error && error.code === 8));
      if (isNotFound) return 'completed';
      throw error;
    }
    try {
      console.log(`[OPFSStorageProvider] Starting migration: ${MIGRATION_V1_UPLOADED_FILES_TO_BINARY_OBJECTS}`);

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
              const file = await this.readFileSnapshot({ handle: entry as FileSystemFileHandle });
              for (const { attachmentId, name, mimeType, createdAt } of readLegacyUploadedFileMetadata({ serialized: await this.readText({ blob: file }) })) {
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
              if (error instanceof OpfsBlobReadError) throw error;
              deferred = true;
              console.warn(`[OPFSStorageProvider] Cannot read legacy attachment metadata: ${entry.name}`, error);
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
          for await (const fileEntry of (attachmentDirEntry as FileSystemDirectoryHandle).values()) {
            const fileKind = fileEntry.kind;
            switch (fileKind) {
            case 'file': {
              const blob = await this.readFileSnapshot({ handle: fileEntry as FileSystemFileHandle });
              const sourceMetadata = metadata.get(attachmentId);
              const recorded = sourceMetadata?.get(fileEntry.name);
              if (sourceMetadata?.has(fileEntry.name) && recorded === undefined) {
                // Retain the source and its references for a later explicit repair.
                continue;
              }
              const newBinaryObjectId = await createLegacyUploadedFileId({ attachmentId, name: fileEntry.name });
              const existing = await this.getBinaryObject({ binaryObjectId: newBinaryObjectId });
              await this.saveFileWithMetadata({
                blob,
                binaryObjectId: newBinaryObjectId,
                name: fileEntry.name,
                mimeType: recorded?.mimeType ?? existing?.mimeType,
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
              const file = await this.readFileSnapshot({ handle: entry as FileSystemFileHandle });
              const rewritten = remapLegacyUploadedFileReferences({
                serialized: await this.readText({ blob: file }),
                binaryObjectIds: idMap,
              });
              if (rewritten.unresolvedReferences > 0) deferred = true;
              if (rewritten.serialized !== undefined) {
                const writable = await (entry as FileSystemFileHandleWithWritable).createWritable();
                try {
                  await writable.write(rewritten.serialized);
                  await writable.close();
                } catch (error) {
                  try {
                    await writable.abort();
                  } catch { /* The original failure remains authoritative. */ }
                  throw error;
                }
              }
            } catch (jsonErr) {
              if (jsonErr instanceof OpfsBlobReadError) throw jsonErr;
              deferred = true;
              console.warn(`[OPFSStorageProvider] Retaining legacy files because chat content could not be migrated: ${entry.name}`, jsonErr);
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
      console.log(`[OPFSStorageProvider] Migration completed: ${MIGRATION_V1_UPLOADED_FILES_TO_BINARY_OBJECTS}`);
      return 'completed';
    } catch (error) {
      console.error(`[OPFSStorageProvider] Migration failed: ${MIGRATION_V1_UPLOADED_FILES_TO_BINARY_OBJECTS}`, error);
      throw error;
    }
  }

  private async getDir({ name, parent }: { name: string, parent?: FileSystemDirectoryHandle }): Promise<FileSystemDirectoryHandle> {
    await this.ensureRoot();
    return await (parent ?? this.root!).getDirectoryHandle(name, { create: true });
  }

  // --- Binary Object Storage (Sharded) ---

  private getBinaryObjectShardPath({ id }: { id: BinaryObjectId }): string {
    return idToRaw({ id }).slice(-2).toLowerCase();
  }

  private async getBinaryObjectsDir(): Promise<FileSystemDirectoryHandle> {
    return await this.getDir({ name: 'binary-objects' });
  }

  private async getShardDir({ shard }: { shard: string }): Promise<FileSystemDirectoryHandle> {
    const baseDir = await this.getBinaryObjectsDir();
    return await this.getDir({ name: shard, parent: baseDir });
  }

  private async loadShardIndex({ shard }: { shard: string }): Promise<BinaryShardIndex> {
    const dir = await this.getReadDirectory({ path: ['binary-objects', shard] });
    if (dir === undefined) return { objects: {} };
    let fileHandle: FileSystemFileHandle;
    try {
      fileHandle = await dir.getFileHandle('index.json');
    } catch (error) {
      if (this.isMissingEntry({ error })) return { objects: {} };
      // Preserve the existing legacy code-only absence convention for writers.
      // Read-only observers require an actual named lookup miss, not arbitrary code 8.
      if (this.access === 'read-write' && (error instanceof DOMException || error instanceof Error)
        && 'code' in error && error.code === 8) return { objects: {} };
      throw error;
    }
    // Invalid or unreadable metadata is not an empty index to overwrite.
    const file = await this.readFileSnapshot({ handle: fileHandle });
    return BinaryShardIndexSchemaDto.parse(JSON.parse(await this.readText({ blob: file })));
  }

  private async saveShardIndex({ shard, index }: { shard: string, index: BinaryShardIndex }): Promise<void> {
    const dir = await this.getShardDir({ shard: shard });
    const fileHandle = await dir.getFileHandle('index.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(index));
    await writable.close();
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

  protected async listChatMetasRaw(): Promise<ChatMetaDto[]> {
    try {
      const dir = await this.getReadDirectory({ path: ['chat-metas'] });
      if (dir === undefined) return [];
      const dtos: ChatMetaDto[] = [];
      for await (const entry of dir.values()) {
        const kind = entry.kind;
        switch (kind) {
        case 'file': {
          if (entry.name.endsWith('.json')) {
            const file = await this.readFileSnapshot({ handle: entry as FileSystemFileHandle });
            dtos.push(ChatMetaSchemaDto.parse(JSON.parse(await this.readText({ blob: file }))));
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
    } catch (error) {
      this.rethrowReadFailure({ error });
      return [];
    }
  }

  protected async listChatGroupsRaw(): Promise<ChatGroupDto[]> {
    try {
      const dir = await this.getReadDirectory({ path: ['chat-groups'] });
      if (dir === undefined) return [];
      const dtos: ChatGroupDto[] = [];
      for await (const entry of dir.values()) {
        const kind = entry.kind;
        switch (kind) {
        case 'file': {
          if (entry.name.endsWith('.json')) {
            const file = await this.readFileSnapshot({ handle: entry as FileSystemFileHandle });
            dtos.push(ChatGroupSchemaDto.parse(JSON.parse(await this.readText({ blob: file }))));
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
    } catch (error) {
      this.rethrowReadFailure({ error });
      return [];
    }
  }

  // --- Hierarchy Management ---

  async loadHierarchy(): Promise<HierarchyDto | null> {
    const root = await this.getReadDirectory({ path: [] });
    if (root === undefined) return { items: [] };
    try {
      const fileHandle = await this.findReadFile({ directory: root, name: 'hierarchy.json' });
      if (fileHandle === undefined) return { items: [] };
      const file = await this.readFileSnapshot({ handle: fileHandle });
      return HierarchySchemaDto.parse(JSON.parse(await this.readText({ blob: file })));
    } catch (error) {
      this.rethrowReadFailure({ error });
      // If file doesn't exist or is invalid, return empty hierarchy
      return { items: [] };
    }
  }

  async saveHierarchy({ hierarchy }: { hierarchy: HierarchyDto }): Promise<void> {
    this.assertWritable();
    await this.ensureRoot();
    const fileHandle = await this.root!.getFileHandle('hierarchy.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(hierarchy));
    await writable.close();
  }

  // --- Persistence Implementation ---

  async saveChatMeta({ meta }: { meta: ChatMeta }): Promise<void> {
    this.assertWritable();
    const dto = chatMetaToDto({ domain: meta });
    ChatMetaSchemaDto.parse(dto);
    const dir = await this.getDir({ name: 'chat-metas' });
    const fileHandle = await dir.getFileHandle(`${idToRaw({ id: meta.id })}.json`, { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(dto));
    await writable.close();
  }

  async saveChatContent({ id, content }: { id: ChatId, content: ChatContent }): Promise<void> {
    this.assertWritable();
    const dto = chatContentToDto({ domain: content });
    ChatContentSchemaDto.parse(dto);
    const dir = await this.getDir({ name: 'chat-contents' });
    const fileHandle = await dir.getFileHandle(`${idToRaw({ id })}.json`, { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(dto));
    await writable.close();
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
    this.assertWritable();
    try {
      const metaDir = await this.getDir({ name: 'chat-metas' });
      const contentDir = await this.getDir({ name: 'chat-contents' });
      await metaDir.removeEntry(`${idToRaw({ id })}.json`);
      await contentDir.removeEntry(`${idToRaw({ id })}.json`);
    } catch { /* ignore */ }
  }

  async saveChatGroup({ chatGroup }: { chatGroup: ChatGroup }): Promise<void> {
    this.assertWritable();
    const dto = chatGroupToDto({ domain: chatGroup });
    ChatGroupSchemaDto.parse(dto);
    const dir = await this.getDir({ name: 'chat-groups' });
    const fileHandle = await dir.getFileHandle(`${idToRaw({ id: chatGroup.id })}.json`, { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(dto));
    await writable.close();
  }

  async loadChatGroup({ id }: { id: ChatGroupId }): Promise<ChatGroup | null> {
    try {
      const dir = await this.getReadDirectory({ path: ['chat-groups'] });
      if (dir === undefined) return null;
      const handle = await this.findReadFile({ directory: dir, name: `${idToRaw({ id })}.json` });
      if (handle === undefined) return null;
      const file = await this.readFileSnapshot({ handle });
      const groupDto = ChatGroupSchemaDto.parse(JSON.parse(await this.readText({ blob: file })));

      const { hierarchy, allMetas } = await promiseAllKeyed({
        hierarchy: this.loadHierarchy(),
        allMetas: this.listChatMetasRaw(),
      });

      const chatMetas = allMetas.map(dto => chatMetaToDomain({ dto }));
      const h = hierarchyToDomain({ dto: hierarchy || { items: [] } });
      return chatGroupToDomain({ dto: groupDto, hierarchy: h, chatMetas });
    } catch (error) {
      this.rethrowReadFailure({ error });
      return null;
    }
  }

  async deleteChatGroup({ id }: { id: ChatGroupId }): Promise<void> {
    this.assertWritable();
    try {
      const dir = await this.getDir({ name: 'chat-groups' });
      await dir.removeEntry(`${idToRaw({ id })}.json`);
    } catch { /* ignore */ }
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

  private async saveFileWithMetadata({ blob, binaryObjectId, name, mimeType, createdAt }: {
    blob: Blob,
    binaryObjectId: BinaryObjectId,
    name: string,
    mimeType: string | undefined,
    createdAt: number,
  }): Promise<void> {
    const shard = this.getBinaryObjectShardPath({ id: binaryObjectId });
    const dir = await this.getShardDir({ shard: shard });

    // Do not touch an existing body if its shard metadata cannot be read safely.
    const index = await this.loadShardIndex({ shard });

    // 1. Write Blob
    const binFileName = `${idToRaw({ id: binaryObjectId })}.bin`;
    const fileHandle = await dir.getFileHandle(binFileName, { create: true }) as FileSystemFileHandleWithWritable;
    await this.writeBlob({ blob, handle: fileHandle });

    // 2. Write Marker
    const markerName = `.${binFileName}.complete`;
    await dir.getFileHandle(markerName, { create: true });

    // 3. Update Index
    index.objects[idToRaw({ id: binaryObjectId })] = {
      id: idToRaw({ id: binaryObjectId }),
      mimeType: mimeType ?? (blob.type || 'application/octet-stream'),
      size: blob.size,
      createdAt,
      name,
    };
    await this.saveShardIndex({ shard: shard, index: index });
  }

  async saveFile({ blob, binaryObjectId, name, mimeType }: {
    blob: Blob,
    binaryObjectId: BinaryObjectId,
    name: string,
    mimeType?: string,
  }): Promise<void> {
    this.assertWritable();
    await this.saveFileWithMetadata({
      blob,
      binaryObjectId,
      name,
      mimeType,
      createdAt: Date.now(),
    });
  }

  async getFile({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<Blob | null> {
    try {
      const shard = this.getBinaryObjectShardPath({ id: binaryObjectId });
      const dir = await this.getReadDirectory({ path: ['binary-objects', shard] });
      if (dir === undefined) return null;
      const rawId = idToRaw({ id: binaryObjectId });
      const fileName = `${rawId}.bin`;
      const markerName = `.${fileName}.complete`;

      // Verify completion marker
      if (await this.findReadFile({ directory: dir, name: markerName }) === undefined) return null;

      const fileHandle = await this.findReadFile({ directory: dir, name: fileName });
      if (fileHandle === undefined) return null;
      const { file, index } = await promiseAllKeyed({
        file: this.readFileSnapshot({ handle: fileHandle }),
        index: this.loadShardIndex({ shard: shard }),
      });
      const mimeType = index.objects[rawId]?.mimeType;

      return mimeType === undefined || mimeType === file.type
        ? file
        : file.slice(0, file.size, mimeType);
    } catch (e) {
      this.rethrowReadFailure({ error: e });
      console.error('Failed to get file from OPFS storage:', e);
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
      this.rethrowReadFailure({ error: e });
      console.error('Failed to get binary object info:', e);
      return null;
    }
  }

  async hasAttachments(): Promise<boolean> {
    try {
      const baseDir = await this.getReadDirectory({ path: ['binary-objects'] });
      if (baseDir === undefined) return false;
      for await (const entry of baseDir.values()) {
        const kind = entry.kind;
        switch (kind) {
        case 'directory': {
          // Check if shard has any files other than index.json
          for await (const shardEntry of (entry as FileSystemDirectoryHandle).values()) {
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
    } catch (error) {
      this.rethrowReadFailure({ error });
      return false;
    }
  }

  async *listBinaryObjects(): AsyncIterable<BinaryObject> {
    // Root access errors have never been an empty-list recovery condition.
    if (await this.getReadDirectory({ path: [] }) === undefined) return;
    try {
      const baseDir = await this.getReadDirectory({ path: ['binary-objects'] });
      if (baseDir === undefined) return;
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
      this.rethrowReadFailure({ error: e });
      console.error('[OPFSStorageProvider] Failed to list binary objects', e);
    }
  }

  async deleteBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<void> {
    this.assertWritable();
    await this.ensureRoot();
    const shard = this.getBinaryObjectShardPath({ id: binaryObjectId });
    const dir = await this.getShardDir({ shard: shard });
    const fileName = `${idToRaw({ id: binaryObjectId })}.bin`;
    const markerName = `.${fileName}.complete`;

    try {
      await dir.removeEntry(fileName);
    } catch { /* ignore */ }
    try {
      await dir.removeEntry(markerName);
    } catch { /* ignore */ }

    const index = await this.loadShardIndex({ shard: shard });
    if (index.objects[idToRaw({ id: binaryObjectId })]) {
      delete index.objects[idToRaw({ id: binaryObjectId })];
      await this.saveShardIndex({ shard: shard, index: index });
    }
  }

  async saveSettings({ settings }: { settings: Settings }): Promise<void> {
    this.assertWritable();
    await this.ensureRoot();
    const dto = settingsToDto({ domain: settings });
    const validated = SettingsSchemaDto.parse(dto);
    const fileHandle = await this.root!.getFileHandle('settings.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(validated));
    await writable.close();
  }

  async loadSettings(): Promise<Settings | null> {
    const root = await this.getReadDirectory({ path: [] });
    if (root === undefined) return null;
    try {
      const fileHandle = await this.findReadFile({ directory: root, name: 'settings.json' });
      if (fileHandle === undefined) return null;
      const file = await this.readFileSnapshot({ handle: fileHandle });
      return settingsToDomain({ dto: SettingsSchemaDto.parse(JSON.parse(await this.readText({ blob: file }))) });
    } catch (error) {
      this.rethrowReadFailure({ error });
      return null;
    }
  }

  async clearAll(): Promise<void> {
    this.assertWritable();
    await this.ensureRoot();
    for await (const key of this.root!.keys()) {
      await this.root!.removeEntry(key, { recursive: true });
    }
  }

  // --- Migration Implementation ---

  async dump(): Promise<StorageSnapshot> {
    await this.getReadDirectory({ path: [] });
    const { settings, hierarchy, rawMetas, rawGroups } = await promiseAllKeyed({
      settings: this.loadSettings(),
      hierarchy: this.loadHierarchy(),
      rawMetas: this.listChatMetasRaw(),
      rawGroups: this.listChatGroupsRaw(),
    });

    const h = hierarchyToDomain({ dto: hierarchy || { items: [] } });
    const chatGroups = rawGroups.map(dto => chatGroupToDomain({ dto, hierarchy: h, chatMetas: [] }));
    const chatMetas = rawMetas.map(dto => chatMetaToDomain({ dto }));

    const contentStream = async function* (this: OPFSStorageProvider): AsyncGenerator<MigrationChunkDto> {
      // 1. Stream all chats
      for (const meta of rawMetas) {
        const chat = await this.loadChat({ id: toChatId({ raw: meta.id }) });
        if (chat) {
          yield { type: 'chat' as const, data: chatToDto({ domain: chat }) };
        }
      }

      // 2. Stream all binary objects directly from storage (independent of chat references)
      // Existing index read failures must abort export instead of finalizing a
      // partial backup. Only a missing index is handled by loadShardIndex.
      const baseDir = await this.getReadDirectory({ path: ['binary-objects'] });
      if (baseDir === undefined) return;
      for await (const shardEntry of baseDir.values()) {
        const kind = shardEntry.kind;
        switch (kind) {
        case 'directory': {
          const shard = shardEntry.name;
          const index = await this.loadShardIndex({ shard: shard });
          for (const bId of Object.keys(index.objects)) {
            const meta = index.objects[bId]!;
            const blob = await this.getFile({ binaryObjectId: toBinaryObjectId({ raw: bId }) });
            if (blob) {
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
    this.assertWritable();
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
        await this.saveFileWithMetadata({
          blob: chunk.blob,
          binaryObjectId: toBinaryObjectId({ raw: chunk.id }),
          name: chunk.name,
          mimeType: chunk.mimeType,
          createdAt: chunk.createdAt,
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

  private readonly hostVolumeDB = new HostVolumeDB();

  private getVolumeShardPath({ id }: { id: VolumeId }): string {
    return idToRaw({ id }).slice(-2).toLowerCase();
  }

  private async getVolumesBaseDir(): Promise<FileSystemDirectoryHandle> {
    return await this.getDir({ name: 'volumes' });
  }

  private async getVolumeShardDir({ shard }: { shard: string }): Promise<FileSystemDirectoryHandle> {
    const baseDir = await this.getVolumesBaseDir();
    return await this.getDir({ name: shard, parent: baseDir });
  }

  private async loadVolumeShardIndex({ shard }: { shard: string }): Promise<VolumeIndexDto> {
    try {
      const dir = await this.getReadDirectory({ path: ['volumes', shard] });
      if (dir === undefined) return { volumes: {} };
      const fileHandle = await this.findReadFile({ directory: dir, name: 'index.json' });
      if (fileHandle === undefined) return { volumes: {} };
      const file = await this.readFileSnapshot({ handle: fileHandle });
      return VolumeIndexSchemaDto.parse(JSON.parse(await this.readText({ blob: file })));
    } catch (error) {
      this.rethrowReadFailure({ error });
      return { volumes: {} };
    }
  }

  private async saveVolumeShardIndex({ shard, index }: { shard: string, index: VolumeIndexDto }): Promise<void> {
    const dir = await this.getVolumeShardDir({ shard });
    const fileHandle = await dir.getFileHandle('index.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(index));
    await writable.close();
  }

  private async copyDirectory({ source, destination }: { source: FileSystemDirectoryHandle, destination: FileSystemDirectoryHandle }): Promise<void> {
    for await (const entry of source.values()) {
      switch (entry.kind) {
      case 'file': {
        const file = await this.readFileSnapshot({ handle: entry as FileSystemFileHandle });
        const destFile = await destination.getFileHandle(entry.name, { create: true }) as FileSystemFileHandleWithWritable;
        await this.writeBlob({ blob: file, handle: destFile });
        break;
      }
      case 'directory': {
        const newDestSubDir = await destination.getDirectoryHandle(entry.name, { create: true });
        await this.copyDirectory({ source: entry as FileSystemDirectoryHandle, destination: newDestSubDir });
        break;
      }
      default: {
        const _ex: never = entry;
        throw new Error(`Unhandled entry kind: ${(_ex as { kind: string }).kind}`);
      }
      }
    }
  }

  async *listVolumes(): AsyncIterable<Volume> {
    // Root access errors have never been an empty-list recovery condition.
    if (await this.getReadDirectory({ path: [] }) === undefined) return;
    try {
      const baseDir = await this.getReadDirectory({ path: ['volumes'] });
      if (baseDir === undefined) return;
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
      this.rethrowReadFailure({ error: e });
      console.error('[OPFSStorageProvider] Failed to list volumes', e);
    }
  }

  async createVolume({ name, type, sourceHandle }: {
    name: string,
    type: VolumeType,
    sourceHandle: FileSystemDirectoryHandle,
  }): Promise<Volume> {
    this.assertWritable();
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
    this.assertWritable();
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

      const fileHandle = await currentDir.getFileHandle(fileName, { create: true }) as FileSystemFileHandleWithWritable;
      await this.writeBlob({ blob: file, handle: fileHandle });

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

  async getVolumeDirectoryHandle({ volumeId }: { volumeId: VolumeId }): Promise<FileSystemDirectoryHandle | null> {
    // A native directory handle carries mutation authority (and host lookup can
    // initialize IndexedDB). A read-only provider exposes data, not these handles.
    this.assertWritable();
    try {
      const shard = this.getVolumeShardPath({ id: volumeId });
      const index = await this.loadVolumeShardIndex({ shard });
      const volume = index.volumes[idToRaw({ id: volumeId })];

      if (!volume) return null;

      switch (volume.type) {
      case 'opfs': {
        const shardDir = await this.getVolumeShardDir({ shard });
        return await shardDir.getDirectoryHandle(idToRaw({ id: volumeId }));
      }
      case 'host':
        return await this.hostVolumeDB.get({ id: idToRaw({ id: volumeId }) }) || null;
      default: {
        const _ex: never = volume;
        throw new Error(`Unhandled volume type: ${JSON.stringify(_ex)}`);
      }
      }
    } catch (e) {
      if (e instanceof OpfsBlobReadError) throw e;
      console.error('Failed to get volume directory handle:', e);
      return null;
    }
  }

  async renameVolume({ volumeId, name }: { volumeId: VolumeId, name: string }): Promise<void> {
    this.assertWritable();
    const shard = this.getVolumeShardPath({ id: volumeId });
    const index = await this.loadVolumeShardIndex({ shard });
    const volume = index.volumes[idToRaw({ id: volumeId })];
    if (!volume) throw new Error(`Volume not found: ${idToRaw({ id: volumeId })}`);
    index.volumes[idToRaw({ id: volumeId })] = { ...volume, name };
    await this.saveVolumeShardIndex({ shard, index });
  }

  async deleteVolume({ volumeId }: { volumeId: VolumeId }): Promise<void> {
    this.assertWritable();
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
      if (e instanceof OpfsBlobReadError) throw e;
      console.error('Failed to delete volume:', e);
    }
  }
}

class HostVolumeDB {
  private readonly DB_NAME = 'naidan-volumes';
  private readonly STORE_NAME = 'handles';

  async put({ id, handle }: { id: string, handle: FileSystemDirectoryHandle }): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const req = store.put(handle, id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async get({ id }: { id: string }): Promise<FileSystemDirectoryHandle | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async delete({ id }: { id: string }): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          db.createObjectStore(this.STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
