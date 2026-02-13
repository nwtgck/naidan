import { generateId } from '../../utils/id';
import JSZip from 'jszip';
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
  type MigrationChunkDto,
  type SettingsDto,
  type ChatDto,
  type MessageNodeDto,
  type HierarchyDto,
  type ChatGroupDto,
  type BinaryObjectDto,
  type BinaryShardIndexDto,
  BinaryShardIndexSchemaDto
} from '../../models/dto';
import {
  settingsToDomain,
  chatGroupToDomain,
  chatMetaToDomain 
} from '../../models/mappers';
import { useGlobalEvents } from '../../composables/useGlobalEvents';
import type { ChatSummary, Settings, ChatGroup, Hierarchy, HierarchyNode, StorageSnapshot, Chat } from '../../models/types';

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
 */
export interface IImportExportStorage {
  loadSettings(): Promise<Settings | null>;
  updateSettings(updater: (current: Settings | null) => Settings | Promise<Settings>): Promise<void>;
  listChats(): Promise<ChatSummary[]>;
  listChatGroups(): Promise<ChatGroup[]>;
  loadChat(id: string): Promise<Chat | null>;
  loadHierarchy(): Promise<Hierarchy | null>;
  clearAll(): Promise<void>;
  dumpWithoutLock(): Promise<StorageSnapshot>;
  restore(snapshot: StorageSnapshot): Promise<void>;
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
    const SUFFIX = `-${dateStr}.zip`;
    const PREFIX = 'naidan-data';
    const PREFIX_BYTES = PREFIX.length;
    const SUFFIX_BYTES = SUFFIX.length; 
    
    const AVAILABLE_BYTES = 255 - SUFFIX_BYTES - PREFIX_BYTES - 1; 
    
