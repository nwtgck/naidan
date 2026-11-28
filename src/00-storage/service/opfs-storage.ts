import { indexedDbRequestSuccessHandles } from './indexed-db';
import { buildChatGroup, buildSidebarItemsFromHierarchy } from './sidebar-items';
import type { FileLocation } from '@/00-format/file-record';
import type { StoredChatMeta, StoredChatGroup } from '@/00-format/core-records';
import { openDirectoryPath } from '@/utils/file-system-directory-path';
import { indexedDbFormat, opfsFormat, storageMigrations } from '@/00-format/01-layout/layout';
import type { LegacyUploadedFileMetadata } from '@/00-format/migrations/legacy-uploaded-file-content';
import { type ExperimentalModelGraphRegistryDto } from '@/00-format/00-dto/experimental-model-graph.dto';
import { iterateAttachmentParts } from './message-attachments';
import { generateId } from '@/01-models/id';
import { idToRaw } from '@/01-models/ids';
import type { BinaryObjectId, ChatGroupId, ChatId, VolumeId } from '@/01-models/ids';
import { DEFAULT_SETTINGS_ENDPOINT, type Chat, type Settings, type ChatGroup, type SidebarItem, type MessageNode, type ChatMeta, type ChatContent, type StorageSnapshot, type BinaryObject, type Hierarchy, type Volume, type VolumeType } from '@/01-models/types';
import {
  type MigrationChunkDto,
} from '@/00-format/00-dto/dto';
import {
  chatToDomain,
  chatToDto,
} from '@/00-format/mapper/mappers';
import { IStorageProvider } from './interface';

import { toBinaryObjectId } from '@/01-models/ids';
import { promiseAllKeyed } from '@/utils/promise';
import { type ExperimentalNaidanRpcRegistryDto } from '@/00-format/00-dto/experimental-naidan-rpc.dto';
import type { StoredVolumeAccess } from '@/01-models/volume-access';
import type { StorageSynchronizer } from './synchronizer';

interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>,
}

let volumeSynchronizer: StorageSynchronizer | undefined;

async function getVolumeSynchronizer(): Promise<StorageSynchronizer> {
  const { StorageSynchronizer } = await import('./synchronizer');
  volumeSynchronizer ??= new StorageSynchronizer();
  return volumeSynchronizer;
}

function isEntryNotFound({ error }: { error: unknown }): boolean {
  return (error instanceof Error || error instanceof DOMException) && error.name === 'NotFoundError';
}

export class OPFSStorageProvider extends IStorageProvider {
  private root: FileSystemDirectoryHandle | null = null;
  readonly canPersistBinary = true;

  async readNaidanRpcRegistryForTransfer(): Promise<ExperimentalNaidanRpcRegistryDto | undefined> {
    return opfsFormat.storage.experimental.rpcConnections.readForTransfer({ readText: this.readRegistryText });
  }

  async writeNaidanRpcRegistryForTransfer({ registry }: { registry: ExperimentalNaidanRpcRegistryDto | undefined }): Promise<void> {
    await opfsFormat.storage.experimental.rpcConnections.writeForTransfer({
      registry,
      writeText: this.writeRegistryText,
      removeFile: this.deleteRegistry,
    });
  }

  async readModelGraphRegistryForTransfer(): Promise<ExperimentalModelGraphRegistryDto | undefined> {
    return opfsFormat.storage.experimental.modelGraph.readForTransfer({ readText: this.readRegistryText });
  }

  async writeModelGraphRegistryForTransfer({ registry }: { registry: ExperimentalModelGraphRegistryDto | undefined }): Promise<void> {
    await opfsFormat.storage.experimental.modelGraph.writeForTransfer({
      registry,
      writeText: this.writeRegistryText,
      removeFile: this.deleteRegistry,
    });
  }

  private readRegistryText = async ({ file }: { file: FileLocation }): Promise<string | undefined> => {
    const directory = await this.getRegistryDirectory({ file, create: false });
    if (directory === undefined) {
      return undefined;
    }
    return this.readDirectoryFileText({ directory, name: file.name });
  };

  private deleteRegistry = async ({ file }: { file: FileLocation }): Promise<void> => {
    const directory = await this.getRegistryDirectory({ file, create: false });
    if (directory === undefined) {
      return;
    }
    try {
      await directory.removeEntry(file.name);
    } catch (error) {
      if (!isEntryNotFound({ error })) {
        throw error;
      }
    }
  };

  private writeRegistryText = async ({ file, text }: { file: FileLocation, text: string }): Promise<void> => {
    const directory = await this.getRegistryDirectory({ file, create: true });
    if (directory === undefined) {
      throw new Error('Experimental storage directory is unavailable.');
    }
    let handle: FileSystemFileHandle;
    let created = false;
    try {
      handle = await directory.getFileHandle(file.name);
    } catch (error) {
      if (!isEntryNotFound({ error })) {
        throw error;
      }
      handle = await directory.getFileHandle(file.name, { create: true });
      created = true;
    }
    let writable: FileSystemWritableFileStream | undefined;
    try {
      writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
    } catch (error) {
      try {
        await writable?.abort();
      } catch { /* Preserve the original save failure. */ }
      if (created) {
        try {
          await directory.removeEntry(file.name);
        } catch { /* Cleanup failure does not turn a failed save into success. */ }
      }
      throw error;
    }
  };

