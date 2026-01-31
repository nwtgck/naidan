import type { Chat, Settings, ChatGroup, SidebarItem, MessageNode, ChatMeta, ChatContent, StorageSnapshot } from '../../models/types';
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
} from '../../models/mappers';import { IStorageProvider } from './interface';

interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

export class OPFSStorageProvider extends IStorageProvider {
  private root: FileSystemDirectoryHandle | null = null;
  private readonly STORAGE_DIR = 'naidan-storage';
  readonly canPersistBinary = true;

  async init(): Promise<void> {
    if (!this.root) {
      const opfsRoot = await navigator.storage.getDirectory();
      this.root = await opfsRoot.getDirectoryHandle(this.STORAGE_DIR, { create: true });
    }
  }

  private async getDir(name: string): Promise<FileSystemDirectoryHandle> {
    await this.init();
    return await this.root!.getDirectoryHandle(name, { create: true });
  }

  // --- Internal Data Access ---

  protected async listChatMetasRaw(): Promise<ChatMetaDto[]> {
    try {
      const dir = await this.getDir('chat-metas');
      const dtos: ChatMetaDto[] = [];
      // @ts-expect-error: values() is missing in some types
      for await (const entry of dir.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.json')) {
          const file = await entry.getFile();
          dtos.push(JSON.parse(await file.text()));
        }
      }
      return dtos;
    } catch { return []; }
  }

  protected async listChatGroupsRaw(): Promise<ChatGroupDto[]> {
    try {
      const dir = await this.getDir('chat-groups');
      const dtos: ChatGroupDto[] = [];
      // @ts-expect-error: values() is missing in some types
      for await (const entry of dir.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.json')) {
          const file = await entry.getFile();
          dtos.push(JSON.parse(await file.text()));
        }
      }
      return dtos;
    } catch { return []; }
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

      return chat;
    } catch { return null; }
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
    } catch { return null; }
  }

  async loadChatContent(id: string): Promise<ChatContent | null> {
    try {
      const contentDir = await this.getDir('chat-contents');
      const contentFile = await (await contentDir.getFileHandle(`${id}.json`)).getFile();
      const dto = ChatContentSchemaDto.parse(JSON.parse(await contentFile.text()));
      return chatContentToDomain(dto);
    } catch { return null; }
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
    } catch { return null; }
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

  // --- File Storage ---

  private async getUploadedFilesDir(): Promise<FileSystemDirectoryHandle> {
    return await this.getDir('uploaded-files');
  }

  async saveFile(blob: Blob, attachmentId: string, originalName: string): Promise<void> {
    const uploadedFilesDir = await this.getUploadedFilesDir();
    const fileDir = await uploadedFilesDir.getDirectoryHandle(attachmentId, { create: true });
    const fileHandle = await fileDir.getFileHandle(originalName, { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  async getFile(attachmentId: string, originalName: string): Promise<Blob | null> {
    try {
      const uploadedFilesDir = await this.getUploadedFilesDir();
      const fileDir = await uploadedFilesDir.getDirectoryHandle(attachmentId);
      const fileHandle = await fileDir.getFileHandle(originalName);
      return await fileHandle.getFile();
    } catch { return null; }
  }

  async hasAttachments(): Promise<boolean> {
    try {
      const uploadedFilesDir = await this.getUploadedFilesDir();
      // @ts-expect-error: values()
      for await (const entry of uploadedFilesDir.values()) if (entry) return true;
      return false;
    } catch { return false; }
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
    } catch { return null; }
  }

  async clearAll(): Promise<void> {
    await this.init();
    // @ts-expect-error: keys()
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
      for (const meta of rawMetas) {
        const chat = await this.loadChat(meta.id);
        if (chat) {
          yield { type: 'chat' as const, data: chatToDto(chat) };
          const findAndYieldFiles = async function* (this: OPFSStorageProvider, nodes: MessageNode[]): AsyncGenerator<MigrationChunkDto> {
            for (const node of nodes) {
              if (node.attachments) {
                for (const att of node.attachments) {
                  switch (att.status) {
                  case 'persisted': {
                    const blob = await this.getFile(att.id, att.originalName);
                    if (blob) yield { type: 'attachment' as const, chatId: chat.id, attachmentId: att.id, originalName: att.originalName, mimeType: att.mimeType, size: att.size, uploadedAt: att.uploadedAt, blob };
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
              if (node.replies?.items) yield* findAndYieldFiles.call(this, node.replies.items);
            }
          };
          yield* findAndYieldFiles.call(this, chat.root.items);
        }
      }
    };

    return {
      structure: {
        settings: settings || ({} as Settings),
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
      case 'attachment': await this.saveFile(chunk.blob, chunk.attachmentId, chunk.originalName); break;
      default: {
        const _ex: never = type;
        throw new Error(`Unknown chunk type: ${_ex}`);
      }
      }
    }
  }
}