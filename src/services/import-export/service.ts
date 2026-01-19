import JSZip from 'jszip';
import { v7 as uuidv7 } from 'uuid';
import type { 
  ExportOptions, 
  ImportConfig, 
  ImportPreview,
  ImportPreviewItem,
  PreviewChatGroup,
  PreviewChat,
  ImportFieldStrategy
} from './types';
import { 
  ChatGroupSchemaDto, 
  ChatMetaSchemaDto,
  ChatContentSchemaDto,
  SettingsSchemaDto,
  HierarchySchemaDto,
  type ChatMetaDto,
  type ChatContentDto,
  type MigrationChunkDto,
  type SettingsDto,
  type ChatDto,
  type ChatGroupDto,
  type MessageNodeDto,
  type AttachmentDto,
  type HierarchyDto
} from '../../models/dto';
import { settingsToDomain } from '../../models/mappers';
import { useGlobalEvents } from '../../composables/useGlobalEvents';
import type { ChatSummary, Settings, ChatGroup, Hierarchy, HierarchyNode } from '../../models/types';

// Helper to format date YYYY-MM-DD
function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Truncates a string to a maximum byte length for UTF-8 encoding.
 */
function truncateByByteLength(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const buf = encoder.encode(str);
  if (buf.length <= maxBytes) return str;
  return decoder.decode(buf.slice(0, maxBytes)).replace(/\uFFFD/g, '');
}

/**
 * Interface for the storage dependency of ImportExportService.
 * This matches the public API of StorageService to ensure concurrency protection.
 */
export interface IImportExportStorage {
  dumpWithoutLock(): AsyncGenerator<MigrationChunkDto>;
  restore(stream: AsyncGenerator<MigrationChunkDto>): Promise<void>;
  clearAll(): Promise<void>;
  loadSettings(): Promise<Settings | null>;
  saveSettings(settings: Settings): Promise<void>;
  listChats(): Promise<ChatSummary[]>;
  listChatGroups(): Promise<ChatGroup[]>;
  loadHierarchy(): Promise<Hierarchy>;
}

export class ImportExportService {
  private globalEvents = useGlobalEvents();

  // Accept a subset of IStorageProvider that handles the necessary persistence
  constructor(private storage: IImportExportStorage) {}

  /**
   * Export data as a ZIP stream.
   */
  async exportData(options: ExportOptions): Promise<{ stream: ReadableStream<Uint8Array>, filename: string }> {
    const zip = new JSZip();
    const dateStr = formatDate(new Date());
    
    // Linux filename limit is 255 bytes. 
    const SUFFIX = `_${dateStr}.zip`;
    const PREFIX = 'naidan_data';
    const PREFIX_BYTES = PREFIX.length;
    const SUFFIX_BYTES = SUFFIX.length; 
    
    const AVAILABLE_BYTES = 255 - SUFFIX_BYTES - PREFIX_BYTES - 1; 
    
    let midSegment = '';
    if (options.fileNameSegment) {
      /* eslint-disable no-control-regex */
      const sanitized = options.fileNameSegment.replace(/[/?%*:|"<>\x00-\x1F]/g, '_').trim();
      /* eslint-enable no-control-regex */
      if (sanitized) {
        midSegment = `_${truncateByByteLength(sanitized, AVAILABLE_BYTES)}`;
      }
    }
    
    const finalBaseName = `${PREFIX}${midSegment}_${dateStr}`;
    const filename = `${finalBaseName}.zip`;

    const root = zip.folder(finalBaseName);
    if (!root) throw new Error('Failed to create root folder in ZIP');

    root.file('export_manifest.json', JSON.stringify({ app_version: __APP_VERSION__, exportedAt: Date.now() }, null, 2));

    const chatMetas: ChatMetaDto[] = [];

    try {
      for await (const chunk of this.storage.dumpWithoutLock()) {
        switch (chunk.type) {
        case 'settings':
          root.file('settings.json', JSON.stringify(chunk.data, null, 2));
          break;
        case 'hierarchy':
          root.file('hierarchy.json', JSON.stringify(chunk.data, null, 2));
          break;
        case 'chat_group':
          root.folder('chat_groups')!.file(`${chunk.data.id}.json`, JSON.stringify(chunk.data, null, 2));
          break;
        case 'chat': {
          const { root: chatRoot, currentLeafId, ...meta } = chunk.data;
          chatMetas.push(meta as ChatMetaDto);
          const contentDto: ChatContentDto = { root: chatRoot || { items: [] }, currentLeafId };
          root.folder('chat_contents')!.file(`${chunk.data.id}.json`, JSON.stringify(contentDto, null, 2));
          break;
        }
        case 'attachment':
          root.folder('uploaded_files')!.folder(chunk.attachmentId)!.file(chunk.originalName, chunk.blob);
          break;
        }
      }
      root.file('chat_metas.json', JSON.stringify({ entries: chatMetas }, null, 2));
    } catch (err) {
      this.globalEvents.addErrorEvent({ source: 'ImportExportService', message: 'Export dump failed', details: err as Error });
      throw err;
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        zip.generateInternalStream({ type: 'uint8array', streamFiles: true })
          .on('data', (data) => controller.enqueue(data))
          .on('error', (err) => controller.error(err))
          .on('end', () => controller.close())
          .resume();
      }
    });

    return { stream, filename };
  }