  private async getRegistryDirectory({ file, create }: { file: FileLocation, create: boolean }): Promise<FileSystemDirectoryHandle | undefined> {
    await this.ensureRoot();
    try {
      return await this.getStorageDirectory({ path: file.path.slice(0, -1), create });
    } catch (error) {
      if (!create && isEntryNotFound({ error })) {
        return undefined;
      }
      throw error;
    }
  }

  private readChatText = async ({ file }: { file: FileLocation }): Promise<string | undefined> => {
    const directory = await this.getStorageDirectory({ path: file.path.slice(0, -1), create: true });
    return this.readDirectoryFileText({ directory, name: file.name });
  };

  private async readDirectoryFileText({ directory, name, acceptLegacyNotFoundCode }: {
    directory: FileSystemDirectoryHandle,
    name: string,
    acceptLegacyNotFoundCode?: true,
  }): Promise<string | undefined> {
    let handle: FileSystemFileHandle;
    try {
      handle = await directory.getFileHandle(name);
    } catch (error) {
      // Only a failed lookup means absence. Once acquired, unreadable files
      // must never be presented to subsequent updates as empty records.
      if (isEntryNotFound({ error }) || (acceptLegacyNotFoundCode
        && (error instanceof DOMException || error instanceof Error) && 'code' in error && error.code === 8)) {
        return undefined;
      }
      throw error;
    }
    return (await handle.getFile()).text();
  }

  private async loadUnhydratedChatContent({ id }: { id: ChatId }): Promise<ChatContent | null> {
    return await opfsFormat.storage.chatContents.read({ id, readText: this.readChatText }) ?? null;
  }

  async init(): Promise<void> {
    await this.ensureRoot();
    await this.runMigrations();
  }

  private async ensureRoot(): Promise<void> {
    if (!this.root) {
      const opfsRoot = await navigator.storage.getDirectory();
      this.root = await openDirectoryPath({ root: opfsRoot, path: opfsFormat.storage.path, create: true });
    }
  }

  private async runMigrations(): Promise<void> {
    const state = await opfsFormat.storage.migrationState.read({ readText: this.readStorageText });
    if (!state.hasCompleted({ name: storageMigrations.uploadedFilesToBinaryObjects.id })) {
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
      await state.markCompleted({
        name: storageMigrations.uploadedFilesToBinaryObjects.id,
        completedAt: Date.now(),
        writeText: this.writeStorageText,
      });
    }
  }