    let midSegment = '';
    if (options.fileNameSegment) {
      /* eslint-disable no-control-regex */
      const sanitized = options.fileNameSegment.replace(/[/?%*:|"<>\x00-\x1F]/g, '_').trim();
      /* eslint-enable no-control-regex */
      if (sanitized) {
        midSegment = `-${truncateByByteLength(sanitized, AVAILABLE_BYTES)}`;
      }
    }
    
    const finalBaseName = `${PREFIX}${midSegment}-${dateStr}`;
    const filename = `${finalBaseName}.zip`;

    const root = zip.folder(finalBaseName);
    if (!root) throw new Error('Failed to create root folder in ZIP');

    root.file('export-manifest.json', JSON.stringify({ app_version: '0.1.0-dev', exportedAt: Date.now() }, null, 2));

    const snapshot = await this.storage.dumpWithoutLock();
    const { structure, contentStream } = snapshot;

    const { settingsToDto, hierarchyToDto, chatGroupToDto, chatMetaToDto } = await import('../../models/mappers');

    root.file('settings.json', JSON.stringify(settingsToDto(structure.settings), null, 2));
    root.file('hierarchy.json', JSON.stringify(hierarchyToDto(structure.hierarchy), null, 2));

    const groupFolder = root.folder('chat-groups');
    for (const group of structure.chatGroups) {
      groupFolder!.file(`${group.id}.json`, JSON.stringify(chatGroupToDto(group), null, 2));
    }

    const metasDto = structure.chatMetas.map(chatMetaToDto);
    root.file('chat-metas.json', JSON.stringify({ entries: metasDto }, null, 2));

    const shardIndices = new Map<string, BinaryShardIndexDto>();
    const getShard = (id: string) => id.slice(-2).toLowerCase();

    try {
      const binFolder = root.folder('binary-objects');
      if (!binFolder) throw new Error('Failed to create binary-objects folder in ZIP');

      for await (const chunk of contentStream) {
        const type = chunk.type;
        switch (type) {
        case 'chat':
          root.folder('chat-contents')!.file(`${chunk.data.id}.json`, JSON.stringify(chunk.data, null, 2));
          break;
        case 'binary_object': {
          const shard = getShard(chunk.id);
          const shardFolder = binFolder.folder(shard);
          if (!shardFolder) throw new Error(`Failed to create shard folder ${shard} in ZIP`);

          const fileName = `${chunk.id}.bin`;
          shardFolder.file(fileName, chunk.blob);
          shardFolder.file(`.${fileName}.complete`, new Blob([]));

          let index = shardIndices.get(shard);
          if (!index) {
            index = { objects: {} };
            shardIndices.set(shard, index);
          }
          index.objects[chunk.id] = {
            id: chunk.id,
            mimeType: chunk.mimeType,
            size: chunk.size,
            createdAt: chunk.createdAt,
            name: chunk.name
          };
          break;
        }
        default: {
          const _ex: never = type;
          throw new Error(`Unknown chunk type: ${_ex}`);
        }
        }
      }
      
      // Write shard indexes
      for (const [shard, index] of shardIndices.entries()) {
        binFolder.folder(shard)!.file('index.json', JSON.stringify(index, null, 2));
      }
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
    const chatsMap = new Map<string, PreviewChat & { _groupId?: string | null }>();

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

    // 2. Binary Objects
    const binPrefix = rootPath + 'binary-objects/';
    stats.attachmentsCount = Object.keys(zip.files).filter(f => 
      f.startsWith(binPrefix) && 
      f.endsWith('.bin') && 
      !f.includes('/.') // Ignore markers
    ).length;

    // 3. Chat Groups
    const groupsPrefix = rootPath + 'chat-groups/';
    for (const filename of Object.keys(zip.files)) {
      if (!filename.startsWith(groupsPrefix) || filename === groupsPrefix || filename.endsWith('/')) continue;
      try {
        const result = ChatGroupSchemaDto.safeParse(JSON.parse(await zip.file(filename)!.async('string')));
        if (result.success) {
          const dto = result.data;
          stats.chatGroupsCount++;
          chatGroupsMap.set(dto.id, { id: dto.id, name: dto.name, updatedAt: dto.updatedAt, items: [], isCollapsed: dto.isCollapsed, _order: 0 });
        }
      } catch (e) { /* Ignore */ }
    }

    // 4. Chat Metas
    const metasFile = zip.file(rootPath + 'chat-metas.json');
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
              const contentFile = zip.file(`${rootPath}chat-contents/${dto.id}.json`);
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
                _order: 0
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
        hDto.items.forEach((node, nodeIdx) => {
          switch (node.type) {
          case 'chat': {
            const chat = chatsMap.get(node.id);
            if (chat) {
              chat._order = nodeIdx;
              items.push({ type: 'chat', data: chat });
            }
            break;
          }
          case 'chat_group': {
            const group = chatGroupsMap.get(node.id);
            if (group) {
              group._order = nodeIdx;
              node.chat_ids.forEach((cid, chatIdx) => {
                const chat = chatsMap.get(cid);
                if (chat) {
                  chat._order = chatIdx;
                  group.items.push(chat);
                }
              });
              items.push({ type: 'chat_group', data: group });
            }
            break;
          }
          default: {
            const _ex: never = node;
            throw new Error(`Unhandled hierarchy node type: ${_ex}`);
          }
          }
        });
      } catch (e) { 
        this.assembleLegacyHierarchy(chatsMap, chatGroupsMap, items);
      }
    } else {
      this.assembleLegacyHierarchy(chatsMap, chatGroupsMap, items);
    }

    const manifestFile = zip.file(rootPath + 'export-manifest.json');
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
    chatsMap: Map<string, PreviewChat & { _groupId?: string | null }>,
    chatGroupsMap: Map<string, PreviewChatGroup>,
    items: ImportPreviewItem[]
  ) {
    let order = 0;
    for (const chat of chatsMap.values()) {
      if (chat._groupId && chatGroupsMap.has(chat._groupId)) {
        chat._order = chatGroupsMap.get(chat._groupId)!.items.length;
        chatGroupsMap.get(chat._groupId)!.items.push(chat);
      } else {
        chat._order = order++;
        items.push({ type: 'chat', data: chat });
      }
    }
    for (const group of chatGroupsMap.values()) {
      group._order = order++;
      items.push({ type: 'chat_group', data: group });
    }
  }

  /**
   * Verify that the ZIP content is valid by dry-running the restoration snapshots.
   */
  async verify(zipFile: Blob, config: ImportConfig): Promise<void> {
    const zip = await this.loadZip(zipFile);
    const rootPath = this.findRootPath(zip);
    
    let snapshot: StorageSnapshot;
    const mode = config.data.mode;
    switch (mode) {
    case 'replace':
      snapshot = await this.createRestoreSnapshot(zip, rootPath);
      break;
    case 'append':
      snapshot = await this.createAppendSnapshot(zip, rootPath, config);
      break;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled import mode: ${_ex}`);
    }
    }

    for await (const _ of snapshot.contentStream) { /* dry run */ }
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
      const replaceSnapshot = await this.createRestoreSnapshot(zip, rootPath);
      await this.storage.restore(replaceSnapshot);
      break;
    }
    case 'append': {
      if (settingsFile) {
        try {
          const result = SettingsSchemaDto.safeParse(JSON.parse(await settingsFile.async('string')));
          if (result.success) await this.applySettingsImport(result.data, config.settings);
        } catch (e) { /* Ignore */ }
      }
      const appendSnapshot = await this.createAppendSnapshot(zip, rootPath, config);
      await this.storage.restore(appendSnapshot);
      break;
    }
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled import mode: ${_ex}`);
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
    const manifestPath = Object.keys(zip.files).find(path => path.endsWith('export-manifest.json'));
    if (!manifestPath) throw new Error('Missing export-manifest.json');
    
    const lastSlash = manifestPath.lastIndexOf('/');
    return lastSlash !== -1 ? manifestPath.substring(0, lastSlash + 1) : '';
  }