  /**
   * Analyze ZIP file and return preview information.
   */
  async analyze(zipFile: Blob): Promise<ImportPreview> {
    const zip = await this.loadZip(zipFile);
    const rootPath = this.findRootPath(zip);

    const stats = { chatsCount: 0, chatGroupsCount: 0, attachmentsCount: 0, hasSettings: false, providerProfilesCount: 0 };
    const items: ImportPreviewItem[] = [];
    const chatGroupsMap = new Map<string, PreviewChatGroup>();
    const chatsMap = new Map<string, PreviewChat & { _groupId?: string | null, _order?: number }>();

    // 1. Settings
    let previewSettings;
    const settingsFile = zip.file(rootPath + 'settings.json');
    if (settingsFile) {
      stats.hasSettings = true;
      try {
        const result = SettingsSchemaDto.safeParse(JSON.parse(await settingsFile.async('string')));
        if (result.success) {
          stats.providerProfilesCount = result.data.providerProfiles?.length ?? 0;
          previewSettings = settingsToDomain(result.data);
        }
      } catch (e) { /* Ignore */ }
    }

    // 2. Attachments
    const attPrefix = rootPath + 'uploaded_files/';
    stats.attachmentsCount = Object.keys(zip.files).filter(f => f.startsWith(attPrefix) && f !== attPrefix && !f.endsWith('/')).length;

    // 3. Chat Groups
    const groupsPrefix = rootPath + 'chat_groups/';
    for (const filename of Object.keys(zip.files)) {
      if (!filename.startsWith(groupsPrefix) || filename === groupsPrefix || filename.endsWith('/')) continue;
      try {
        const result = ChatGroupSchemaDto.safeParse(JSON.parse(await zip.file(filename)!.async('string')));
        if (result.success) {
          const dto = result.data;
          stats.chatGroupsCount++;
          const json = JSON.parse(await zip.file(filename)!.async('string'));
          chatGroupsMap.set(dto.id, { id: dto.id, name: dto.name, updatedAt: dto.updatedAt, items: [], isCollapsed: dto.isCollapsed, _order: (json as { order?: number }).order ?? 0 });
        }
      } catch (e) { /* Ignore */ }
    }

    // 4. Chat Metas & Contents
    const metasFile = zip.file(rootPath + 'chat_metas.json');
    if (metasFile) {
      try {
        const metasContent = await metasFile.async('string');
        const metasJson = JSON.parse(metasContent) as { entries: unknown[] };
        if (metasJson.entries && Array.isArray(metasJson.entries)) {
          for (const meta of metasJson.entries) {
            const result = ChatMetaSchemaDto.safeParse(meta);
            if (result.success) {
              const dto = result.data;
              stats.chatsCount++;
              let messageCount = 0;
              const contentFile = zip.file(`${rootPath}chat_contents/${dto.id}.json`);
              if (contentFile) {
                try {
                  const contentJson = JSON.parse(await contentFile.async('string')) as { root?: { items?: unknown[] } };
                  messageCount = contentJson.root?.items?.length ?? 0;
                } catch (e) { /* Ignore */ }
              }
              chatsMap.set(dto.id, { 
                id: dto.id, 
                title: dto.title, 
                updatedAt: dto.updatedAt, 
                messageCount, 
                _groupId: (meta as { groupId?: string | null }).groupId ?? null, 
                _order: (meta as { order?: number }).order ?? 0 
              });
            }
          }
        }
      } catch (e) { /* Ignore */ }
    }

    // 5. Build Hierarchy (Prefer hierarchy.json if exists, fallback to legacy fields)
    const hierarchyFile = zip.file(rootPath + 'hierarchy.json');
    if (hierarchyFile) {
      try {
        const hDto = HierarchySchemaDto.parse(JSON.parse(await hierarchyFile.async('string')));
        for (const node of hDto.items) {
          if (node.type === 'chat') {
            const chat = chatsMap.get(node.id);
            if (chat) items.push({ type: 'chat', data: chat });
          } else {
            const group = chatGroupsMap.get(node.id);
            if (group) {
              for (const cid of node.chat_ids) {
                const chat = chatsMap.get(cid);
                if (chat) group.items.push(chat);
              }
              items.push({ type: 'chat_group', data: group });
            }
          }
        }
      } catch (e) { 
        // Fallback to legacy
        this.assembleLegacyHierarchy(chatsMap, chatGroupsMap, items);
      }
    } else {
      this.assembleLegacyHierarchy(chatsMap, chatGroupsMap, items);
    }

    const manifestFile = zip.file(rootPath + 'export_manifest.json');
    let appVersion = 'Unknown';
    let exportedAt = 0;
    if (manifestFile) {
      try {
        const m = JSON.parse(await manifestFile.async('string'));
        appVersion = m.app_version || 'Unknown';
        exportedAt = m.exportedAt || 0;
      } catch (e) { /* Ignore */ }
    }

    return { appVersion, exportedAt, items, stats, previewSettings };
  }