  private async migrateV1UploadedFilesToBinaryObjects(): Promise<'completed' | 'deferred'> {
    let legacyParent: FileSystemDirectoryHandle;
    let legacyDir: FileSystemDirectoryHandle;
    try {
      legacyParent = await this.getStorageDirectory({ path: storageMigrations.uploadedFilesToBinaryObjects.from.path.slice(0, -1), create: undefined });
      legacyDir = await legacyParent.getDirectoryHandle(storageMigrations.uploadedFilesToBinaryObjects.from.name);
    } catch (error) {
      // Only failure to locate the source directory means migration is unnecessary.
      // A missing file later in the copy/write sequence must not mark success.
      const isNotFound = error instanceof Error && (error.name === 'NotFoundError' || ('code' in error && error.code === 8));
      if (isNotFound) {
        return 'completed';
      }
      throw error;
    }
    try {
      console.log(`[OPFSStorageProvider] Starting migration: ${storageMigrations.uploadedFilesToBinaryObjects.id}`);

      // Read one document at a time; keep only metadata, not all conversation bodies.
      const contentDir = await this.getStorageDirectory({ path: storageMigrations.uploadedFilesToBinaryObjects.chatContents.path, create: true });
      const metadata = new Map<string, Map<string, LegacyUploadedFileMetadata | 'conflict'>>();
      let deferred = false;
      for await (const entry of contentDir.values()) {
        const entryKind = entry.kind;
        switch (entryKind) {
        case 'file':
          if (storageMigrations.uploadedFilesToBinaryObjects.isChatContentFile({ name: entry.name })) {
            try {
              const file = await (entry as FileSystemFileHandle).getFile();
              for (const { attachmentId, name, mimeType, createdAt } of storageMigrations.uploadedFilesToBinaryObjects.readMetadata({ serialized: await file.text() })) {
                let files = metadata.get(attachmentId);
                if (!files) {
                  files = new Map();
                  metadata.set(attachmentId, files);
                }
                const merged = storageMigrations.uploadedFilesToBinaryObjects.mergeMetadata({ previous: files.get(name), current: { mimeType, createdAt } });
                files.set(name, merged);
                if (merged === 'conflict') {
                  deferred = true;
                }
              }
            } catch (error) {
              deferred = true;
              console.warn(`[OPFSStorageProvider] Cannot read legacy attachment metadata: ${entry.name}`, error);
            }
          }
          break;
        case 'directory': deferred = true;
          break;
        default: {
          const _ex: never = entryKind;
          throw new Error(`Unhandled content entry: ${_ex}`);
        }
        }
      }

      // 1. Copy each source file to a stable migration ID before changing references.
      const idMap = new Map<string, Map<string, string>>();

      for await (const source of storageMigrations.uploadedFilesToBinaryObjects.listSources({
        attachments: legacyDir.values(),
        listFiles: ({ directory }) => (directory as FileSystemDirectoryHandle).values(),
      })) {
        if (source === undefined) {
          deferred = true;
          continue;
        }
        const { attachmentId, file } = source;
        const blob = await (file as FileSystemFileHandle).getFile();
        const recorded = metadata.get(attachmentId)?.get(file.name);
        if (recorded === 'conflict') {
          // Retain the source and its references for a later explicit repair.
          continue;
        }
        const binaryObjectId = await storageMigrations.uploadedFilesToBinaryObjects.toBinaryObjectId({ attachmentId, name: file.name });
        const existing = await this.getBinaryObject({ binaryObjectId });
        const { name, mimeType, createdAt } = storageMigrations.uploadedFilesToBinaryObjects.selectMetadata({ originalName: file.name, recorded, existing });
        await this.saveFileWithMetadata({
          blob,
          binaryObjectId,
          name,
          mimeType,
          createdAt: createdAt === 'copy-time' ? Date.now() : createdAt,
        });
        let files = idMap.get(attachmentId);
        if (!files) {
          files = new Map();
          idMap.set(attachmentId, files);
        }
        files.set(file.name, idToRaw({ id: binaryObjectId }));
      }

      // 2. Reread current content and rewrite only references whose copies succeeded.
      for await (const entry of contentDir.values()) {
        const entryKind = entry.kind;
        switch (entryKind) {
        case 'file': {
          if (storageMigrations.uploadedFilesToBinaryObjects.isChatContentFile({ name: entry.name })) {
            try {
              const file = await (entry as FileSystemFileHandle).getFile();
              const rewritten = storageMigrations.uploadedFilesToBinaryObjects.rewriteReferences({
                serialized: await file.text(),
                binaryObjectIds: idMap,
              });
              if (rewritten.unresolvedReferences > 0) {
                deferred = true;
              }
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
      if (deferred) {
        return 'deferred';
      }

      // 3. Cleanup, after every inspected chat reference was committed.
      await legacyParent.removeEntry(storageMigrations.uploadedFilesToBinaryObjects.from.name, { recursive: true });
      console.log(`[OPFSStorageProvider] Migration completed: ${storageMigrations.uploadedFilesToBinaryObjects.id}`);
      return 'completed';
    } catch (error) {
      console.error(`[OPFSStorageProvider] Migration failed: ${storageMigrations.uploadedFilesToBinaryObjects.id}`, error);
      throw error;
    }
  }

  private async getStorageDirectory({ path, create }: {
    path: readonly string[], create: boolean | undefined,
  }): Promise<FileSystemDirectoryHandle> {
    if (!opfsFormat.storage.path.every((segment, index) => segment === path[index])) {
      const root = await navigator.storage.getDirectory();
      return openDirectoryPath({ root, path, create });
    }
    await this.ensureRoot();
    return openDirectoryPath({ root: this.root!, path: path.slice(opfsFormat.storage.path.length), create });
  }

  private async getEntryParent({ file, create }: { file: FileLocation, create: true | undefined }): Promise<FileSystemDirectoryHandle> {
    return this.getStorageDirectory({ path: file.path.slice(0, -1), create });
  }

  private async createStorageFile({ file }: { file: FileLocation }): Promise<FileSystemFileHandle> {
    const directory = await this.getStorageDirectory({ path: file.path.slice(0, -1), create: true });
    return directory.getFileHandle(file.name, { create: true });
  }

  private readStorageText = async ({ file }: { file: FileLocation }): Promise<string | undefined> => {
    const directory = await this.getStorageDirectory({ path: file.path.slice(0, -1), create: undefined });
    return this.readDirectoryFileText({ directory, name: file.name });
  };

  private writeStorageText = async ({ file, text }: { file: FileLocation, text: string }): Promise<void> => {
    const handle = await this.createStorageFile({ file });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  };

  // --- Binary Object Storage (Sharded) ---

  private async getBinaryObjectsDir(): Promise<FileSystemDirectoryHandle> {
    return await this.getStorageDirectory({ path: opfsFormat.storage.binaryObjects.path, create: true });
  }

  private readBinaryIndexText = async ({ file }: { file: FileLocation }): Promise<string | undefined> => this.readDirectoryFileText({
    directory: await this.getEntryParent({ file, create: true }),
    name: file.name,
    acceptLegacyNotFoundCode: true,
  });

  private async hydrateAttachments({ nodes }: { nodes: MessageNode[] }): Promise<void> {
    const shardCache = new Map<string, Awaited<ReturnType<typeof opfsFormat.storage.binaryObjects.index.readShard>>>();

    for (const part of iterateAttachmentParts({ nodes })) {
      const att = part.attachment;
      switch (att.status) {
      case 'persisted': {
        const shard = opfsFormat.storage.binaryObjects.shardName({ id: att.binaryObjectId });
        let index = shardCache.get(shard);
        if (!index) {
          index = await opfsFormat.storage.binaryObjects.index.readShard({ shard, readText: this.readBinaryIndexText });
          shardCache.set(shard, index);
        }
        const meta = index.get({ id: att.binaryObjectId });
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

  protected async listStoredChatMetas(): Promise<StoredChatMeta[]> {
    return await this.listChatRecords({ collection: opfsFormat.storage.chatMetas });
  }

  protected async listStoredChatGroups(): Promise<StoredChatGroup[]> {
    return await this.listChatRecords({ collection: opfsFormat.storage.chatGroups });
  }

  private async listChatRecords<T>({ collection }: {
    collection: {
      path: readonly string[],
      readListed({ name, readText }: {
        name: string, readText({ file }: { file: FileLocation }): Promise<string>,
      }): Promise<T | undefined>,
    },
  }): Promise<T[]> {
    await this.ensureRoot();
    const dir = await this.getStorageDirectory({ path: collection.path, create: true });
    const records: T[] = [];
    for await (const entry of dir.values()) {
      const kind = entry.kind;
      switch (kind) {
      case 'file': {
        const record = await collection.readListed({
          name: entry.name,
          readText: async () => (await (entry as FileSystemFileHandle).getFile()).text(),
        });
        if (record !== undefined) {
          records.push(record);
        }
        break;
      }
      case 'directory':
        break;
      default: {
        const exhaustive: never = kind;
        throw new Error(`Unhandled entry kind: ${exhaustive}`);
      }
      }
    }
    return records;
  }

  async loadHierarchy(): Promise<Hierarchy> {
    // A failed read after lookup must propagate so automatic creation cannot
    // overwrite the existing hierarchy.
    return await opfsFormat.storage.hierarchy.read({ readText: this.readStorageText }) ?? { items: [] };
  }

  async saveHierarchy({ hierarchy }: { hierarchy: Hierarchy }): Promise<void> {
    await opfsFormat.storage.hierarchy.write({ hierarchy, writeText: this.writeStorageText });
  }

  async saveChatMeta({ meta }: { meta: ChatMeta }): Promise<void> {
    await opfsFormat.storage.chatMetas.write({ meta, writeText: this.writeStorageText });
  }

  async saveChatContent({ id, content }: { id: ChatId, content: ChatContent }): Promise<void> {
    await opfsFormat.storage.chatContents.write({ id, content, writeText: this.writeStorageText });
  }

  async loadChat({ id }: { id: ChatId }): Promise<Chat | null> {
    const chat = await opfsFormat.storage.chats.read({ id, readText: this.readChatText });
    if (chat === undefined) {
      return null;
    }
    const groupId = await opfsFormat.storage.hierarchy.findChatGroupId({ id, readText: this.readStorageText });
    if (groupId !== undefined) {
      chat.groupId = groupId;
    }
    await this.hydrateAttachments({ nodes: chat.root.items });
    return chat;
  }

  async loadChatMeta({ id }: { id: ChatId }): Promise<ChatMeta | null> {
    const meta = await opfsFormat.storage.chatMetas.read({ id, readText: this.readChatText });
    if (meta === undefined) {
      return null;
    }
    const groupId = await opfsFormat.storage.hierarchy.findChatGroupId({ id, readText: this.readStorageText });
    if (groupId !== undefined) {
      meta.groupId = groupId;
    }
    return meta;
  }

  async loadChatContent({ id }: { id: ChatId }): Promise<ChatContent | null> {
    const content = await this.loadUnhydratedChatContent({ id });
    if (content === null) {
      return null;
    }

    await this.hydrateAttachments({ nodes: content.root.items });
    return content;
  }

  async loadChatContentWithoutAttachments({ id }: { id: ChatId }): Promise<ChatContent | null> {
    return this.loadUnhydratedChatContent({ id });
  }

  async deleteChat({ id }: { id: ChatId }): Promise<void> {
    try {
      const meta = opfsFormat.storage.chatMetas.file({ id });
      const content = opfsFormat.storage.chatContents.file({ id });
      const metaDir = await this.getEntryParent({ file: meta, create: true });
      const contentDir = await this.getEntryParent({ file: content, create: true });
      await metaDir.removeEntry(meta.name);
      await contentDir.removeEntry(content.name);
    } catch { /* ignore */ }
  }

  async saveChatGroup({ chatGroup }: { chatGroup: ChatGroup }): Promise<void> {
    await opfsFormat.storage.chatGroups.write({ chatGroup, writeText: this.writeStorageText });
  }

  async loadChatGroupConfiguration({ id }: { id: ChatGroupId }): Promise<Omit<ChatGroup, 'items'> | null> {
    const group = await opfsFormat.storage.chatGroups.read({ id, readText: this.readChatText });
    return group?.configuration() ?? null;
  }

  async loadChatGroup({ id }: { id: ChatGroupId }): Promise<ChatGroup | null> {
    const group = await opfsFormat.storage.chatGroups.read({ id, readText: this.readChatText });
    if (group === undefined) {
      return null;
    }
    const { hierarchy, allMetas } = await promiseAllKeyed({
      hierarchy: this.loadHierarchy(),
      allMetas: this.listStoredChatMetas(),
    });
    const chatMetas = allMetas.map(record => record.toDomain());
    return buildChatGroup({ configuration: group.configuration(), hierarchy, chatMetas });
  }

  async deleteChatGroup({ id }: { id: ChatGroupId }): Promise<void> {
    try {
      const file = opfsFormat.storage.chatGroups.file({ id });
      const dir = await this.getEntryParent({ file, create: true });
      await dir.removeEntry(file.name);
    } catch { /* ignore */ }
  }

  public override async getSidebarStructure(): Promise<SidebarItem[]> {
    const { hierarchy, metas, groups } = await promiseAllKeyed({
      hierarchy: this.loadHierarchy(),
      metas: this.listStoredChatMetas(),
      groups: this.listStoredChatGroups(),
    });

    const chatMetas = metas.map(record => record.toDomain());
    const chatGroups = groups.map(record => record.configuration());
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
    const files = opfsFormat.storage.binaryObjects.files({ id: binaryObjectId });
    const dir = await this.getStorageDirectory({ path: files.parentPath, create: true });

    // Do not touch an existing body if its shard metadata cannot be read safely.
    const entry = await opfsFormat.storage.binaryObjects.index.forId({ id: binaryObjectId }).edit({ readText: this.readBinaryIndexText });

    await files.write({
      async writeBody({ name }) {
        const handle = await dir.getFileHandle(name, { create: true }) as FileSystemFileHandleWithWritable;
        const writable = await handle.createWritable();
        // Convert blob to ArrayBuffer for compatibility.
        await writable.write(await blob.arrayBuffer());
        await writable.close();
      },
      async createMarker({ name }) {
        await dir.getFileHandle(name, { create: true });
      },
    });

    // Update the index after the body and its marker are written.
    await entry.put({
      object: {
        mimeType: mimeType ?? (blob.type || 'application/octet-stream'),
        size: blob.size,
        createdAt,
        name,
      },
      writeText: this.writeStorageText,
    });
  }

  async saveFile({ blob, binaryObjectId, name, mimeType }: {
    blob: Blob,
    binaryObjectId: BinaryObjectId,
    name: string,
    mimeType?: string,
  }): Promise<void> {
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
      const files = opfsFormat.storage.binaryObjects.files({ id: binaryObjectId });
      const dir = await this.getStorageDirectory({ path: files.parentPath, create: true });

      const fileHandle = await files.open({ openFile: ({ name }) => dir.getFileHandle(name) });
      const { file, metadata } = await promiseAllKeyed({
        file: fileHandle.getFile(),
        metadata: opfsFormat.storage.binaryObjects.index.forId({ id: binaryObjectId }).read({ readText: this.readBinaryIndexText }),
      });
      const mimeType = metadata?.mimeType;

      return mimeType === undefined || mimeType === file.type
        ? file
        : file.slice(0, file.size, mimeType);
    } catch (e) {
      console.error('Failed to get file from OPFS storage:', e);
      return null;
    }
  }

  async getBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<BinaryObject | null> {
    try {
      return await opfsFormat.storage.binaryObjects.index.forId({ id: binaryObjectId }).read({ readText: this.readBinaryIndexText }) ?? null;
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
          for await (const shardEntry of (entry as FileSystemDirectoryHandle).values()) {
            if (shardEntry.name !== opfsFormat.storage.binaryObjects.index.name) {
              return true;
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
          const index = await opfsFormat.storage.binaryObjects.index.readShard({ shard: shardEntry.name, readText: this.readBinaryIndexText });
          for (const { object } of index.entries()) {
            yield object;
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
      console.error('[OPFSStorageProvider] Failed to list binary objects', e);
    }
  }

  async deleteBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<void> {
    await this.ensureRoot();
    const files = opfsFormat.storage.binaryObjects.files({ id: binaryObjectId });
    const dir = await this.getStorageDirectory({ path: files.parentPath, create: true });

    await files.remove({
      async removeFile({ name }) {
        try {
          await dir.removeEntry(name);
        } catch (error) {
          if (!isEntryNotFound({ error })) {
            throw error;
          }
        }
      },
    });

    const entry = await opfsFormat.storage.binaryObjects.index.forId({ id: binaryObjectId }).edit({ readText: this.readBinaryIndexText });
    await entry.remove({ writeText: this.writeStorageText });
  }

  async saveSettings({ settings }: { settings: Settings }): Promise<void> {
    await opfsFormat.storage.settings.write({ settings, writeText: this.writeStorageText });
  }

  async loadSettings(): Promise<Settings | null> {
    await this.ensureRoot();
    try {
      return await opfsFormat.storage.settings.read({ readText: this.readStorageText }) ?? null;
    } catch (error) {
      // Unavailable RPC bytes must not masquerade as absent settings.
      return null;
    }
  }

  async clearAll(): Promise<void> {
    await this.withVolumeFilesLock({
      operation: async () => {
        await this.ensureRoot();
        for await (const key of this.root!.keys()) {
          await this.root!.removeEntry(key, { recursive: true });
        }
      },
    });
  }

  // --- Migration Implementation ---

  async dump(): Promise<StorageSnapshot> {
    await this.ensureRoot();
    const { settings, hierarchy, metas, groups } = await promiseAllKeyed({
      settings: this.loadSettings(),
      hierarchy: this.loadHierarchy(),
      metas: this.listStoredChatMetas(),
      groups: this.listStoredChatGroups(),
    });

    const chatGroups = groups.map(record => buildChatGroup({ configuration: record.configuration(), hierarchy, chatMetas: [] }));
    const chatMetas = metas.map(record => record.toDomain());

    const contentStream = async function* (this: OPFSStorageProvider): AsyncGenerator<MigrationChunkDto> {
      // 1. Stream all chats
      for (const meta of metas) {
        const chat = await this.loadChat({ id: meta.id });
        if (chat) {
          yield { type: 'chat' as const, data: chatToDto({ domain: chat }) };
        }
      }

      // 2. Stream all binary objects directly from storage (independent of chat references)
      // Existing index read failures must abort export instead of finalizing a
      // partial backup. An absent index is treated as empty.
      const baseDir = await this.getBinaryObjectsDir();
      for await (const shardEntry of baseDir.values()) {
        const kind = shardEntry.kind;
        switch (kind) {
        case 'directory': {
          const index = await opfsFormat.storage.binaryObjects.index.readShard({ shard: shardEntry.name, readText: this.readBinaryIndexText });
          for (const { lookupId, object } of index.entries()) {
            const blob = await this.getFile({ binaryObjectId: lookupId });
            if (blob) {
              yield {
                type: 'binary_object' as const,
                id: idToRaw({ id: lookupId }),
                name: object.name ?? 'file',
                mimeType: object.mimeType,
                size: object.size,
                createdAt: object.createdAt,
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
          endpoint: { ...DEFAULT_SETTINGS_ENDPOINT },
        } satisfies Settings,
        hierarchy,
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
    if (structure.settings) {
      await this.saveSettings({ settings: structure.settings });
    }
    if (structure.hierarchy) {
      await this.saveHierarchy({ hierarchy: structure.hierarchy });
    }
    if (structure.chatMetas) {
      for (const meta of structure.chatMetas) {
        await this.saveChatMeta({ meta });
      }
    }
    if (structure.chatGroups) {
      for (const group of structure.chatGroups) {
        await this.saveChatGroup({ chatGroup: group });
      }
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

  private readonly hostVolumeDB = indexedDbFormat.hostVolumes.bind({ requests: indexedDbRequestSuccessHandles });

  private async findVolumesBaseDir(): Promise<FileSystemDirectoryHandle | undefined> {
    await this.ensureRoot();
    try {
      return await this.getStorageDirectory({ path: opfsFormat.storage.volumes.path, create: undefined });
    } catch (error) {
      if (isEntryNotFound({ error })) {
        return undefined;
      }
      throw error;
    }
  }

  private async withVolumeFilesLock<T>({ operation }: { operation(): Promise<T> }): Promise<T> {
    const synchronizer = await getVolumeSynchronizer();
    // Serialize root creation/removal and metadata publication, never file-byte
    // copying. Publication can then validate its captured root before indexing it.
    return await synchronizer.withLock({ lockKey: 'naidan-volume-files', fn: operation });
  }

  private readVolumeIndexText = async ({ file }: { file: FileLocation }): Promise<string | undefined> => {
    const directory = await this.findEntryParent({ file });
    return directory === undefined ? undefined : this.readDirectoryFileText({ directory, name: file.name });
  };

  private async findEntryParent({ file }: { file: FileLocation }): Promise<FileSystemDirectoryHandle | undefined> {
    await this.ensureRoot();
    try {
      return await this.getStorageDirectory({ path: file.path.slice(0, -1), create: undefined });
    } catch (error) {
      if (isEntryNotFound({ error })) {
        return undefined;
      }
      throw error;
    }
  }

  private async withVolumeIndexLock({ shard, operation }: {
    shard: string,
    operation(): Promise<void>,
  }): Promise<void> {
    await this.withVolumeFilesLock({
      operation: async () => {
        const synchronizer = await getVolumeSynchronizer();
        await synchronizer.withLock({
          // Keep this below outer chat/settings locks. Using LOCK_METADATA again
          // would deadlock callers that already hold that lock during cleanup.
          lockKey: `naidan-volume-index:${shard}`,
          fn: operation,
        });
      },
    });
  }

  private async createVolumeDirectory({ volumeId }: { volumeId: VolumeId }): Promise<{ root: FileSystemDirectoryHandle, parent: FileSystemDirectoryHandle, name: string }> {
    const location = opfsFormat.storage.volumes.root({ id: volumeId });
    const parent = await this.getEntryParent({ file: location, create: true });
    const root = await parent.getDirectoryHandle(location.name, { create: true });
    return { root, parent, name: location.name };
  }

  override async ensureVolumeDirectory({ volumeId }: { volumeId: VolumeId }): Promise<FileSystemDirectoryHandle> {
    return await this.withVolumeFilesLock({ operation: async () => (await this.createVolumeDirectory({ volumeId })).root });
  }

  override async publishVolume({ volume, root }: { volume: Volume, root: FileSystemDirectoryHandle | undefined }): Promise<void> {
    const { id, ...metadata } = volume;
    const record = opfsFormat.storage.volumes.index.forId({ id });
    await this.withVolumeIndexLock({
      shard: record.shard,
      operation: async () => {
        switch (volume.type) {
        case 'opfs': {
          const location = opfsFormat.storage.volumes.root({ id });
          const directory = await this.findEntryParent({ file: location });
          if (directory === undefined) {
            throw new DOMException('The browser folder no longer exists', 'NotFoundError');
          }
          const current = await directory.getDirectoryHandle(location.name);
          // A path reused after clearAll must not publish an older copy task.
          if (root !== undefined && !await current.isSameEntry(root)) {
            throw new DOMException('The browser folder was replaced before publication', 'InvalidStateError');
          }
          break;
        }
        case 'host':
          await this.getStorageDirectory({ path: record.shardPath, create: true });
          break;
        default: {
          const exhaustive: never = volume.type;
          throw new Error(`Unhandled volume type: ${String(exhaustive)}`);
        }
        }
        const entry = await record.edit({ readText: this.readVolumeIndexText });
        await entry.put({ volume: metadata, writeText: this.writeVolumeIndexText });
      },
    });
  }

  override async probeVolumeAccess({ volumeId }: { volumeId: VolumeId }): Promise<StoredVolumeAccess> {
    const volume = await opfsFormat.storage.volumes.index.forId({ id: volumeId }).read({ readText: this.readVolumeIndexText });
    if (volume !== undefined) {
      switch (volume.type) {
      case 'host': {
        const handle = await this.hostVolumeDB.get({ id: volumeId });
        return handle ? { kind: 'native', volume, handle } : { kind: 'missing', volumeId };
      }
      case 'opfs':
        break;
      default: {
        const exhaustive: never = volume.type;
        throw new Error(`Unhandled volume type: ${String(exhaustive)}`);
      }
      }
    }
    const location = opfsFormat.storage.volumes.root({ id: volumeId });
    const parent = await this.findEntryParent({ file: location });
    if (parent === undefined) {
      return { kind: 'missing', volumeId };
    }
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await parent.getDirectoryHandle(location.name);
    } catch (error) {
      if (isEntryNotFound({ error })) {
        return { kind: 'missing', volumeId };
      }
      throw error;
    }
    return volume === undefined ? { kind: 'incomplete', volumeId, handle } : { kind: 'native', volume, handle };
  }

  override async deleteUnpublishedVolumeDirectory({ volumeId }: { volumeId: VolumeId }): Promise<void> {
    const record = opfsFormat.storage.volumes.index.forId({ id: volumeId });
    await this.withVolumeIndexLock({
      shard: record.shard,
      operation: async () => {
        if (await record.read({ readText: this.readVolumeIndexText }) !== undefined) {
          throw new DOMException('The folder has already been published', 'InvalidStateError');
        }
        const location = opfsFormat.storage.volumes.root({ id: volumeId });
        const parent = await this.findEntryParent({ file: location });
        if (parent === undefined) {
          return;
        }
        try {
          await parent.removeEntry(location.name, { recursive: true });
        } catch (error) {
          if (!isEntryNotFound({ error })) {
            throw error;
          }
        }
      },
    });
  }

  private writeVolumeIndexText = async ({ file, text }: { file: FileLocation, text: string }): Promise<void> => {
    const directory = await this.findEntryParent({ file });
    if (directory === undefined) {
      throw new DOMException('The browser folder index no longer exists', 'NotFoundError');
    }
    const handle = await directory.getFileHandle(file.name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(text);
      await writable.close();
    } catch (error) {
      try {
        await writable.abort(error);
      } catch { /* Preserve the metadata failure, including if abort also fails. */ }
      throw error;
    }
  };

  private async copyDirectory({ source, destination }: { source: FileSystemDirectoryHandle, destination: FileSystemDirectoryHandle }): Promise<void> {
    for await (const entry of source.values()) {
      switch (entry.kind) {
      case 'file': {
        const file = await (entry as FileSystemFileHandle).getFile();
        const destFile = await destination.getFileHandle(entry.name, { create: true }) as FileSystemFileHandleWithWritable;
        const writable = await destFile.createWritable();
        await writable.write(await file.arrayBuffer());
        await writable.close();
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
    await this.ensureRoot();
    try {
      const baseDir = await this.findVolumesBaseDir();
      if (baseDir === undefined) {
        return;
      }
      for await (const shardEntry of baseDir.values()) {
        switch (shardEntry.kind) {
        case 'directory': {
          yield* opfsFormat.storage.volumes.index.listShard({ shard: shardEntry.name, readText: this.readVolumeIndexText });
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
      console.error('[OPFSStorageProvider] Failed to list volumes', e);
    }
  }

  async createVolume({ name, type, sourceHandle }: {
    name: string,
    type: VolumeType,
    sourceHandle: FileSystemDirectoryHandle,
  }): Promise<Volume> {
    const id = generateId<VolumeId>();
    const createdAt = Date.now();

    let volumeRoot: FileSystemDirectoryHandle | undefined;

    switch (type) {
    case 'opfs': {
      volumeRoot = await this.ensureVolumeDirectory({ volumeId: id });
      await this.copyDirectory({ source: sourceHandle, destination: volumeRoot });

      break;
    }
    case 'host': {
      await this.hostVolumeDB.put({ id, handle: sourceHandle });
      break;
    }
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled volume type: ${(_ex as { type: string }).type}`);
    }
    }

    const volume: Volume = { id, name, type, createdAt };
    await this.publishVolume({ volume, root: volumeRoot });
    return volume;
  }

  async createVolumeFromFiles({ name, entries, onProgress, signal }: {
    name: string,
    entries: Array<{ file: File, relativePath: string }>,
    onProgress?: ({ processed, total }: { processed: number, total: number }) => void,
    signal?: AbortSignal,
  }): Promise<Volume> {
    const id = generateId<VolumeId>();
    const createdAt = Date.now();

    const { root: volumeDir, parent, name: directoryName } = await this.withVolumeFilesLock({ operation: () => this.createVolumeDirectory({ volumeId: id }) });

    for (let i = 0; i < entries.length; i++) {
      if (signal?.aborted) {
        await parent.removeEntry(directoryName, { recursive: true }).catch(() => {});
        throw new DOMException('Cancelled by user', 'AbortError');
      }

      const entry = entries[i];
      if (!entry) {
        continue;
      }
      const { file, relativePath } = entry;
      const pathParts = relativePath.split('/').filter(Boolean);

      const fileName = pathParts.pop()!;
      let currentDir = volumeDir;

      for (const part of pathParts) {
        currentDir = await currentDir.getDirectoryHandle(part, { create: true });
      }

      const fileHandle = await currentDir.getFileHandle(fileName, { create: true }) as FileSystemFileHandleWithWritable;
      const writable = await fileHandle.createWritable();
      await writable.write(await file.arrayBuffer());
      await writable.close();

      if (onProgress) {
        onProgress({ processed: i + 1, total: entries.length });
      }
    }

    const volume: Volume = {
      type: 'opfs',
      id,
      name,
      createdAt,
    };

    await this.publishVolume({ volume, root: volumeDir });
    return volume;
  }

  async getVolumeDirectoryHandle({ volumeId }: { volumeId: VolumeId }): Promise<FileSystemDirectoryHandle | null> {
    try {
      const access = await this.probeVolumeAccess({ volumeId });
      switch (access.kind) {
      case 'native':
        return access.handle;
      case 'incomplete':
      case 'missing':
        return null;
      default: {
        const _ex: never = access;
        throw new Error(`Unhandled volume type: ${JSON.stringify(_ex)}`);
      }
      }
    } catch (e) {
      console.error('Failed to get volume directory handle:', e);
      return null;
    }
  }

  async renameVolume({ volumeId, name }: { volumeId: VolumeId, name: string }): Promise<void> {
    const record = opfsFormat.storage.volumes.index.forId({ id: volumeId });
    await this.withVolumeIndexLock({
      shard: record.shard,
      operation: async () => {
        const entry = await record.edit({ readText: this.readVolumeIndexText });
        await entry.rename({ name, writeText: this.writeVolumeIndexText });
      },
    });
  }

  async deleteVolume({ volumeId }: { volumeId: VolumeId }): Promise<void> {
    const record = opfsFormat.storage.volumes.index.forId({ id: volumeId });

    try {
      await this.withVolumeIndexLock({
        shard: record.shard,
        operation: async () => {
          const entry = await record.edit({ readText: this.readVolumeIndexText });
          const volume = entry.get();
          if (volume === undefined) {
            return;
          }
          switch (volume.type) {
          case 'opfs': {
            const location = opfsFormat.storage.volumes.root({ id: volumeId });
            const parent = await this.getEntryParent({ file: location, create: true });
            await parent.removeEntry(location.name, { recursive: true });
            break;
          }
          case 'host':
            await this.hostVolumeDB.delete({ id: volumeId });
            break;
          default: {
            const _ex: never = volume.type;
            throw new Error(`Unhandled volume type: ${JSON.stringify(_ex)}`);
          }
          }

          await entry.remove({ writeText: this.writeVolumeIndexText });
        },
      });
    } catch (e) {
      console.error('Failed to delete volume:', e);
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
