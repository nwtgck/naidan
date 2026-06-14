import { generateId } from '@/utils/id';
import type { Chat, Settings, ChatGroup, SidebarItem, MessageNode, ChatMeta, ChatContent, StorageSnapshot, BinaryObject, Volume, VolumeType } from '@/models/types';
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
} from '@/models/dto';
import {
  chatToDomain,
  chatToDto,
  chatGroupToDomain,
  chatGroupToDto,
  settingsToDomain,
  settingsToDto,
  hierarchyToDomain,
  chatMetaToDto,
  chatMetaToDomain,
  chatContentToDto,
  chatContentToDomain,
  buildSidebarItemsFromHierarchy,
  binaryObjectToDomain,
  volumeToDomain,
} from '@/models/mappers';import { IStorageProvider } from './interface';

import {
  type MigrationStateDto,
  type BinaryShardIndexDto,
  MigrationStateSchemaDto,
  BinaryShardIndexSchemaDto,
} from '@/models/dto';

interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

const MIGRATION_V1_UPLOADED_FILES_TO_BINARY_OBJECTS = 'v1_uploaded_files_to_binary_objects';

type BinaryShardIndex = BinaryShardIndexDto;

export class OPFSStorageProvider extends IStorageProvider {
  private root: FileSystemDirectoryHandle | null = null;
  private readonly STORAGE_DIR = 'naidan-storage';
  readonly canPersistBinary = true;

  async init(): Promise<void> {
    await this.ensureRoot();
    await this.runMigrations();
  }