  private assembleLegacyHierarchy(
    chatsMap: Map<string, PreviewChat & { _groupId?: string | null, _order?: number }>,
    chatGroupsMap: Map<string, PreviewChatGroup>,
    items: ImportPreviewItem[]
  ) {
    for (const chat of chatsMap.values()) {
      if (chat._groupId && chatGroupsMap.has(chat._groupId)) chatGroupsMap.get(chat._groupId)!.items.push(chat);
      else items.push({ type: 'chat', data: chat });
    }
    for (const group of chatGroupsMap.values()) {
      group.items.sort((a, b) => (a._order ?? 0) - (b._order ?? 0));
      items.push({ type: 'chat_group', data: group });
    }
    items.sort((a, b) => ((a.data as { _order?: number })._order ?? 0) - ((b.data as { _order?: number })._order ?? 0));
  }

  /**
   * Verify that the ZIP content is valid by dry-running the restoration generators.
   */
  async verify(zipFile: Blob, config: ImportConfig): Promise<void> {
    const zip = await this.loadZip(zipFile);
    const rootPath = this.findRootPath(zip);
    
    let stream: AsyncGenerator<MigrationChunkDto>;
    const mode = config.data.mode;
    switch (mode) {
    case 'replace': stream = this.createRestoreStream(zip, rootPath); break;
    case 'append': stream = this.createAppendStream(zip, rootPath, config); break;
    default: {
      const _ex: never = mode;
      throw new Error(`Unknown mode: ${_ex}`);
    }
    }

    for await (const _ of stream) { /* dry run */ }
  }

