import type { Chat, Settings, ChatGroup, SidebarItem, MessageNode } from '../../models/types';
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
  type MessageNodeDto,
} from '../../models/dto';
import { 
  chatToDomain,
  chatToDto,
  settingsToDomain,
  settingsToDto,
  chatGroupToDto,
  chatGroupToDomain,
  buildSidebarItemsFromDtos,
} from '../../models/mappers';
import { IStorageProvider } from './interface';

interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

export class OPFSStorageProvider extends IStorageProvider {
  private root: FileSystemDirectoryHandle | null = null;
  private readonly STORAGE_DIR = 'llm-web-ui-storage';
  readonly canPersistBinary = true;

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

  // --- File Storage ---

  private async getUploadedFilesDir(): Promise<FileSystemDirectoryHandle> {
    await this.init();
    return await this.root!.getDirectoryHandle('uploaded_files', { create: true });
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
    } catch {
      return null;
    }
  }

  async hasAttachments(): Promise<boolean> {
    try {
      const uploadedFilesDir = await this.getUploadedFilesDir();
      // @ts-expect-error: values() is missing in some types
      for await (const entry of uploadedFilesDir.values()) {
        if (entry) return true;
      }
      return false;
    } catch {
      return false;
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

        // Yield attachments
        const findAndYieldFiles = async function* (this: OPFSStorageProvider, nodes: MessageNode[]): AsyncGenerator<MigrationChunkDto> {
          for (const node of nodes) {
            if (node.attachments) {
              for (const att of node.attachments) {
                if (att.status === 'persisted') {
                  const blob = await this.getFile(att.id, att.originalName);
                  if (blob) {
                    yield {
                      type: 'attachment',
                      chatId: chat.id,
                      attachmentId: att.id,
                      originalName: att.originalName,
                      mimeType: att.mimeType,
                      size: att.size,
                      uploadedAt: att.uploadedAt,
                      blob
                    };
                  }
                }
              }
            }
            if (node.replies?.items) {
              yield* findAndYieldFiles.call(this, node.replies.items);
            }
          }
        };
        yield* findAndYieldFiles.call(this, chat.root.items);
      }
    }
  }

  async restore(stream: AsyncGenerator<MigrationChunkDto>): Promise<void> {
    await this.clearAll();
    await this.init();

    const metas: ChatMetaDto[] = [];
    const chats = new Map<string, ChatDto>();
    const pendingAttachments = new Map<string, { attachmentId: string; blob: Blob; originalName: string; mimeType: string; size: number; uploadedAt: number }[]>();

    for await (const chunk of stream) {
      switch (chunk.type) {
      case 'settings': {
        await this.saveSettings(settingsToDomain(chunk.data));
        break;
      }
      case 'group': {
        await this.saveGroup(chatGroupToDomain(chunk.data), chunk.data.order ?? 0);
        break;
      }
      case 'chat': {
        chats.set(chunk.data.id, chunk.data);
        // Process any pending attachments for this chat
        const pending = pendingAttachments.get(chunk.data.id);
        if (pending) {
          for (const att of pending) {
            await this.saveFile(att.blob, att.attachmentId, att.originalName);
            const updateStatus = (nodes: MessageNodeDto[]) => {
              for (const node of nodes) {
                if (node.attachments) {
                  for (const a of node.attachments) {
                    if (a.id === att.attachmentId) {
                      a.status = 'persisted';
                      a.mimeType = att.mimeType;
                      a.size = att.size;
                      a.uploadedAt = att.uploadedAt;
                    }
                  }
                }
                if (node.replies?.items) updateStatus(node.replies.items);
              }
            };
            if (chunk.data.root?.items) updateStatus(chunk.data.root.items);
          }
          pendingAttachments.delete(chunk.data.id);
        }
        break;
      }
      case 'attachment': {
        const chatDto = chats.get(chunk.chatId);
        if (chatDto) {
          await this.saveFile(chunk.blob, chunk.attachmentId, chunk.originalName);
          const updateStatus = (nodes: MessageNodeDto[]) => {
            for (const node of nodes) {
              if (node.attachments) {
                for (const att of node.attachments) {
                  if (att.id === chunk.attachmentId) {
                    att.status = 'persisted';
                    att.mimeType = chunk.mimeType;
                    att.size = chunk.size;
                    att.uploadedAt = chunk.uploadedAt;
                  }
                }
              }
              if (node.replies?.items) updateStatus(node.replies.items);
            }
          };
          if (chatDto.root?.items) updateStatus(chatDto.root.items);
          // Re-set to ensure the map reflects the change (important for immutability/reactivity if needed)
          chats.set(chunk.chatId, { ...chatDto });
        } else {
          // Store for later when 'chat' chunk arrives
          const pending = pendingAttachments.get(chunk.chatId) || [];
          pending.push({ 
            attachmentId: chunk.attachmentId, 
            blob: chunk.blob, 
            originalName: chunk.originalName,
            mimeType: chunk.mimeType,
            size: chunk.size,
            uploadedAt: chunk.uploadedAt
          });
          pendingAttachments.set(chunk.chatId, pending);
        }
        break;
      }
      }
    }

    // After all chunks are processed, save the (potentially updated) chats
    for (const [id, fullDto] of chats.entries()) {
      const contentsDir = await this.getChatContentsDir();
      const contentFileHandle = await contentsDir.getFileHandle(`${id}.json`, { create: true }) as FileSystemFileHandleWithWritable;
      const contentWritable = await contentFileHandle.createWritable();
      const { root, currentLeafId } = fullDto;
      await contentWritable.write(JSON.stringify({ 
        root: root || { items: [] }, 
        currentLeafId 
      }));
      await contentWritable.close();
          
      const { root: _r, currentLeafId: _c, ...meta } = fullDto;
      metas.push(meta as ChatMetaDto);
    }

    // Write final meta index
    const indexDto: ChatMetaIndexDto = { entries: metas };
    const fileHandle = await this.root!.getFileHandle('chat_metas.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(indexDto));
    await writable.close();
  }
}
