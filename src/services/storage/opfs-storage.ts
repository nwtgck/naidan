import type { Chat, Settings, ChatGroup, SidebarItem } from '../../models/types';
import { 
  SettingsSchemaDto,
  ChatMetaSchemaDto,
  ChatContentSchemaDto,
  ChatMetaIndexSchemaDto,
  type ChatGroupDto, 
  type ChatDto, 
  type ChatMetaDto,
  type ChatContentDto,
  type MigrationChunkDto,
  type ChatMetaIndexDto,
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
  private readonly STORAGE_DIR = 'llm-web-ui-storage';

  async init(): Promise<void> {
    if (!this.root) {
      const opfsRoot = await navigator.storage.getDirectory();
      this.root = await opfsRoot.getDirectoryHandle(this.STORAGE_DIR, { create: true });
    }
  }

  private async getChatContentsDir(): Promise<FileSystemDirectoryHandle> {
    await this.init();
    return await this.root!.getDirectoryHandle('chat_contents', { create: true });
  }

  private async getGroupsDir(): Promise<FileSystemDirectoryHandle> {
    await this.init();
    return await this.root!.getDirectoryHandle('groups', { create: true });
  }

  // --- Internal Data Access ---

  protected async listChatMetasRaw(): Promise<ChatMetaDto[]> {
    await this.init();
    try {
      const fileHandle = await this.root!.getFileHandle('chat_metas.json');
      const file = await fileHandle.getFile();
      const text = await file.text();
      const json = JSON.parse(text);
      const validated = ChatMetaIndexSchemaDto.parse(json);
      return validated.entries;
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
    const fullDto = chatToDto(chat, index);
    
    // 1. Extract and Save Content (Large)
    const contentDto: ChatContentDto = {
      root: fullDto.root || { items: [] },
      currentLeafId: fullDto.currentLeafId,
    };
    ChatContentSchemaDto.parse(contentDto);
    
    const contentsDir = await this.getChatContentsDir();
    const contentFileHandle = await contentsDir.getFileHandle(`${chat.id}.json`, { create: true }) as FileSystemFileHandleWithWritable;
    const contentWritable = await contentFileHandle.createWritable();
    await contentWritable.write(JSON.stringify(contentDto));
    await contentWritable.close();

    // 2. Extract and Save Meta (Small)
    const { root: _r, currentLeafId: _c, ...metaDto } = fullDto;
    ChatMetaSchemaDto.parse(metaDto);
    await this.updateMetaIndex(metaDto as ChatMetaDto);
  }

  private async updateMetaIndex(metaDto: ChatMetaDto): Promise<void> {
    await this.init();
    const entries: ChatMetaDto[] = await this.listChatMetasRaw();
    const existingIndex = entries.findIndex(m => m.id === metaDto.id);
    if (existingIndex >= 0) entries[existingIndex] = metaDto;
    else entries.push(metaDto);
    
    const indexDto: ChatMetaIndexDto = { entries };
    
    const fileHandle = await this.root!.getFileHandle('chat_metas.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(indexDto));
    await writable.close();
  }

  async loadChat(id: string): Promise<Chat | null> {
    try {
      // 1. Load Meta from index
      const metas = await this.listChatMetasRaw();
      const meta = metas.find(m => m.id === id);
      if (!meta) return null;

      // 2. Load Content from file
      const contentsDir = await this.getChatContentsDir();
      const fileHandle = await contentsDir.getFileHandle(`${id}.json`);
      const file = await fileHandle.getFile();
      const text = await file.text();
      const content = ChatContentSchemaDto.parse(JSON.parse(text));

      // 3. Combine
      const fullDto: ChatDto = {
        ...meta,
        ...content,
      };
      
      return chatToDomain(fullDto);
    } catch { return null; }
  }

  async deleteChat(id: string): Promise<void> {
    try {
      // 1. Remove content file
      const contentsDir = await this.getChatContentsDir();
      await contentsDir.removeEntry(`${id}.json`);
      
      // 2. Update meta index
      const entries = (await this.listChatMetasRaw()).filter(m => m.id !== id);
      const indexDto: ChatMetaIndexDto = { entries };
      
      const fileHandle = await this.root!.getFileHandle('chat_metas.json', { create: true }) as FileSystemFileHandleWithWritable;
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(indexDto));
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
      
      // Detach chats from this group in the meta index
      const entries = await this.listChatMetasRaw();
      let changed = false;
      for (const m of entries) {
        if (m.groupId === id) {
          m.groupId = null;
          changed = true;
        }
      }
      
      if (changed) {
        const indexDto: ChatMetaIndexDto = { entries };
        const fileHandle = await this.root!.getFileHandle('chat_metas.json', { create: true }) as FileSystemFileHandleWithWritable;
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(indexDto));
        await writable.close();
      }
    } catch { /* ignore */ }
  }

  public override async getSidebarStructure(): Promise<SidebarItem[]> {
    const [metas, groups] = await Promise.all([
      this.listChatMetasRaw(),
      this.listGroupsRaw(),
    ]);
    return buildSidebarItemsFromDtos(groups, metas);
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
      yield { type: 'settings', data: settingsToDto(settings) };
    }

    // 2. Groups
    const groups = await this.listGroupsRaw();
    for (const group of groups) {
      yield { type: 'group', data: group };
    }

    // 3. Chats (Combining Meta and Content for migration)
    const metas = await this.listChatMetasRaw();
    for (const meta of metas) {
      const chat = await this.loadChat(meta.id);
      if (chat) {
        yield { type: 'chat', data: chatToDto(chat, meta.order ?? 0) };
      }
    }
  }

  async restore(stream: AsyncGenerator<MigrationChunkDto>): Promise<void> {
    await this.clearAll();
    await this.init();

    const metas: ChatMetaDto[] = [];

    for await (const chunk of stream) {
      switch (chunk.type) {
      case 'settings': {
        await this.saveSettings(settingsToDomain(chunk.data));
        break;
      }
      case 'group': {
        // Direct write group file
        const groupsDir = await this.getGroupsDir();
        const fileHandle = await groupsDir.getFileHandle(`${chunk.data.id}.json`, { create: true }) as FileSystemFileHandleWithWritable;
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(chunk.data as ChatGroupDto));
        await writable.close();
        break;
      }
      case 'chat': {
        const fullDto = chunk.data;
        // Save content file
        const contentsDir = await this.getChatContentsDir();
        const contentFileHandle = await contentsDir.getFileHandle(`${fullDto.id}.json`, { create: true }) as FileSystemFileHandleWithWritable;
        const contentWritable = await contentFileHandle.createWritable();
        const { root, currentLeafId } = fullDto;
        await contentWritable.write(JSON.stringify({ 
          root: root || { items: [] }, 
          currentLeafId 
        }));
        await contentWritable.close();
          
        // Add to metas
        const { root: _r, currentLeafId: _c, ...meta } = fullDto;
        metas.push(meta as ChatMetaDto);
        break;
      }
      }
    }

    // Write final meta index
    const indexDto: ChatMetaIndexDto = { entries: metas };
    const fileHandle = await this.root!.getFileHandle('chat_metas.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(indexDto));
    await writable.close();
  }
}