  /**
   * Execute Import.
   */
  async executeImport(zipFile: Blob, config: ImportConfig): Promise<void> {
    const zip = await this.loadZip(zipFile);
    const rootPath = this.findRootPath(zip);
    const settingsFile = zip.file(rootPath + 'settings.json');

    const mode = config.data.mode;
    switch (mode) {
    case 'replace': {
      await this.storage.clearAll();
      if (settingsFile) {
        try {
          const result = SettingsSchemaDto.safeParse(JSON.parse(await settingsFile.async('string')));
          if (result.success) await this.applySettingsImport(result.data, config.settings);
        } catch (e) { /* Ignore */ }
      }
      await this.storage.restore(this.createRestoreStream(zip, rootPath));
      break;
    }
    case 'append': {
      if (settingsFile) {
        try {
          const result = SettingsSchemaDto.safeParse(JSON.parse(await settingsFile.async('string')));
          if (result.success) await this.applySettingsImport(result.data, config.settings);
        } catch (e) { /* Ignore */ }
      }
      await this.storage.restore(this.createAppendStream(zip, rootPath, config));
      break;
    }
    default: {
      const _ex: never = mode;
      throw new Error(`Unknown mode: ${_ex}`);
    }
    }
  }

  private async loadZip(blob: Blob): Promise<JSZip> {
    try {
      return await JSZip.loadAsync(blob);
    } catch (e) {
      this.globalEvents.addErrorEvent({ source: 'ImportExportService', message: 'Invalid ZIP file', details: e as Error });
      throw new Error('Invalid ZIP file');
    }
  }

  private findRootPath(zip: JSZip): string {
    const manifestPath = Object.keys(zip.files).find(path => path.endsWith('export_manifest.json'));
    if (!manifestPath) throw new Error('Missing export_manifest.json');
    
    const lastSlash = manifestPath.lastIndexOf('/');
    return lastSlash !== -1 ? manifestPath.substring(0, lastSlash + 1) : '';
  }

  private async applySettingsImport(zipSettings: SettingsDto, strategies: ImportConfig['settings']) {
    const currentSettings = await this.storage.loadSettings();
    const newSettingsDomain = settingsToDomain(zipSettings);
    
    // Fallback if current settings are null (unlikely but possible during onboarding)
    const finalSettings: Settings = currentSettings ? { ...currentSettings } : { ...newSettingsDomain };

    const applyField = <K extends keyof Settings>(strategy: ImportFieldStrategy, newValue: Settings[K], targetKey: K) => {
      if (strategy === 'replace' && newValue !== undefined) {
        finalSettings[targetKey] = newValue;
      }
    };

    // Mapping between strategy fields and domain fields
    applyField(strategies.endpoint, newSettingsDomain.endpointType, 'endpointType');
    applyField(strategies.endpoint, newSettingsDomain.endpointUrl, 'endpointUrl');
    applyField(strategies.endpoint, newSettingsDomain.endpointHttpHeaders, 'endpointHttpHeaders');
    
    applyField(strategies.model, newSettingsDomain.defaultModelId, 'defaultModelId');
    applyField(strategies.titleModel, newSettingsDomain.titleModelId, 'titleModelId');
    applyField(strategies.systemPrompt, newSettingsDomain.systemPrompt, 'systemPrompt');
    applyField(strategies.lmParameters, newSettingsDomain.lmParameters, 'lmParameters');

    switch (strategies.providerProfiles) {
    case 'replace': finalSettings.providerProfiles = newSettingsDomain.providerProfiles; break;
    case 'append': {
      // Regenerate IDs for imported profiles to prevent collisions
      const appended = newSettingsDomain.providerProfiles.map(p => ({ ...p, id: uuidv7() }));
      finalSettings.providerProfiles.push(...appended);
      break;
    }
    case 'none': break;
    default: {
      const _ex: never = strategies.providerProfiles;
      return _ex;
    }
    }
    await this.storage.saveSettings(finalSettings);
  }