  private async ensureRoot(): Promise<void> {
    if (!this.root) {
      const opfsRoot = await navigator.storage.getDirectory();
      this.root = await opfsRoot.getDirectoryHandle(this.STORAGE_DIR, { create: true });
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
    const fileHandle = await this.root!.getFileHandle('migration-state.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(state));
    await writable.close();
  }

  private async runMigrations(): Promise<void> {
    const state = await this.loadMigrationState();
    const completed = new Set(state.completedMigrations.map(m => m.name));

    if (!completed.has(MIGRATION_V1_UPLOADED_FILES_TO_BINARY_OBJECTS)) {
      await this.migrateV1UploadedFilesToBinaryObjects();
      state.completedMigrations.push({
        name: MIGRATION_V1_UPLOADED_FILES_TO_BINARY_OBJECTS,
        completedAt: Date.now()
      });
      await this.saveMigrationState({ state });
    }
  }

  private async migrateV1UploadedFilesToBinaryObjects(): Promise<void> {
    try {
      const legacyDir = await this.root!.getDirectoryHandle('uploaded-files');
      console.log(`[OPFSStorageProvider] Starting migration: ${MIGRATION_V1_UPLOADED_FILES_TO_BINARY_OBJECTS}`);

      // 1. Migrate Files and Create Mapping (attachmentId -> binaryObjectId)
      const idMap = new Map<string, string>();

      for await (const attachmentDirEntry of legacyDir.values()) {
        const entryKind = attachmentDirEntry.kind;
        switch (entryKind) {
        case 'directory': {
          const attachmentId = attachmentDirEntry.name;
          for await (const fileEntry of (attachmentDirEntry as FileSystemDirectoryHandle).values()) {
            const fileKind = fileEntry.kind;
            switch (fileKind) {
            case 'file': {
              const blob = await (fileEntry as FileSystemFileHandle).getFile();
              const newBinaryObjectId = generateId();

              // Save to new location with NEW ID
              await this.saveFile({ blob, binaryObjectId: newBinaryObjectId, name: fileEntry.name });
              idMap.set(attachmentId, newBinaryObjectId);
              break;
            }
            case 'directory':
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
          break;
        default: {
          const _ex: never = entryKind;
          throw new Error(`Unhandled entry kind: ${_ex}`);
        }
        }
      }

      // 2. Update all Chat Content JSON files to point to the new IDs
      const contentDir = await this.getDir({ name: 'chat-contents' });
      for await (const entry of contentDir.values()) {
        const entryKind = entry.kind;
        switch (entryKind) {
        case 'file': {
          if (entry.name.endsWith('.json')) {
            try {
              const file = await (entry as FileSystemFileHandle).getFile();
              const content = JSON.parse(await file.text());

              let modified = false;
              const processNodes = ({ nodes }: { nodes: unknown[] }) => {
                for (const node of nodes) {
                  const nodeObj = node as Record<string, unknown>;
                  const attachments = nodeObj.attachments as Record<string, unknown>[] | undefined;
                  if (attachments) {
                    for (const att of attachments) {
                      // If it's a V1 attachment (no binaryObjectId), look up in map
                      if (!att.binaryObjectId && typeof att.id === 'string' && idMap.has(att.id)) {
                        att.binaryObjectId = idMap.get(att.id);
                        att.name = att.name || att.originalName;
                        modified = true;
                      }
                    }
                  }
                  const replies = nodeObj.replies as Record<string, unknown> | undefined;
                  if (replies?.items) processNodes({ nodes: replies.items as unknown[] });
                }
              };

              if (content.root?.items) {
                processNodes({ nodes: content.root.items });
                if (modified) {
                  const writable = await (entry as unknown as FileSystemFileHandleWithWritable).createWritable();
                  await writable.write(JSON.stringify(content));
                  await writable.close();
                }
              }
            } catch (jsonErr) {
              console.warn(`[OPFSStorageProvider] Skipping corrupted chat content file: ${entry.name}`, jsonErr);
            }
          }
          break;
        }
        case 'directory':
          break;
        default: {
          const _ex: never = entryKind;
          throw new Error(`Unhandled entry kind: ${_ex}`);
        }
        }
      }

      // 3. Cleanup
      await this.root!.removeEntry('uploaded-files', { recursive: true });
      console.log(`[OPFSStorageProvider] Migration completed: ${MIGRATION_V1_UPLOADED_FILES_TO_BINARY_OBJECTS}`);
    } catch (e) {
      // If uploaded-files doesn't exist, migration is not needed
      const isNotFound = e instanceof Error && (e.name === 'NotFoundError' || (e as { code?: number }).code === 8);
      if (!isNotFound) {
        console.error(`[OPFSStorageProvider] Migration failed: ${MIGRATION_V1_UPLOADED_FILES_TO_BINARY_OBJECTS}`, e);
        throw e;
      }
    }
  }

  private async getDir({ name, parent = this.root! }: { name: string; parent?: FileSystemDirectoryHandle }): Promise<FileSystemDirectoryHandle> {
    await this.ensureRoot();
    return await parent.getDirectoryHandle(name, { create: true });
  }

  // --- Binary Object Storage (Sharded) ---

  private getBinaryObjectShardPath({ id }: { id: string }): string {
    return id.slice(-2).toLowerCase();
  }

  private async getBinaryObjectsDir(): Promise<FileSystemDirectoryHandle> {
    return await this.getDir({ name: 'binary-objects' });
  }

  private async getShardDir({ shard }: { shard: string }): Promise<FileSystemDirectoryHandle> {
    const baseDir = await this.getBinaryObjectsDir();
    return await this.getDir({ name: shard, parent: baseDir });
  }

  private async loadShardIndex({ shard }: { shard: string }): Promise<BinaryShardIndex> {
    try {
      const dir = await this.getShardDir({ shard: shard });
      const fileHandle = await dir.getFileHandle('index.json');
      const file = await fileHandle.getFile();
      return BinaryShardIndexSchemaDto.parse(JSON.parse(await file.text()));
    } catch {
      return { objects: {} };
    }
  }

  private async saveShardIndex({ shard, index }: { shard: string; index: BinaryShardIndex }): Promise<void> {
    const dir = await this.getShardDir({ shard: shard });
    const fileHandle = await dir.getFileHandle('index.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(index));
    await writable.close();
  }

  private async hydrateAttachments({ nodes }: { nodes: MessageNode[] }): Promise<void> {
    const shardCache = new Map<string, BinaryShardIndex>();

    const processNodes = async ({ items }: { items: MessageNode[] }) => {
      for (const node of items) {
        if (node.attachments) {
          for (let i = 0; i < node.attachments.length; i++) {
            const att = node.attachments[i];
            if (!att) continue;

            const status = att.status;
            switch (status) {
            case 'persisted': {
              const shard = this.getBinaryObjectShardPath({ id: att.binaryObjectId });
              let index = shardCache.get(shard);
              if (!index) {
                index = await this.loadShardIndex({ shard: shard });
                shardCache.set(shard, index);
              }

              const meta = index.objects[att.binaryObjectId];
              if (meta) {
                att.mimeType = meta.mimeType;
                att.size = meta.size;
                att.uploadedAt = meta.createdAt;
              } else {
                node.attachments[i] = {
                  id: att.id,
                  binaryObjectId: att.binaryObjectId,
                  originalName: att.originalName,
                  mimeType: att.mimeType,
                  size: att.size,
                  uploadedAt: att.uploadedAt,
                  status: 'missing'
                };
              }
              break;
            }
            case 'memory':
            case 'missing':
              break;
            default: {
              const _ex: never = status;
              throw new Error(`Unhandled attachment status: ${_ex}`);
            }
            }
          }
        }
        if (node.replies?.items) {
          await processNodes({ items: node.replies.items });
        }
      }
    };

    await processNodes({ items: nodes });
  }

  // --- Internal Data Access ---

  protected async listChatMetasRaw(): Promise<ChatMetaDto[]> {
    try {
      const dir = await this.getDir({ name: 'chat-metas' });
      const dtos: ChatMetaDto[] = [];
      for await (const entry of dir.values()) {
        const kind = entry.kind;
        switch (kind) {
        case 'file': {
          if (entry.name.endsWith('.json')) {
            const file = await (entry as FileSystemFileHandle).getFile();
            dtos.push(JSON.parse(await file.text()));
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

  protected async listChatGroupsRaw(): Promise<ChatGroupDto[]> {
    try {
      const dir = await this.getDir({ name: 'chat-groups' });
      const dtos: ChatGroupDto[] = [];
      for await (const entry of dir.values()) {
        const kind = entry.kind;
        switch (kind) {
        case 'file': {
          if (entry.name.endsWith('.json')) {
            const file = await (entry as FileSystemFileHandle).getFile();
            dtos.push(JSON.parse(await file.text()));
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
    const fileHandle = await this.root!.getFileHandle('hierarchy.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(hierarchy));
    await writable.close();
  }

  // --- Persistence Implementation ---

  async saveChatMeta({ meta }: { meta: ChatMeta }): Promise<void> {
    const dto = chatMetaToDto({ domain: meta });
    ChatMetaSchemaDto.parse(dto);
    const dir = await this.getDir({ name: 'chat-metas' });
    const fileHandle = await dir.getFileHandle(`${meta.id}.json`, { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(dto));
    await writable.close();
  }

  async saveChatContent({ id, content }: { id: string; content: ChatContent }): Promise<void> {
    const dto = chatContentToDto({ domain: content });
    ChatContentSchemaDto.parse(dto);
    const dir = await this.getDir({ name: 'chat-contents' });
    const fileHandle = await dir.getFileHandle(`${id}.json`, { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(dto));
    await writable.close();
  }

  async loadChat({ id }: { id: string }): Promise<Chat | null> {
    try {
      const metaDir = await this.getDir({ name: 'chat-metas' });
      const contentDir = await this.getDir({ name: 'chat-contents' });

      const metaFile = await (await metaDir.getFileHandle(`${id}.json`)).getFile();
      const contentFile = await (await contentDir.getFileHandle(`${id}.json`)).getFile();

      const meta = ChatMetaSchemaDto.parse(JSON.parse(await metaFile.text()));
      const content = ChatContentSchemaDto.parse(JSON.parse(await contentFile.text()));

      const chat = chatToDomain({ dto: { ...meta, ...content, messages: undefined } });

      // Resolve groupId from hierarchy
      const hierarchy = await this.loadHierarchy();
      if (hierarchy) {
        const group = hierarchy.items.find(i => i.type === 'chat_group' && i.chat_ids.includes(id));
        if (group) chat.groupId = group.id;
      }

      // Hydrate attachments with metadata from BinaryObject indices
      await this.hydrateAttachments({ nodes: chat.root.items });

      return chat;
    } catch {
      return null;
    }
  }

  async loadChatMeta({ id }: { id: string }): Promise<ChatMeta | null> {
    try {
      const metaDir = await this.getDir({ name: 'chat-metas' });
      const metaFile = await (await metaDir.getFileHandle(`${id}.json`)).getFile();
      const meta = chatMetaToDomain({ dto: ChatMetaSchemaDto.parse(JSON.parse(await metaFile.text())) });

      // Resolve groupId from hierarchy
      const hierarchy = await this.loadHierarchy();
      if (hierarchy) {
        const group = hierarchy.items.find(i => i.type === 'chat_group' && i.chat_ids.includes(id));
        if (group) meta.groupId = group.id;
      }

      return meta;
    } catch {
      return null;
    }
  }

  async loadChatContent({ id }: { id: string }): Promise<ChatContent | null> {
    try {
      const contentDir = await this.getDir({ name: 'chat-contents' });
      const contentFile = await (await contentDir.getFileHandle(`${id}.json`)).getFile();
      const dto = ChatContentSchemaDto.parse(JSON.parse(await contentFile.text()));
      const content = chatContentToDomain({ dto });

      // Hydrate attachments
      await this.hydrateAttachments({ nodes: content.root.items });

      return content;
    } catch {
      return null;
    }
  }

  async deleteChat({ id }: { id: string }): Promise<void> {
    try {
      const metaDir = await this.getDir({ name: 'chat-metas' });
      const contentDir = await this.getDir({ name: 'chat-contents' });
      await metaDir.removeEntry(`${id}.json`);
      await contentDir.removeEntry(`${id}.json`);
    } catch { /* ignore */ }
  }

  async saveChatGroup({ chatGroup }: { chatGroup: ChatGroup }): Promise<void> {
    const dto = chatGroupToDto({ domain: chatGroup });
    ChatGroupSchemaDto.parse(dto);
    const dir = await this.getDir({ name: 'chat-groups' });
    const fileHandle = await dir.getFileHandle(`${chatGroup.id}.json`, { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(dto));
    await writable.close();
  }

  async loadChatGroup({ id }: { id: string }): Promise<ChatGroup | null> {
    try {
      const dir = await this.getDir({ name: 'chat-groups' });
      const file = await (await dir.getFileHandle(`${id}.json`)).getFile();
      const groupDto = ChatGroupSchemaDto.parse(JSON.parse(await file.text()));

      const [hierarchy, allMetas] = await Promise.all([
        this.loadHierarchy(),
        this.listChatMetasRaw()
      ]);

      const chatMetas = allMetas.map(dto => chatMetaToDomain({ dto }));
      const h = hierarchy || { items: [] };
      return chatGroupToDomain({ dto: groupDto, hierarchy: h, chatMetas });
    } catch {
      return null;
    }
  }

  async deleteChatGroup({ id }: { id: string }): Promise<void> {
    try {
      const dir = await this.getDir({ name: 'chat-groups' });
      await dir.removeEntry(`${id}.json`);
    } catch { /* ignore */ }
  }

  public override async getSidebarStructure(): Promise<SidebarItem[]> {
    const [rawHierarchy, rawMetas, rawGroups] = await Promise.all([
      this.loadHierarchy(),
      this.listChatMetasRaw(),
      this.listChatGroupsRaw(),
    ]);

    const hierarchy = hierarchyToDomain({ dto: rawHierarchy || { items: [] } });
    const chatMetas = rawMetas.map(dto => chatMetaToDomain({ dto }));
    const chatGroups = rawGroups.map(dto => chatGroupToDomain({ dto, hierarchy, chatMetas }));

    return buildSidebarItemsFromHierarchy({ hierarchy, chatMetas, chatGroups });
  }

  // --- Binary Object Storage ---

  async saveFile({ blob, binaryObjectId, name, mimeType }: {
    blob: Blob;
    binaryObjectId: string;
    name: string;
    mimeType?: string;
  }): Promise<void> {
    const shard = this.getBinaryObjectShardPath({ id: binaryObjectId });
    const dir = await this.getShardDir({ shard: shard });

    // 1. Write Blob
    const binFileName = `${binaryObjectId}.bin`;
    const fileHandle = await dir.getFileHandle(binFileName, { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    // Convert blob to ArrayBuffer for compatibility
    await writable.write(await blob.arrayBuffer());
    await writable.close();

    // 2. Write Marker
    const markerName = `.${binFileName}.complete`;
    await dir.getFileHandle(markerName, { create: true });

    // 3. Update Index
    const index = await this.loadShardIndex({ shard: shard });
    index.objects[binaryObjectId] = {
      id: binaryObjectId,
      mimeType: mimeType || blob.type || 'application/octet-stream',
      size: blob.size,
      createdAt: Date.now(),
      name,
    };
    await this.saveShardIndex({ shard: shard, index: index });
  }

  async getFile({ binaryObjectId }: { binaryObjectId: string }): Promise<Blob | null> {
    try {
      const shard = this.getBinaryObjectShardPath({ id: binaryObjectId });
      const dir = await this.getShardDir({ shard: shard });
      const fileName = `${binaryObjectId}.bin`;
      const markerName = `.${fileName}.complete`;

      // Verify completion marker
      await dir.getFileHandle(markerName);

      const fileHandle = await dir.getFileHandle(fileName);
      return await fileHandle.getFile();
    } catch (e) {
      console.error('Failed to get file from OPFS storage:', e);
      return null;
    }
  }

  async getBinaryObject({ binaryObjectId }: { binaryObjectId: string }): Promise<BinaryObject | null> {
    try {
      const shard = this.getBinaryObjectShardPath({ id: binaryObjectId });
      const index = await this.loadShardIndex({ shard: shard });
      return index.objects[binaryObjectId] || null;
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
      console.error('[OPFSStorageProvider] Failed to list binary objects', e);
    }
  }

  async deleteBinaryObject({ binaryObjectId }: { binaryObjectId: string }): Promise<void> {
    await this.ensureRoot();
    const shard = this.getBinaryObjectShardPath({ id: binaryObjectId });
    const dir = await this.getShardDir({ shard: shard });
    const fileName = `${binaryObjectId}.bin`;
    const markerName = `.${fileName}.complete`;

    try {
      await dir.removeEntry(fileName);
    } catch { /* ignore */ }
    try {
      await dir.removeEntry(markerName);
    } catch { /* ignore */ }

    const index = await this.loadShardIndex({ shard: shard });
    if (index.objects[binaryObjectId]) {
      delete index.objects[binaryObjectId];
      await this.saveShardIndex({ shard: shard, index: index });
    }
  }

  async saveSettings({ settings }: { settings: Settings }): Promise<void> {
    await this.ensureRoot();
    const dto = settingsToDto({ domain: settings });
    const validated = SettingsSchemaDto.parse(dto);
    const fileHandle = await this.root!.getFileHandle('settings.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(validated));
    await writable.close();
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

  async clearAll(): Promise<void> {
    await this.ensureRoot();
    for await (const key of this.root!.keys()) {
      await this.root!.removeEntry(key, { recursive: true });
    }
  }

  // --- Migration Implementation ---

  async dump(): Promise<StorageSnapshot> {
    await this.ensureRoot();
    const [settings, hierarchy, rawMetas, rawGroups] = await Promise.all([
      this.loadSettings(),
      this.loadHierarchy(),
      this.listChatMetasRaw(),
      this.listChatGroupsRaw(),
    ]);

    const chatGroups = rawGroups.map(dto => chatGroupToDomain({ dto, hierarchy: hierarchy || { items: [] }, chatMetas: [] }));
    const chatMetas = rawMetas.map(dto => chatMetaToDomain({ dto }));

    const contentStream = async function* (this: OPFSStorageProvider): AsyncGenerator<MigrationChunkDto> {
      // 1. Stream all chats
      for (const meta of rawMetas) {
        const chat = await this.loadChat({ id: meta.id });
        if (chat) {
          yield { type: 'chat' as const, data: chatToDto({ domain: chat }) };
        }
      }

      // 2. Stream all binary objects directly from storage (independent of chat references)
      try {
        const baseDir = await this.getBinaryObjectsDir();
        for await (const shardEntry of baseDir.values()) {
          const kind = shardEntry.kind;
          switch (kind) {
          case 'directory': {
            const shard = shardEntry.name;
            const index = await this.loadShardIndex({ shard: shard });
            for (const bId of Object.keys(index.objects)) {
              const meta = index.objects[bId]!;
              const blob = await this.getFile({ binaryObjectId: bId });
              if (blob) {
                yield {
                  type: 'binary_object' as const,
                  id: bId,
                  name: meta.name || 'file',
                  mimeType: meta.mimeType,
                  size: meta.size,
                  createdAt: meta.createdAt,
                  blob
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
      } catch (e) {
        console.warn('[OPFSStorageProvider] Failed to dump some binary objects', e);
      }
    };

    return {
      structure: {
        settings: settings || {
          autoTitleEnabled: true,
          providerProfiles: [],
          mounts: [],
          storageType: 'opfs',
          endpointType: 'openai',
          endpointUrl: '',
        } as Settings,
        hierarchy: hierarchy || { items: [] },
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
    if (structure.hierarchy) await this.saveHierarchy({ hierarchy: structure.hierarchy });
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
        await this.saveFile({
          blob: chunk.blob,
          binaryObjectId: chunk.id,
          name: chunk.name,
          mimeType: chunk.mimeType
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

  private getVolumeShardPath({ id }: { id: string }): string {
    return id.slice(-2).toLowerCase();
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
      const dir = await this.getVolumeShardDir({ shard });
      const fileHandle = await dir.getFileHandle('index.json');
      const file = await fileHandle.getFile();
      return VolumeIndexSchemaDto.parse(JSON.parse(await file.text()));
    } catch {
      return { volumes: {} };
    }
  }

  private async saveVolumeShardIndex({ shard, index }: { shard: string; index: VolumeIndexDto }): Promise<void> {
    const dir = await this.getVolumeShardDir({ shard });
    const fileHandle = await dir.getFileHandle('index.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(index));
    await writable.close();
  }

  private async copyDirectory({ source, destination }: { source: FileSystemDirectoryHandle; destination: FileSystemDirectoryHandle }): Promise<void> {
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
      console.error('[OPFSStorageProvider] Failed to list volumes', e);
    }
  }

  async createVolume({ name, type, sourceHandle }: {
    name: string;
    type: VolumeType;
    sourceHandle: FileSystemDirectoryHandle;
  }): Promise<Volume> {
    const id = generateId();
    const createdAt = Date.now();
    const shard = this.getVolumeShardPath({ id });

    let volumeDto: VolumeDto;

    switch (type) {
    case 'opfs': {
      const shardDir = await this.getVolumeShardDir({ shard });
      const volumeDir = await shardDir.getDirectoryHandle(id, { create: true });
      await this.copyDirectory({ source: sourceHandle, destination: volumeDir });

      volumeDto = {
        type: 'opfs',
        id,
        name,
        createdAt,
      };
      break;
    }
    case 'host': {
      await this.hostVolumeDB.put({ id, handle: sourceHandle });
      volumeDto = {
        type: 'host',
        id,
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
    index.volumes[id] = volumeDto;
    await this.saveVolumeShardIndex({ shard, index });

    return volumeToDomain({ dto: volumeDto });
  }

  async createVolumeFromFiles({ name, entries, onProgress, signal }: {
    name: string;
    entries: Array<{ file: File; relativePath: string }>;
    onProgress?: ({ processed, total }: { processed: number; total: number }) => void;
    signal?: AbortSignal;
  }): Promise<Volume> {
    const id = generateId();
    const createdAt = Date.now();
    const shard = this.getVolumeShardPath({ id });

    const shardDir = await this.getVolumeShardDir({ shard });
    const volumeDir = await shardDir.getDirectoryHandle(id, { create: true });

    for (let i = 0; i < entries.length; i++) {
      if (signal?.aborted) {
        await shardDir.removeEntry(id, { recursive: true }).catch(() => {});
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
      const writable = await fileHandle.createWritable();
      await writable.write(await file.arrayBuffer());
      await writable.close();

      if (onProgress) {
        onProgress({ processed: i + 1, total: entries.length });
      }
    }

    const volumeDto: VolumeDto = {
      type: 'opfs',
      id,
      name,
      createdAt,
    };

    const index = await this.loadVolumeShardIndex({ shard });
    index.volumes[id] = volumeDto;
    await this.saveVolumeShardIndex({ shard, index });

    return volumeToDomain({ dto: volumeDto });
  }

  async getVolumeDirectoryHandle({ volumeId }: { volumeId: string }): Promise<FileSystemDirectoryHandle | null> {
    try {
      const shard = this.getVolumeShardPath({ id: volumeId });
      const index = await this.loadVolumeShardIndex({ shard });
      const volume = index.volumes[volumeId];

      if (!volume) return null;

      switch (volume.type) {
      case 'opfs': {
        const shardDir = await this.getVolumeShardDir({ shard });
        return await shardDir.getDirectoryHandle(volumeId);
      }
      case 'host':
        return await this.hostVolumeDB.get({ id: volumeId }) || null;
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

  async renameVolume({ volumeId, name }: { volumeId: string; name: string }): Promise<void> {
    const shard = this.getVolumeShardPath({ id: volumeId });
    const index = await this.loadVolumeShardIndex({ shard });
    const volume = index.volumes[volumeId];
    if (!volume) throw new Error(`Volume not found: ${volumeId}`);
    index.volumes[volumeId] = { ...volume, name };
    await this.saveVolumeShardIndex({ shard, index });
  }

  async deleteVolume({ volumeId }: { volumeId: string }): Promise<void> {
    const shard = this.getVolumeShardPath({ id: volumeId });

    try {
      const index = await this.loadVolumeShardIndex({ shard });
      const volume = index.volumes[volumeId];

      if (volume) {
        switch (volume.type) {
        case 'opfs': {
          const shardDir = await this.getVolumeShardDir({ shard });
          await shardDir.removeEntry(volumeId, { recursive: true });
          break;
        }
        case 'host':
          await this.hostVolumeDB.delete({ id: volumeId });
          break;
        default: {
          const _ex: never = volume;
          throw new Error(`Unhandled volume type: ${JSON.stringify(_ex)}`);
        }
        }

        delete index.volumes[volumeId];
        await this.saveVolumeShardIndex({ shard, index });
      }
    } catch (e) {
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