  private async applySettingsImport(zipSettings: SettingsDto, strategies: ImportConfig['settings']) {
    await this.storage.updateSettings((currentSettings) => {
      const newSettingsDomain = settingsToDomain(zipSettings);
      const finalSettings: Settings = currentSettings ? { ...currentSettings } : { ...newSettingsDomain };

      const applyField = <K extends keyof Settings>(strategy: ImportFieldStrategy, newValue: Settings[K], targetKey: K) => {
        if (strategy === 'replace' && newValue !== undefined) {
          finalSettings[targetKey] = newValue;
        }
      };

      applyField(strategies.endpoint, newSettingsDomain.endpointType, 'endpointType');
      applyField(strategies.endpoint, newSettingsDomain.endpointUrl, 'endpointUrl');
      applyField(strategies.endpoint, newSettingsDomain.endpointHttpHeaders, 'endpointHttpHeaders');
      applyField(strategies.model, newSettingsDomain.defaultModelId, 'defaultModelId');
      applyField(strategies.titleModel, newSettingsDomain.titleModelId, 'titleModelId');
      applyField(strategies.systemPrompt, newSettingsDomain.systemPrompt, 'systemPrompt');
      applyField(strategies.lmParameters, newSettingsDomain.lmParameters, 'lmParameters');
      
      switch (strategies.providerProfiles) {
      case 'replace':
        finalSettings.providerProfiles = newSettingsDomain.providerProfiles;
        break;
      case 'append': {
        const appended = newSettingsDomain.providerProfiles.map(p => ({ ...p, id: generateId() }));
        finalSettings.providerProfiles = [...finalSettings.providerProfiles, ...appended];
        break;
      }
      case 'none':
        break;
      default: {
        const _ex: never = strategies.providerProfiles;
        throw new Error(`Unhandled providerProfiles strategy: ${_ex}`);
      }
      }
      return finalSettings;
    });  
  }