  private async *createRestoreStream(zip: JSZip, rootPath: string): AsyncGenerator<MigrationChunkDto> {
    const attachmentMetadata = new Map<string, { originalName: string, mimeType: string, size: number, uploadedAt: number }>();
    
    const hierarchyFile = zip.file(rootPath + 'hierarchy.json');
    if (hierarchyFile) {
      try {
        const json = JSON.parse(await hierarchyFile.async('string'));
        yield { type: 'hierarchy', data: json };
      } catch (e) { /* Ignore */ }
    }

    const metasFile = zip.file(rootPath + 'chat_metas.json');
    const metas: ChatMetaDto[] = [];
    if (metasFile) {
      try {
        const json = JSON.parse(await metasFile.async('string'));
        if (json.entries) {
          for (const m of json.entries) {
            const res = ChatMetaSchemaDto.safeParse(m);
            if (res.success) metas.push(res.data);
          }
        }
      } catch (e) { /* Ignore */ }
    }

    for (const meta of metas) {
      const contentFile = zip.file(`${rootPath}chat_contents/${meta.id}.json`);
      if (contentFile) {
        try {
          const content = ChatContentSchemaDto.parse(JSON.parse(await contentFile.async('string')));
          const chatDto: ChatDto = { ...meta, ...content };
          const extractFromNode = (node: MessageNodeDto) => {
            if (node.attachments) {
              node.attachments.forEach((a) => attachmentMetadata.set(a.id, {
                originalName: a.originalName, mimeType: a.mimeType, size: a.size, uploadedAt: a.uploadedAt
              }));
            }
            if (node.replies?.items) node.replies.items.forEach(extractFromNode);
          };
          if (chatDto.root?.items) chatDto.root.items.forEach(extractFromNode);
          yield { type: 'chat', data: chatDto };
        } catch (e) { /* Ignore */ }
      }
    }

    const groupsPrefix = rootPath + 'chat_groups/';
    for (const filename of Object.keys(zip.files)) {
      if (!filename.startsWith(groupsPrefix) || filename === groupsPrefix || filename.endsWith('/')) continue;
      try {
        const result = ChatGroupSchemaDto.safeParse(JSON.parse(await zip.file(filename)!.async('string')));
        if (result.success) yield { type: 'chat_group', data: result.data };
      } catch (e) { /* Ignore */ }
    }

    const attPrefix = rootPath + 'uploaded_files/';
    for (const filename of Object.keys(zip.files)) {
      if (!filename.startsWith(attPrefix) || filename === attPrefix || filename.endsWith('/')) continue;
      const relativePath = filename.substring(attPrefix.length);
      const parts = relativePath.split('/');
      if (parts.length === 2) {
        const attachmentId = parts[0];
        const meta = attachmentId ? attachmentMetadata.get(attachmentId) : undefined;
        if (attachmentId && meta) {
          const blob = await zip.file(filename)!.async('blob');
          yield { type: 'attachment', chatId: '', attachmentId, originalName: meta.originalName, mimeType: meta.mimeType, size: meta.size, uploadedAt: meta.uploadedAt, blob };
        }
      }
    }
  }

