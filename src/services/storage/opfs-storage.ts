import type { Chat, Settings, ChatGroup, SidebarItem, MessageNode, ChatMeta, ChatContent, StorageSnapshot, BinaryObject } from '../../models/types';
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
} from '../../models/dto';
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
} from '../../models/mappers';import { IStorageProvider } from './interface';

import { 
  type MigrationStateDto,
  type BinaryShardIndexDto,
  MigrationStateSchemaDto,
  BinaryShardIndexSchemaDto,
} from '../../models/dto';

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
    if (!this.root) {
      const opfsRoot = await navigator.storage.getDirectory();
      this.root = await opfsRoot.getDirectoryHandle(this.STORAGE_DIR, { create: true });
      await this.runMigrations();
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

  private async saveMigrationState(state: MigrationStateDto): Promise<void> {
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
      await this.saveMigrationState(state);
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
              const newBinaryObjectId = crypto.randomUUID();
              
              // Save to new location with NEW ID
              await this.saveFile(blob, newBinaryObjectId, fileEntry.name);
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
      const contentDir = await this.getDir('chat-contents');
      for await (const entry of contentDir.values()) {
        const entryKind = entry.kind;
        switch (entryKind) {
        case 'file': {
          if (entry.name.endsWith('.json')) {
            try {
              const file = await (entry as FileSystemFileHandle).getFile();
              const content = JSON.parse(await file.text());
              
              let modified = false;
              const processNodes = (nodes: unknown[]) => {
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
                  if (replies?.items) processNodes(replies.items as unknown[]);
                }
              };

              if (content.root?.items) {
                processNodes(content.root.items);
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

  private async getDir(name: string, parent: FileSystemDirectoryHandle = this.root!): Promise<FileSystemDirectoryHandle> {
    await this.init();
    return await parent.getDirectoryHandle(name, { create: true });
  }

  // --- Binary Object Storage (Sharded) ---

  private getBinaryObjectShardPath(id: string): string {
    return id.slice(-2).toLowerCase();
  }

  private async getBinaryObjectsDir(): Promise<FileSystemDirectoryHandle> {
    return await this.getDir('binary-objects');
  }

  private async getShardDir(shard: string): Promise<FileSystemDirectoryHandle> {
    const baseDir = await this.getBinaryObjectsDir();
    return await this.getDir(shard, baseDir);
  }

  private async loadShardIndex(shard: string): Promise<BinaryShardIndex> {
    try {
      const dir = await this.getShardDir(shard);
      const fileHandle = await dir.getFileHandle('index.json');
      const file = await fileHandle.getFile();
      return BinaryShardIndexSchemaDto.parse(JSON.parse(await file.text()));
    } catch {
      return { objects: {} };
    }
  }

  private async saveShardIndex(shard: string, index: BinaryShardIndex): Promise<void> {
    const dir = await this.getShardDir(shard);
    const fileHandle = await dir.getFileHandle('index.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(index));
    await writable.close();
  }

  private async hydrateAttachments(nodes: MessageNode[]): Promise<void> {
    const shardCache = new Map<string, BinaryShardIndex>();

    const processNodes = async (items: MessageNode[]) => {
      for (const node of items) {
        if (node.attachments) {
          for (let i = 0; i < node.attachments.length; i++) {
            const att = node.attachments[i];
            if (!att) continue;
            
            const status = att.status;
            switch (status) {
            case 'persisted': {
              const shard = this.getBinaryObjectShardPath(att.binaryObjectId);
              let index = shardCache.get(shard);
              if (!index) {
                index = await this.loadShardIndex(shard);
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
          await processNodes(node.replies.items);
        }
      }
    };

    await processNodes(nodes);
  }

  // --- Internal Data Access ---

  protected async listChatMetasRaw(): Promise<ChatMetaDto[]> {
    try {
      const dir = await this.getDir('chat-metas');
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
      const dir = await this.getDir('chat-groups');
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
    await this.init();
    try {
      const fileHandle = await this.root!.getFileHandle('hierarchy.json');
      const file = await fileHandle.getFile();
      return HierarchySchemaDto.parse(JSON.parse(await file.text()));
    } catch { 
      // If file doesn't exist or is invalid, return empty hierarchy
      return { items: [] }; 
    }
  }

  async saveHierarchy(hierarchy: HierarchyDto): Promise<void> {
    await this.init();
    const fileHandle = await this.root!.getFileHandle('hierarchy.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(hierarchy));
    await writable.close();
  }

  // --- Persistence Implementation ---

  async saveChatMeta(meta: ChatMeta): Promise<void> {
    const dto = chatMetaToDto(meta);
    ChatMetaSchemaDto.parse(dto);
    const dir = await this.getDir('chat-metas');
    const fileHandle = await dir.getFileHandle(`${meta.id}.json`, { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(dto));
    await writable.close();
  }

  async saveChatContent(id: string, content: ChatContent): Promise<void> {
    const dto = chatContentToDto(content);
    ChatContentSchemaDto.parse(dto);
    const dir = await this.getDir('chat-contents');
    const fileHandle = await dir.getFileHandle(`${id}.json`, { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(dto));
    await writable.close();
  }

  async loadChat(id: string): Promise<Chat | null> {
    try {
      const metaDir = await this.getDir('chat-metas');
      const contentDir = await this.getDir('chat-contents');
      
      const metaFile = await (await metaDir.getFileHandle(`${id}.json`)).getFile();
      const contentFile = await (await contentDir.getFileHandle(`${id}.json`)).getFile();
      
      const meta = ChatMetaSchemaDto.parse(JSON.parse(await metaFile.text()));
      const content = ChatContentSchemaDto.parse(JSON.parse(await contentFile.text()));
      
      const chat = chatToDomain({ ...meta, ...content });

      // Resolve groupId from hierarchy
      const hierarchy = await this.loadHierarchy();
      if (hierarchy) {
        const group = hierarchy.items.find(i => i.type === 'chat_group' && i.chat_ids.includes(id));
        if (group) chat.groupId = group.id;
      }

      // Hydrate attachments with metadata from BinaryObject indices
      await this.hydrateAttachments(chat.root.items);

      return chat;
    } catch {
      return null; 
    }
  }

  async loadChatMeta(id: string): Promise<ChatMeta | null> {
    try {
      const metaDir = await this.getDir('chat-metas');
      const metaFile = await (await metaDir.getFileHandle(`${id}.json`)).getFile();
      const meta = chatMetaToDomain(ChatMetaSchemaDto.parse(JSON.parse(await metaFile.text())));

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

  async loadChatContent(id: string): Promise<ChatContent | null> {
    try {
      const contentDir = await this.getDir('chat-contents');
      const contentFile = await (await contentDir.getFileHandle(`${id}.json`)).getFile();
      const dto = ChatContentSchemaDto.parse(JSON.parse(await contentFile.text()));
      const content = chatContentToDomain(dto);

      // Hydrate attachments
      await this.hydrateAttachments(content.root.items);

      return content;
    } catch {
      return null; 
    }
  }

  async deleteChat(id: string): Promise<void> {
    try {
      const metaDir = await this.getDir('chat-metas');
      const contentDir = await this.getDir('chat-contents');
      await metaDir.removeEntry(`${id}.json`);
      await contentDir.removeEntry(`${id}.json`);
    } catch { /* ignore */ }
  }

  async saveChatGroup(chatGroup: ChatGroup): Promise<void> {
    const dto = chatGroupToDto(chatGroup);
    ChatGroupSchemaDto.parse(dto);
    const dir = await this.getDir('chat-groups');
    const fileHandle = await dir.getFileHandle(`${chatGroup.id}.json`, { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(dto));
    await writable.close();
  }

  async loadChatGroup(id: string): Promise<ChatGroup | null> {
    try {
      const dir = await this.getDir('chat-groups');
      const file = await (await dir.getFileHandle(`${id}.json`)).getFile();
      const groupDto = ChatGroupSchemaDto.parse(JSON.parse(await file.text()));
      
      const [hierarchy, allMetas] = await Promise.all([
        this.loadHierarchy(),
        this.listChatMetasRaw()
      ]);

      const chatMetas = allMetas.map(chatMetaToDomain);
      const h = hierarchy || { items: [] };
      return chatGroupToDomain(groupDto, h, chatMetas);
    } catch {
      return null; 
    }
  }

  async deleteChatGroup(id: string): Promise<void> {
    try {
      const dir = await this.getDir('chat-groups');
      await dir.removeEntry(`${id}.json`);
    } catch { /* ignore */ }
  }

  public override async getSidebarStructure(): Promise<SidebarItem[]> {
    const [rawHierarchy, rawMetas, rawGroups] = await Promise.all([
      this.loadHierarchy(),
      this.listChatMetasRaw(),
      this.listChatGroupsRaw(),
    ]);

    const hierarchy = hierarchyToDomain(rawHierarchy || { items: [] });
    const chatMetas = rawMetas.map(chatMetaToDomain);
    const chatGroups = rawGroups.map(g => chatGroupToDomain(g, hierarchy, chatMetas));

    return buildSidebarItemsFromHierarchy(hierarchy, chatMetas, chatGroups);
  }

  // --- Binary Object Storage ---

  async saveFile(blobOrParams: Blob | { blob: Blob; binaryObjectId: string; name: string; mimeType: string | undefined }, binaryObjectId?: string, name?: string, mimeType?: string): Promise<void> {
    let blob: Blob;
    let bId: string;
    let fileName: string;
    let mType: string | undefined;

    if (blobOrParams instanceof Blob) {
      blob = blobOrParams;
      bId = binaryObjectId!;
      fileName = name!;
      mType = mimeType;
    } else {
      blob = blobOrParams.blob;
      bId = blobOrParams.binaryObjectId;
      fileName = blobOrParams.name;
      mType = blobOrParams.mimeType;
    }

    const shard = this.getBinaryObjectShardPath(bId);
    const dir = await this.getShardDir(shard);

    // 1. Write Blob
    const binFileName = `${bId}.bin`;
    const fileHandle = await dir.getFileHandle(binFileName, { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    // Convert blob to ArrayBuffer for compatibility
    await writable.write(await blob.arrayBuffer());
    await writable.close();

    // 2. Write Marker
    const markerName = `.${binFileName}.complete`;
    await dir.getFileHandle(markerName, { create: true });

    // 3. Update Index
    const index = await this.loadShardIndex(shard);
    index.objects[bId] = {
      id: bId,
      mimeType: mType || blob.type || 'application/octet-stream',
      size: blob.size,
      createdAt: Date.now(),
      name: fileName,
    };
    await this.saveShardIndex(shard, index);
  }

  async getFile(binaryObjectId: string): Promise<Blob | null> {
    try {
      const shard = this.getBinaryObjectShardPath(binaryObjectId);
      const dir = await this.getShardDir(shard);
      const fileName = `${binaryObjectId}.bin`;
      const markerName = `.${fileName}.complete`;

      // Verify completion marker
      await dir.getFileHandle(markerName);

      const fileHandle = await dir.getFileHandle(fileName);
      return await fileHandle.getFile();
    } catch {
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
    await this.init();
    try {
      const baseDir = await this.getBinaryObjectsDir();
      for await (const shardEntry of baseDir.values()) {
        const kind = shardEntry.kind;
        switch (kind) {
        case 'directory': {
          const index = await this.loadShardIndex(shardEntry.name);
          for (const obj of Object.values(index.objects)) {
            yield binaryObjectToDomain(obj);
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

  async deleteBinaryObject(binaryObjectId: string): Promise<void> {
    await this.init();
    const shard = this.getBinaryObjectShardPath(binaryObjectId);
    const dir = await this.getShardDir(shard);
    const fileName = `${binaryObjectId}.bin`;
    const markerName = `.${fileName}.complete`;

    try {
      await dir.removeEntry(fileName);
    } catch { /* ignore */ }
    try {
      await dir.removeEntry(markerName);
    } catch { /* ignore */ }

    const index = await this.loadShardIndex(shard);
    if (index.objects[binaryObjectId]) {
      delete index.objects[binaryObjectId];
      await this.saveShardIndex(shard, index);
    }
  }

  async saveSettings(settings: Settings): Promise<void> {
    await this.init();
    const dto = settingsToDto(settings);
    const validated = SettingsSchemaDto.parse(dto);
    const fileHandle = await this.root!.getFileHandle('settings.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(validated));
    await writable.close();
  }

  async loadSettings(): Promise<Settings | null> {
    await this.init();
    try {
      const fileHandle = await this.root!.getFileHandle('settings.json');
      const file = await fileHandle.getFile();
      return settingsToDomain(SettingsSchemaDto.parse(JSON.parse(await file.text())));
    } catch {
      return null; 
    }
  }

  async clearAll(): Promise<void> {
    await this.init();
    for await (const key of this.root!.keys()) {
      await this.root!.removeEntry(key, { recursive: true });
    }
  }

  // --- Migration Implementation ---

  async dump(): Promise<StorageSnapshot> {
    await this.init();
    const [settings, hierarchy, rawMetas, rawGroups] = await Promise.all([
      this.loadSettings(),
      this.loadHierarchy(),
      this.listChatMetasRaw(),
      this.listChatGroupsRaw(),
    ]);

    const chatGroups = rawGroups.map(g => chatGroupToDomain(g, hierarchy || { items: [] }, []));
    const chatMetas = rawMetas.map(chatMetaToDomain);

    const contentStream = async function* (this: OPFSStorageProvider): AsyncGenerator<MigrationChunkDto> {
      // 1. Stream all chats
      for (const meta of rawMetas) {
        const chat = await this.loadChat(meta.id);
        if (chat) {
          yield { type: 'chat' as const, data: chatToDto(chat) };
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
            const index = await this.loadShardIndex(shard);
            for (const bId of Object.keys(index.objects)) {
              const meta = index.objects[bId]!;
              const blob = await this.getFile(bId);
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

  async restore(snapshot: StorageSnapshot): Promise<void> {
    const { structure, contentStream } = snapshot;
    await this.init();

    // 1. Restore Structural Metadata
    if (structure.settings) await this.saveSettings(structure.settings);
    if (structure.hierarchy) await this.saveHierarchy(structure.hierarchy);
    if (structure.chatMetas) {
      for (const meta of structure.chatMetas) await this.saveChatMeta(meta);
    }
    if (structure.chatGroups) {
      for (const group of structure.chatGroups) await this.saveChatGroup(group);
    }

    // 2. Restore Heavy Content
    for await (const chunk of contentStream) {
      const type = chunk.type;
      switch (type) {
      case 'chat': {
        const domainChat = chatToDomain(chunk.data);
        await this.saveChatContent(domainChat.id, domainChat);
        await this.saveChatMeta(domainChat);
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
}