  private async createRestoreSnapshot(zip: JSZip, rootPath: string): Promise<StorageSnapshot> {
    const hierarchyFile = zip.file(rootPath + 'hierarchy.json');
    const hierarchyDto: HierarchyDto = hierarchyFile 
      ? HierarchySchemaDto.parse(JSON.parse(await hierarchyFile.async('string')))
      : { items: [] };

    const metasFile = zip.file(rootPath + 'chat-metas.json');
    const metasDto: ChatMetaDto[] = [];
    if (metasFile) {
      try {
        const json = JSON.parse(await metasFile.async('string'));
        if (json.entries) {
          for (const m of json.entries) {
            const res = ChatMetaSchemaDto.safeParse(m);
            if (res.success) metasDto.push(res.data);
          }
        }
      } catch (e) { /* Ignore */ }
    }

    const groupsPrefix = rootPath + 'chat-groups/';
    const groupsDto: ChatGroupDto[] = [];
    for (const filename of Object.keys(zip.files)) {
      if (filename.startsWith(groupsPrefix) && !filename.endsWith('/') && filename !== groupsPrefix) {
        try {
          const result = ChatGroupSchemaDto.safeParse(JSON.parse(await zip.file(filename)!.async('string')));
          if (result.success) groupsDto.push(result.data);
        } catch (e) { /* Ignore */ }
      }
    }

    const settingsFile = zip.file(rootPath + 'settings.json');
    const settingsDto = settingsFile ? SettingsSchemaDto.parse(JSON.parse(await settingsFile.async('string'))) : null;

    // Load all shard indices from the ZIP
    const binPrefix = rootPath + 'binary-objects/';
    const unifiedBinIndex: Record<string, BinaryObjectDto> = {};
    for (const filename of Object.keys(zip.files)) {
      if (filename.startsWith(binPrefix) && filename.endsWith('index.json')) {
        try {
          const shardIndex = BinaryShardIndexSchemaDto.parse(JSON.parse(await zip.file(filename)!.async('string')));
          Object.assign(unifiedBinIndex, shardIndex.objects);
        } catch (e) { /* Ignore corrupted index */ }
      }
    }

    const chatMetas = metasDto.map(chatMetaToDomain);
    const hierarchy = hierarchyDto;
    const chatGroups = groupsDto.map(g => chatGroupToDomain(g, hierarchy, chatMetas));

    const contentStream = async function* (): AsyncGenerator<MigrationChunkDto> {
      for (const meta of metasDto) {
        const contentFile = zip.file(`${rootPath}chat-contents/${meta.id}.json`);
        if (contentFile) {
          try {
            const content = ChatContentSchemaDto.parse(JSON.parse(await contentFile.async('string')));
            yield { type: 'chat' as const, data: { ...meta, ...content } };
          } catch (e) { /* Ignore */ }
        }
      }

      // Yield binary objects found in shards
      for (const filename of Object.keys(zip.files)) {
        if (filename.startsWith(binPrefix) && filename.endsWith('.bin') && !filename.includes('/.')) {
          const parts = filename.substring(binPrefix.length).split('/');
          if (parts.length === 2) {
            const bId = parts[1]!.replace('.bin', '');
            const meta = unifiedBinIndex[bId];
            if (meta) {
              const blob = await zip.file(filename)!.async('blob');
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
        }
      }
    };

    return {
      structure: {
        settings: settingsDto ? settingsToDomain(settingsDto) : {
          autoTitleEnabled: true,
          providerProfiles: [],
          storageType: 'local',
          endpointType: 'openai',
          endpointUrl: '',
        } as Settings,
        hierarchy,
        chatMetas,
        chatGroups,
      },
      contentStream: contentStream(),
    };
  }

  private async createAppendSnapshot(zip: JSZip, rootPath: string, config: ImportConfig): Promise<StorageSnapshot> {
    const groupIdMap = new Map<string, string>();
    const chatIdMap = new Map<string, string>();
    
    // 1. Groups
    const groupsPrefix = rootPath + 'chat-groups/';
    const importedGroupsDto: ChatGroupDto[] = [];
    for (const filename of Object.keys(zip.files)) {
      if (filename.startsWith(groupsPrefix) && !filename.endsWith('/') && filename !== groupsPrefix) {
        try {
          const result = ChatGroupSchemaDto.safeParse(JSON.parse(await zip.file(filename)!.async('string')));
          if (result.success) {
            const dto = result.data;
            const newId = generateId();
            groupIdMap.set(dto.id, newId);
            dto.id = newId;
            if (config.data.chatGroupNamePrefix) dto.name = `${config.data.chatGroupNamePrefix}${dto.name}`;
            importedGroupsDto.push(dto);
          }
        } catch (e) { /* Ignore */ }
      }
    }

    // 2. Metas
    const metasFile = zip.file(rootPath + 'chat-metas.json');
    const importedMetas: { dto: ChatMetaDto, originalId: string }[] = [];
    if (metasFile) {
      try {
        const json = JSON.parse(await metasFile.async('string'));
        for (const meta of (json.entries || [])) {
          const res = ChatMetaSchemaDto.safeParse(meta);
          if (res.success) {
            const dto = res.data;
            const originalId = dto.id;
            const newId = generateId();
            chatIdMap.set(originalId, newId);
            dto.id = newId;
            if (config.data.chatTitlePrefix && dto.title) dto.title = `${config.data.chatTitlePrefix}${dto.title}`;
            importedMetas.push({ dto, originalId });
          }
        }
      } catch (e) { /* Ignore */ }
    }

    // 3. Hierarchy
    const currentHierarchy = await this.storage.loadHierarchy() || { items: [] };
    const hierarchyFile = zip.file(rootPath + 'hierarchy.json');
    let importedHierarchyItems: HierarchyNode[] = [];
    if (hierarchyFile) {
      try {
        const hDto = HierarchySchemaDto.parse(JSON.parse(await hierarchyFile.async('string')));
        importedHierarchyItems = hDto.items.map(node => {
          switch (node.type) {
          case 'chat':
            return { type: 'chat', id: chatIdMap.get(node.id) || node.id };
          case 'chat_group':
            return { type: 'chat_group', id: groupIdMap.get(node.id) || node.id, chat_ids: node.chat_ids.map(cid => chatIdMap.get(cid) || cid) };
          default: {
            const _ex: never = node;
            throw new Error(`Unhandled hierarchy node type: ${_ex}`);
          }
          }
        });
      } catch (e) { /* fallback below */ }
    }

    if (importedHierarchyItems.length === 0) {
      importedHierarchyItems = [
        ...importedGroupsDto.map(g => ({ type: 'chat_group' as const, id: g.id, chat_ids: [] })),
        ...importedMetas.map(m => ({ type: 'chat' as const, id: m.dto.id }))
      ];
    }

    const mergedHierarchy: Hierarchy = { items: [...currentHierarchy.items, ...importedHierarchyItems] };
    const chatMetas = importedMetas.map(m => chatMetaToDomain(m.dto));
    const chatGroups = importedGroupsDto.map(g => chatGroupToDomain(g, mergedHierarchy, chatMetas));

    const contentStream = async function* (): AsyncGenerator<MigrationChunkDto> {
      // 1. Unified metadata lookup for append remapping
      const binPrefix = rootPath + 'binary-objects/';
      const unifiedBinIndex: Record<string, BinaryObjectDto> = {};
      for (const filename of Object.keys(zip.files)) {
        if (filename.startsWith(binPrefix) && filename.endsWith('index.json')) {
          try {
            const shardIndex = BinaryShardIndexSchemaDto.parse(JSON.parse(await zip.file(filename)!.async('string')));
            Object.assign(unifiedBinIndex, shardIndex.objects);
          } catch (e) { /* skip */ }
        }
      }

      // Map to track which original binaryObjectId has been remapped to which new one
      const binaryRemapMap = new Map<string, string>();

      for (const { dto: meta, originalId } of importedMetas) {
        const contentFile = zip.file(`${rootPath}chat-contents/${originalId}.json`);
        if (contentFile) {
          try {
            const content = ChatContentSchemaDto.parse(JSON.parse(await contentFile.async('string')));
            const dto: ChatDto = { ...meta, ...content };
            const process = (node: MessageNodeDto) => {
              node.id = generateId();
              if (node.attachments) {
                node.attachments.forEach(a => {
                  // remap attachment ID (the reference)
                  const originalAttId = a.id;
                  a.id = generateId();

                  // Resolve binaryObjectId from V1 or V2
                  const oldBinaryId = ('binaryObjectId' in a) ? a.binaryObjectId : originalAttId;
                  
                  if (!binaryRemapMap.has(oldBinaryId)) {
                    binaryRemapMap.set(oldBinaryId, generateId());
                  }
                  
                  const newBinaryId = binaryRemapMap.get(oldBinaryId)!;
                  
                  // Use Record to mutate properties while keeping it somewhat safe
                  const mutAtt = a as unknown as Record<string, unknown>;
                  mutAtt.binaryObjectId = newBinaryId;
                  
                  // Ensure it looks like V2
                  if (!('name' in a)) {
                    mutAtt.name = (a as unknown as { originalName: string }).originalName || 'file';
                    delete mutAtt.originalName;
                    delete mutAtt.mimeType;
                    delete mutAtt.size;
                    delete mutAtt.uploadedAt;
                  }
                });
              }
              if (node.replies?.items) node.replies.items.forEach(process);
            };
            if (dto.root?.items) dto.root.items.forEach(process);
            yield { type: 'chat' as const, data: dto };
          } catch (e) { /* Ignore */ }
        }
      }

      // Yield binary objects from shards using the remapped IDs
      for (const filename of Object.keys(zip.files)) {
        if (filename.startsWith(binPrefix) && filename.endsWith('.bin') && !filename.includes('/.')) {
          const parts = filename.substring(binPrefix.length).split('/');
          if (parts.length === 2) {
            const oldBinaryId = parts[1]!.replace('.bin', '');
            const newBinaryId = binaryRemapMap.get(oldBinaryId);
            const meta = unifiedBinIndex[oldBinaryId];
            if (newBinaryId && meta) {
              const blob = await zip.file(filename)!.async('blob');
              yield { 
                type: 'binary_object' as const, 
                id: newBinaryId,
                name: meta.name || 'file',
                mimeType: meta.mimeType,
                size: meta.size,
                createdAt: meta.createdAt,
                blob 
              };
            }
          }
        }
      }
    };

    const settings = await this.storage.loadSettings();
    return {
      structure: { 
        settings: settings || {
          autoTitleEnabled: true,
          providerProfiles: [],
          storageType: 'local',
          endpointType: 'openai',
          endpointUrl: '',
        } as Settings, 
        hierarchy: mergedHierarchy, 
        chatMetas, 
        chatGroups 
      },
      contentStream: contentStream(),
    };
  }
}