  private async *createAppendStream(zip: JSZip, rootPath: string, config: ImportConfig): AsyncGenerator<MigrationChunkDto> {
    const idMap = new Map<string, string>(); 
    const groupsPrefix = rootPath + 'chat_groups/';
    const importedGroups: ChatGroupDto[] = [];

    for (const filename of Object.keys(zip.files)) {
      if (!filename.startsWith(groupsPrefix) || filename === groupsPrefix || filename.endsWith('/')) continue;
      try {
        const result = ChatGroupSchemaDto.safeParse(JSON.parse(await zip.file(filename)!.async('string')));
        if (result.success) {
          const dto = result.data;
          const newId = uuidv7();
          idMap.set(dto.id, newId);
          dto.id = newId;
          if (config.data.chatGroupNamePrefix) dto.name = `${config.data.chatGroupNamePrefix}${dto.name}`;
          importedGroups.push(dto);
          yield { type: 'chat_group', data: dto };
        }
      } catch (e) { /* Ignore */ }
    }

    const attachmentMetadata = new Map<string, { originalName: string, mimeType: string, size: number, uploadedAt: number }>();
    const attachmentIdMap = new Map<string, string>();
    const metasFile = zip.file(rootPath + 'chat_metas.json');
    const importedChatIds: string[] = [];

    if (metasFile) {
      try {
        const metasJson = JSON.parse(await metasFile.async('string'));
        for (const meta of (metasJson.entries || [])) {
          const metaRes = ChatMetaSchemaDto.safeParse(meta);
          if (!metaRes.success) continue;
          const contentFile = zip.file(`${rootPath}chat_contents/${metaRes.data.id}.json`);
          if (contentFile) {
            const content = ChatContentSchemaDto.parse(JSON.parse(await contentFile.async('string')));
            const dto: ChatDto = { ...metaRes.data, ...content };
            const newId = uuidv7();
            idMap.set(dto.id, newId);
            dto.id = newId;
            importedChatIds.push(newId);
            if (config.data.chatTitlePrefix && dto.title) dto.title = `${config.data.chatTitlePrefix}${dto.title}`;
            
            const processAttachments = (attachments: AttachmentDto[]): AttachmentDto[] => {
              return attachments.map((att) => {
                if (!attachmentIdMap.has(att.id)) {
                  const newAttId = uuidv7();
                  attachmentIdMap.set(att.id, newAttId);
                  attachmentMetadata.set(newAttId, { originalName: att.originalName, mimeType: att.mimeType, size: att.size, uploadedAt: att.uploadedAt }); 
                }
                const mappedId = attachmentIdMap.get(att.id);
                return { ...att, id: mappedId || uuidv7() };
              });
            };
            const processNode = (node: MessageNodeDto) => {
              if (node.attachments) node.attachments = processAttachments(node.attachments);
              if (node.replies?.items) node.replies.items.forEach(processNode);
            };
            if (dto.root?.items) dto.root.items.forEach(processNode);
            yield { type: 'chat', data: dto };
          }
        }
      } catch (e) { /* Ignore */ }
    }

    // Reconstruction of Hierarchy for 'append' mode
    const currentHierarchy = await this.storage.loadHierarchy();
    const hierarchyFile = zip.file(rootPath + 'hierarchy.json');
    let importedHierarchyItems: HierarchyNode[] = [];

    if (hierarchyFile) {
      try {
        const hDto = HierarchySchemaDto.parse(JSON.parse(await hierarchyFile.async('string')));
        importedHierarchyItems = hDto.items.map(node => {
          if (node.type === 'chat') {
            return { type: 'chat', id: idMap.get(node.id) || node.id };
          } else {
            return { 
              type: 'chat_group', 
              id: idMap.get(node.id) || node.id, 
              chat_ids: node.chat_ids.map(cid => idMap.get(cid) || cid) 
            };
          }
        });
      } catch (e) { /* fallback below */ }
    }

    if (importedHierarchyItems.length === 0) {
      // Legacy or missing hierarchy fallback: append groups then chats
      importedHierarchyItems = [
        ...importedGroups.map(g => ({ type: 'chat_group' as const, id: g.id, chat_ids: [] })),
        ...importedChatIds.map(id => ({ type: 'chat' as const, id }))
      ];
    }

    const mergedHierarchy: HierarchyDto = {
      items: [...currentHierarchy.items, ...importedHierarchyItems]
    };
    yield { type: 'hierarchy', data: mergedHierarchy };

    const attPrefix = rootPath + 'uploaded_files/';
    for (const filename of Object.keys(zip.files)) {
      if (!filename.startsWith(attPrefix) || filename === attPrefix || filename.endsWith('/')) continue;
      const relativePath = filename.substring(attPrefix.length);
      const parts = relativePath.split('/');
      if (parts.length === 2) {
        const oldId = parts[0];
        if (oldId && attachmentIdMap.has(oldId)) {
          const newId = attachmentIdMap.get(oldId);
          const meta = newId ? attachmentMetadata.get(newId) : undefined;
          if (newId && meta) {
            const blob = await zip.file(filename)!.async('blob');
            yield { type: 'attachment', chatId: '', attachmentId: newId, originalName: meta.originalName, mimeType: meta.mimeType, size: meta.size, uploadedAt: meta.uploadedAt, blob };
          }
        }
      }
    }
  }
}
