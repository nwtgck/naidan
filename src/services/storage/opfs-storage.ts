import type { Chat, Settings, ChatGroup, SidebarItem } from '../../models/types';
import { 
  ChatSchemaDto, 
  SettingsSchemaDto, 
  type ChatGroupDto, 
  type ChatDto, 
  type MigrationChunkDto, 
} from '../../models/dto';
import { 
  chatToDomain,
  chatToDto,
  settingsToDomain,
  settingsToDto,
  chatGroupToDto,
  buildSidebarItemsFromDtos,
} from '../../models/mappers';
import { IStorageProvider } from './interface';

interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

export class OPFSStorageProvider extends IStorageProvider {
  private root: FileSystemDirectoryHandle | null = null;

  async init(): Promise<void> {
    if (!this.root) {
      this.root = await navigator.storage.getDirectory();
    }
  }

  private async getChatsDir(): Promise<FileSystemDirectoryHandle> {
    await this.init();
    return await this.root!.getDirectoryHandle('chats', { create: true });
  }

  private async getGroupsDir(): Promise<FileSystemDirectoryHandle> {
    await this.init();
    return await this.root!.getDirectoryHandle('groups', { create: true });
  }

  // --- Internal Data Access ---

  protected async listChatsRaw(): Promise<ChatDto[]> {
    await this.init();
    try {
      const fileHandle = await this.root!.getFileHandle('index.json');
      const file = await fileHandle.getFile();
      const text = await file.text();
      const json = JSON.parse(text);
      if (Array.isArray(json)) return json as ChatDto[];
      return [];
    } catch { return []; }
  }

  protected async listGroupsRaw(): Promise<ChatGroupDto[]> {
    try {
      const groupsDir = await this.getGroupsDir();
      const dtos: ChatGroupDto[] = [];
      // @ts-expect-error: values() is missing in some types
      for await (const entry of groupsDir.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.json')) {
          const file = await entry.getFile();
          const text = await file.text();
          dtos.push(JSON.parse(text));
        }
      }
      return dtos;
    } catch { return []; }
  }

  // --- Persistence Implementation ---

  async saveChat(chat: Chat, index: number): Promise<void> {
    const dto = chatToDto(chat, index);
    ChatSchemaDto.parse(dto);
    const chatsDir = await this.getChatsDir();
    const fileHandle = await chatsDir.getFileHandle(`${chat.id}.json`, { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(dto));
    await writable.close();
    await this.updateIndex(dto);
  }

  private async updateIndex(chatDto: ChatDto): Promise<void> {
    await this.init();
    const index: ChatDto[] = await this.listChatsRaw();
    const existingIndex = index.findIndex(c => c.id === chatDto.id);
    if (existingIndex >= 0) index[existingIndex] = chatDto;
    else index.push(chatDto);
    
    const fileHandle = await this.root!.getFileHandle('index.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(index));
    await writable.close();
  }

  async loadChat(id: string): Promise<Chat | null> {
    try {
      const chatsDir = await this.getChatsDir();
      const fileHandle = await chatsDir.getFileHandle(`${id}.json`);
      const file = await fileHandle.getFile();
      const text = await file.text();
      return chatToDomain(ChatSchemaDto.parse(JSON.parse(text)));
    } catch { return null; }
  }

  async deleteChat(id: string): Promise<void> {
    try {
      const chatsDir = await this.getChatsDir();
      await chatsDir.removeEntry(`${id}.json`);
      const indexList = (await this.listChatsRaw()).filter(c => c.id !== id);
      const fileHandle = await this.root!.getFileHandle('index.json', { create: true }) as FileSystemFileHandleWithWritable;
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(indexList));
      await writable.close();
    } catch { /* ignore */ }
  }

  async saveGroup(group: ChatGroup, index: number): Promise<void> {
    const dto = chatGroupToDto(group, index);
    const groupsDir = await this.getGroupsDir();
    const fileHandle = await groupsDir.getFileHandle(`${group.id}.json`, { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(dto));
    await writable.close();
  }

  async loadGroup(_id: string): Promise<ChatGroup | null> {
    return null;
  }

  async deleteGroup(id: string): Promise<void> {
    try {
      const groupsDir = await this.getGroupsDir();
      await groupsDir.removeEntry(`${id}.json`);
      const chats = await this.listChatsRaw();
      for (const c of chats) {
        if (c.groupId === id) {
          const fullChat = await this.loadChat(c.id);
          if (fullChat) {
            fullChat.groupId = null;
            await this.saveChat(fullChat, c.order ?? 0);
          }
        }
      }
    } catch { /* ignore */ }
  }

  public override async getSidebarStructure(): Promise<SidebarItem[]> {
    const [chats, groups] = await Promise.all([
      this.listChatsRaw(),
      this.listGroupsRaw(),
    ]);
    return buildSidebarItemsFromDtos(groups, chats);
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
      const text = await file.text();
      return settingsToDomain(SettingsSchemaDto.parse(JSON.parse(text)));
    } catch { return null; }
  }

  async clearAll(): Promise<void> {
    await this.init();
    // @ts-expect-error: keys() is missing in some types
    for await (const key of this.root!.keys()) {
      await this.root!.removeEntry(key, { recursive: true });
    }
  }

  // --- Migration Implementation ---

  async *dump(): AsyncGenerator<MigrationChunkDto> {
    await this.init();

    // 1. Settings
    const settings = await this.loadSettings();
    if (settings) {
      // Re-serialize strictly
      const dto = settingsToDto(settings);
      yield { type: 'settings', data: dto };
    }

    // 2. Groups
    const groups = await this.listGroupsRaw();
    for (const group of groups) {
      yield { type: 'group', data: group };
    }

    // 3. Chats
    // Iterate manually over files to avoid loading ALL chats into memory via listChatsRaw() 
    // IF listChatsRaw reads everything.
    // Looking at listChatsRaw implementation: it reads 'index.json' which is just metadata.
    // BUT we need the FULL content for migration.
    // So we iterate the index, then load each full chat file.
    const index = await this.listChatsRaw();
    const chatsDir = await this.getChatsDir();
    
    for (const meta of index) {
      try {
        const fileHandle = await chatsDir.getFileHandle(`${meta.id}.json`);
        const file = await fileHandle.getFile();
        const text = await file.text();
        const fullDto = ChatSchemaDto.parse(JSON.parse(text));
        yield { type: 'chat', data: fullDto };
      } catch (e) {
        console.warn(`Failed to export chat ${meta.id}`, e);
        // Continue to next chat even if one fails
      }
    }
  }

  async restore(stream: AsyncGenerator<MigrationChunkDto>): Promise<void> {
    await this.clearAll();
    await this.init();

    // Prepare directories
    const chatsDir = await this.getChatsDir();
    const groupsDir = await this.getGroupsDir();

    // Cache the chat index to write it once at the end? 
    // Or update incrementally?
    // Incremental is safer but slower. 
    // Let's build an in-memory index and write it periodically or at the end.
    // For safety against crash during migration, we might want to write regularly.
    // But since restore() clears all first, a crash leaves us in broken state anyway.
    // So writing index at the end is acceptable for performance.
    const chatIndex: ChatDto[] = [];

    for await (const chunk of stream) {
      switch (chunk.type) {
      case 'settings': {
        await this.saveSettings(settingsToDomain(chunk.data));
        break;
      }
      case 'group': {
        // Direct write
        const fileHandle = await groupsDir.getFileHandle(`${chunk.data.id}.json`, { create: true }) as FileSystemFileHandleWithWritable;
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(chunk.data));
        await writable.close();
        break;
      }
      case 'chat': {
        const dto = chunk.data;
        // Write chat file
        const fileHandle = await chatsDir.getFileHandle(`${dto.id}.json`, { create: true }) as FileSystemFileHandleWithWritable;
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(dto));
        await writable.close();
          
        // Add to index
        chatIndex.push(dto);
        break;
      }
      default: {
        const _exhaustiveCheck: never = chunk;
        throw new Error(`Unhandled migration chunk type: ${JSON.stringify(_exhaustiveCheck)}`);
      }
      
      }
    }

    // Write final chat index
    const fileHandle = await this.root!.getFileHandle('index.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(chatIndex));
    await writable.close();
  }
}
