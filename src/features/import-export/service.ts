import { ensureStrings } from '@/strings';
import { generateId } from '@/01-models/id';
import type {
  ExportOptions,
  ImportConfig,
  ImportPreview,
  ImportPreviewItem,
  PreviewChatGroup,
  PreviewChat,
  ImportFieldStrategy,
} from './types';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Replace the DTO dependency with the storage service API.
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
  BinaryShardIndexSchemaDto,
} from '@/00-storage/00-dto/dto';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Replace the mapper dependency with the storage service API.
import {
  settingsToDomain,
  chatGroupToDomain,
  chatMetaToDomain,
  hierarchyToDomain,
  chatToDomain,
  chatToDto,
} from '@/00-storage/mapper/mappers';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import type { ChatSummary, Settings, ChatGroup, Hierarchy, HierarchyNode, StorageSnapshot, Chat } from '@/01-models/types';
import { idToRaw, toChatGroupId, toChatId } from '@/01-models/ids';
import type { AttachmentId, BinaryObjectId, ChatGroupId, ChatId, MessageId, ProviderProfileId } from '@/01-models/ids';
import { GeneratedImageBlockSchema, IMAGE_BLOCK_LANG } from '@/utils/image-generation';
import { createWebZipCompressionCodec, StreamingZipWriter } from '@/utils/zip-stream';
import { createMemoryZipCentralDirectoryStore, createReadableZipOutput } from '@/utils/zip-stream/memory';
import { openIndexedZipArchive, type IndexedZipArchive } from './zip-archive';
import { cloneEndpoint } from '@/01-models/endpoint';

// Helper to format date YYYY-MM-DD
function formatDate({ date }: { date: Date }): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Truncates a string to a maximum byte length for UTF-8 encoding.
 */
function truncateByByteLength({ str, maxBytes }: { str: string, maxBytes: number }): string {
  if (maxBytes <= 0) return '';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const buf = encoder.encode(str);
  if (buf.length <= maxBytes) return str;
  return decoder.decode(buf.slice(0, maxBytes)).replace(/\uFFFD/g, '');
}

function normalizeChatDtoTree({ chatDto }: { chatDto: ChatDto }): ChatDto {
  if (
    chatDto.root !== undefined
    && (chatDto.root.items.length > 0 || (chatDto.messages?.length ?? 0) === 0)
  ) {
    return chatDto;
  }

  return chatToDto({ domain: chatToDomain({ dto: chatDto }) });
}

function getCurrentThreadMessageDtos({ chatDto }: { chatDto: ChatDto }): MessageNodeDto[] {
  const items = chatDto.root?.items ?? [];
  if (items.length === 0) return [];

  const path: MessageNodeDto[] = [];
  const targetId = chatDto.currentLeafId;

  function findPath({ nodes, target }: {
    nodes: MessageNodeDto[],
    target: string,
  }): boolean {
    for (const node of nodes) {
      path.push(node);
      if (node.id === target) return true;
      if (findPath({ nodes: node.replies.items, target })) return true;
      path.pop();
    }
    return false;
  }

  const found = targetId === undefined
    ? false
    : findPath({ nodes: items, target: targetId });

  if (!found) {
    path.length = 0;
    let node = items.at(-1);
    while (node !== undefined) {
      path.push(node);
      node = node.replies.items.at(-1);
    }
  }

  return path;
}

function addGeneratedImageBinaryObjectIds({
  content,
  binaryObjectIds,
}: {
  content: string,
  binaryObjectIds: Set<string>,
}) {
  const codeBlockRegex = new RegExp(
    '```' + IMAGE_BLOCK_LANG + '[^\\n]*\\n([\\s\\S]*?)\\n```',
    'g',
  );

  for (const match of content.matchAll(codeBlockRegex)) {
    const json = match[1];
    if (json === undefined) continue;

    try {
      const result = GeneratedImageBlockSchema.safeParse(JSON.parse(json));
      if (result.success) {
        binaryObjectIds.add(result.data.binaryObjectId);
      }
    } catch {
      // Invalid generated-image blocks remain unchanged and do not affect export.
    }
  }
}

function addMessageBinaryObjectIds({
  node,
  binaryObjectIds,
}: {
  node: MessageNodeDto,
  binaryObjectIds: Set<string>,
}) {
  if (node.content !== undefined) {
    addGeneratedImageBinaryObjectIds({ content: node.content, binaryObjectIds });
  }

  switch (node.role) {
  case 'user':
    for (const attachment of node.attachments ?? []) {
      binaryObjectIds.add(
        'binaryObjectId' in attachment
          ? attachment.binaryObjectId
          : attachment.id,
      );
    }
    break;
  case 'tool':
    for (const result of node.results) {
      switch (result.status) {
      case 'executing':
        break;
      case 'success':
        switch (result.content.type) {
        case 'text':
          break;
        case 'binary_object':
          binaryObjectIds.add(result.content.id);
          break;
        default: {
          const _ex: never = result.content;
          throw new Error(`Unhandled tool result content: ${_ex}`);
        }
        }
        break;
      case 'error':
        switch (result.error.message.type) {
        case 'text':
          break;
        case 'binary_object':
          binaryObjectIds.add(result.error.message.id);
          break;
        default: {
          const _ex: never = result.error.message;
          throw new Error(`Unhandled tool error message: ${_ex}`);
        }
        }
        break;
      default: {
        const _ex: never = result;
        throw new Error(`Unhandled tool execution result: ${_ex}`);
      }
      }
    }
    break;
  case 'assistant':
  case 'system':
    break;
  default: {
    const _ex: never = node;
    throw new Error(`Unhandled message role: ${_ex}`);
  }
  }
}

function createCurrentThreadChatDto({ chatDto }: { chatDto: ChatDto }): {
  chatDto: ChatDto,
  binaryObjectIds: Set<string>,
} {
  const normalizedChatDto = normalizeChatDtoTree({ chatDto });
  const currentThread = getCurrentThreadMessageDtos({ chatDto: normalizedChatDto });
  const binaryObjectIds = new Set<string>();

  for (const node of currentThread) {
    addMessageBinaryObjectIds({ node, binaryObjectIds });
  }

  let currentNode: MessageNodeDto | undefined;
  for (let index = currentThread.length - 1; index >= 0; index--) {
    const node = currentThread[index]!;
    currentNode = {
      ...node,
      replies: {
        ...node.replies,
        items: currentNode === undefined ? [] : [currentNode],
      },
    };
  }

  return {
    chatDto: {
      ...normalizedChatDto,
      root: {
        ...(normalizedChatDto.root ?? { items: [] }),
        items: currentNode === undefined ? [] : [currentNode],
      },
      messages: undefined,
    },
    binaryObjectIds,
  };
}

interface ExportExclusionFlags {
  chat: boolean,
  chatHistory: boolean,
  binaryObject: boolean,
}

function parseExportExclusions({ exclude }: Pick<ExportOptions, 'exclude'>): ExportExclusionFlags {
  const flags: ExportExclusionFlags = {
    chat: false,
    chatHistory: false,
    binaryObject: false,
  };

  for (const item of (exclude ?? [])) {
    switch (item) {
    case 'chat':
      flags.chat = true;
      break;
    case 'chat_history':
      flags.chatHistory = true;
      break;
    case 'binary_object':
      flags.binaryObject = true;
      break;
    default: {
      const _ex: never = item;
      throw new Error(`Unknown exclusion type: ${_ex}`);
    }
    }
  }

  if (flags.chat && flags.chatHistory) {
    throw new Error('Chat and chat history exclusions cannot be used together.');
  }

  return flags;
}

/**
 * Interface for the storage dependency of ImportExportService.
 */
export interface IImportExportStorage {
  loadSettings(): Promise<Settings | null>,
  updateSettings({ updater }: { updater: ({ current }: { current: Settings | null }) => Settings | Promise<Settings> }): Promise<void>,
  listChats(): Promise<ChatSummary[]>,
  listChatGroups(): Promise<ChatGroup[]>,
  loadChat({ id }: { id: ChatId }): Promise<Chat | null>,
  loadHierarchy(): Promise<Hierarchy | null>,
  clearAll(): Promise<void>,
  dumpWithoutLock(): Promise<StorageSnapshot>,
  restore({ snapshot }: { snapshot: StorageSnapshot }): Promise<void>,
}

export class ImportExportService {
  private globalEvents = useGlobalEvents();

  private storage: IImportExportStorage;

  // Accept a subset of IStorageProvider that handles the necessary persistence
  constructor({ storage }: { storage: IImportExportStorage }) {
    this.storage = storage;
  }

  /**
   * Export data as a ZIP stream.
   */
  async exportData({ exclude, fileNameSegment }: ExportOptions): Promise<{ stream: ReadableStream<Uint8Array>, filename: string }> {
    // Validate caller-controlled options before creating a producer task. Errors
    // here remain direct exportData() rejections instead of surfacing later as
    // asynchronous stream failures after a successful return.
    const excludeFlags = parseExportExclusions({ exclude });
    const dateStr = formatDate({ date: new Date() });

    // Linux filename limit is 255 bytes.
    const suffix = `-${dateStr}.zip`;
    const prefix = 'naidan-data';
    const availableBytes = 255 - suffix.length - prefix.length - 1;

    let midSegment = '';
    if (fileNameSegment) {
      /* eslint-disable no-control-regex */
      const sanitized = fileNameSegment.replace(/[/?%*:|"<>\x00-\x1F]/g, '_').trim();
      /* eslint-enable no-control-regex */
      if (sanitized) {
        midSegment = `-${truncateByByteLength({ str: sanitized, maxBytes: availableBytes })}`;
      }
    }

    const finalBaseName = `${prefix}${midSegment}-${dateStr}`;
    const filename = `${finalBaseName}.zip`;
    const rootPath = `${finalBaseName}/`;
    const snapshot = await this.storage.dumpWithoutLock();
    // eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Replace the mapper dependency with the storage service API.
    const { settingsToDto, hierarchyToDto, chatGroupToDto, chatMetaToDto } = await import('@/00-storage/mapper/mappers');
    const output = createReadableZipOutput({ highWaterMarkBytes: 512 * 1024 });
    const centralDirectoryStore = createMemoryZipCentralDirectoryStore();
    const writer = new StreamingZipWriter({
      output: output.sink,
      centralDirectoryStore,
      compressionCodec: createWebZipCompressionCodec(),
    });
    const encoder = new TextEncoder();
    const createdDirectories = new Set<string>();
    const modifiedAt = new Date();

    const createByteStream = ({ bytes }: { bytes: Uint8Array }): ReadableStream<Uint8Array> => {
      let emitted = false;
      return new ReadableStream({
        pull(controller) {
          if (emitted) {
            controller.close();
            return;
          }
          emitted = true;
          controller.enqueue(bytes);
        },
      });
    };

    const ensureDirectory = async ({ path }: { path: string }): Promise<void> => {
      const segments = path.split('/').filter(segment => segment.length > 0);
      let current = '';
      for (const segment of segments) {
        current += `${segment}/`;
        if (createdDirectories.has(current)) {
          continue;
        }
        await writer.addDirectory({ name: current, modifiedAt });
        createdDirectories.add(current);
      }
    };

    const addFile = async ({
      path,
      stream,
    }: {
      path: string,
      stream: ReadableStream<Uint8Array>,
    }): Promise<void> => {
      const slashIndex = path.lastIndexOf('/');
      if (slashIndex >= 0) {
        await ensureDirectory({ path: path.slice(0, slashIndex + 1) });
      }
      await writer.addFile({
        name: path,
        modifiedAt,
        compression: 'store',
        stream,
      });
    };

    const addTextFile = async ({ path, text }: { path: string, text: string }): Promise<void> => {
      await addFile({ path, stream: createByteStream({ bytes: encoder.encode(text) }) });
    };

    const addEmptyFile = async ({ path }: { path: string }): Promise<void> => {
      await addFile({ path, stream: createByteStream({ bytes: new Uint8Array(0) }) });
    };

    const produceZip = async (): Promise<void> => {
      try {
        await ensureDirectory({ path: rootPath });
        await addTextFile({
          path: `${rootPath}export-manifest.json`,
          text: JSON.stringify({ app_version: __APP_VERSION__, exportedAt: Date.now() }, null, 2),
        });
        await addTextFile({
          path: `${rootPath}settings.json`,
          text: JSON.stringify(settingsToDto({ domain: snapshot.structure.settings }), null, 2),
        });

        if (excludeFlags.chat) {
          const filteredHierarchy: Hierarchy = {
            ...snapshot.structure.hierarchy,
            items: snapshot.structure.hierarchy.items
              .filter((item): item is Extract<HierarchyNode, { type: 'chat_group' }> => item.type === 'chat_group')
              .map(item => ({ ...item, chat_ids: [] })),
          };
          await addTextFile({
            path: `${rootPath}hierarchy.json`,
            text: JSON.stringify(hierarchyToDto({ domain: filteredHierarchy }), null, 2),
          });
        } else {
          await addTextFile({
            path: `${rootPath}hierarchy.json`,
            text: JSON.stringify(hierarchyToDto({ domain: snapshot.structure.hierarchy }), null, 2),
          });
        }

        for (const group of snapshot.structure.chatGroups) {
          await addTextFile({
            path: `${rootPath}chat-groups/${idToRaw({ id: group.id })}.json`,
            text: JSON.stringify(chatGroupToDto({ domain: group }), null, 2),
          });
        }

        if (!excludeFlags.chat) {
          const metasDto = snapshot.structure.chatMetas.map(domain => chatMetaToDto({ domain }));
          await addTextFile({
            path: `${rootPath}chat-metas.json`,
            text: JSON.stringify({ entries: metasDto }, null, 2),
          });
        }

        const shardIndices = new Map<string, BinaryShardIndexDto>();
        const currentThreadBinaryObjectIds = new Set<string>();
        const pendingBinaryObjects: Array<Extract<MigrationChunkDto, { type: 'binary_object' }>> = [];
        const getShard = ({ id }: { id: string }) => id.slice(-2).toLowerCase();

        const createBlobStream = ({ blob }: { blob: Blob }): ReadableStream<Uint8Array> => {
          if (typeof blob.stream === 'function') {
            return blob.stream();
          }

          return new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(new Uint8Array(await blob.arrayBuffer()));
              controller.close();
            },
          });
        };

        const addBinaryObjectToZip = async ({
          chunk,
        }: {
          chunk: Extract<MigrationChunkDto, { type: 'binary_object' }>,
        }): Promise<void> => {
          const shard = getShard({ id: chunk.id });
          const fileName = `${chunk.id}.bin`;
          const shardPath = `${rootPath}binary-objects/${shard}/`;
          await addFile({ path: `${shardPath}${fileName}`, stream: createBlobStream({ blob: chunk.blob }) });
          await addEmptyFile({ path: `${shardPath}.${fileName}.complete` });

          let index = shardIndices.get(shard);
          if (index === undefined) {
            index = { objects: {} };
            shardIndices.set(shard, index);
          }
          index.objects[chunk.id] = {
            id: chunk.id,
            mimeType: chunk.mimeType,
            size: chunk.size,
            createdAt: chunk.createdAt,
            name: chunk.name,
          };
        };

        for await (const chunk of snapshot.contentStream) {
          switch (chunk.type) {
          case 'chat': {
            if (excludeFlags.chat) {
              break;
            }
            if (excludeFlags.chatHistory) {
              const currentThreadExport = createCurrentThreadChatDto({ chatDto: chunk.data });
              for (const binaryObjectId of currentThreadExport.binaryObjectIds) {
                currentThreadBinaryObjectIds.add(binaryObjectId);
              }
              await addTextFile({
                path: `${rootPath}chat-contents/${chunk.data.id}.json`,
                text: JSON.stringify(currentThreadExport.chatDto, null, 2),
              });
              break;
            }
            await addTextFile({
              path: `${rootPath}chat-contents/${chunk.data.id}.json`,
              text: JSON.stringify(chunk.data, null, 2),
            });
            break;
          }
          case 'binary_object':
            if (excludeFlags.binaryObject) {
              break;
            }
            if (excludeFlags.chatHistory) {
              pendingBinaryObjects.push(chunk);
              break;
            }
            await addBinaryObjectToZip({ chunk });
            break;
          default: {
            const _ex: never = chunk;
            throw new Error(`Unknown chunk type: ${_ex}`);
          }
          }
        }

        if (excludeFlags.chatHistory && !excludeFlags.binaryObject) {
          for (const chunk of pendingBinaryObjects) {
            if (currentThreadBinaryObjectIds.has(chunk.id)) {
              await addBinaryObjectToZip({ chunk });
            }
          }
        }

        if (!excludeFlags.binaryObject) {
          for (const [shard, index] of shardIndices.entries()) {
            await addTextFile({
              path: `${rootPath}binary-objects/${shard}/index.json`,
              text: JSON.stringify(index, null, 2),
            });
          }
        }

        await writer.finalize();
        await output.close();
      } catch (error: unknown) {
        this.globalEvents.addErrorEvent({
          source: 'ImportExportService',
          message: await ensureStrings.ImportExportService__export_dump_failed(),
          details: error instanceof Error ? error : new Error(String(error)),
        });
        try {
          await output.abort({ reason: error });
        } catch {
          // The consumer may already have cancelled the stream.
        }
      } finally {
        await centralDirectoryStore.dispose();
      }
    };

    void produceZip();
    return { stream: output.stream, filename };
  }

  /**
   * Analyze ZIP file and return preview information.
   */
  async analyze({ zipFile }: { zipFile: Blob }): Promise<ImportPreview> {
    const zip = await this.loadZip({ blob: zipFile });
    try {
      const rootPath = this.findRootPath({ zip });

      const stats = { chatsCount: 0, chatGroupsCount: 0, attachmentsCount: 0, hasSettings: false, providerProfilesCount: 0 };
      const items: ImportPreviewItem[] = [];
      const chatGroupsMap = new Map<string, PreviewChatGroup>();
      const chatsMap = new Map<string, PreviewChat & { _groupId?: string | null }>();

      // 1. Settings
      let previewSettings;
      const settingsFile = zip.file({ name: rootPath + 'settings.json' });
      if (settingsFile) {
        stats.hasSettings = true;
        try {
          const result = SettingsSchemaDto.safeParse(JSON.parse(await settingsFile.readText()));
          if (result.success) {
            stats.providerProfilesCount = result.data.providerProfiles?.length ?? 0;
            previewSettings = settingsToDomain({ dto: result.data });
          }
        } catch (e) { /* Ignore */ }
      }

      // 2. Binary Objects
      const binPrefix = rootPath + 'binary-objects/';
      stats.attachmentsCount = zip.fileNames.filter(f =>
        f.startsWith(binPrefix) &&
        f.endsWith('.bin') &&
        !f.includes('/.'), // Ignore markers
      ).length;

      // 3. Chat Groups
      const groupsPrefix = rootPath + 'chat-groups/';
      for (const filename of zip.fileNames) {
        if (!filename.startsWith(groupsPrefix) || filename === groupsPrefix || filename.endsWith('/')) continue;
        try {
          const result = ChatGroupSchemaDto.safeParse(JSON.parse(await zip.file({ name: filename })!.readText()));
          if (result.success) {
            const dto = result.data;
            stats.chatGroupsCount++;
            chatGroupsMap.set(dto.id, { id: dto.id, name: dto.name, updatedAt: dto.updatedAt, items: [], isCollapsed: dto.isCollapsed, _order: 0 });
          }
        } catch (e) { /* Ignore */ }
      }

      // 4. Chat Metas
      const metasFile = zip.file({ name: rootPath + 'chat-metas.json' });
      if (metasFile) {
        try {
          const metasContent = await metasFile.readText();
          const metasJson = JSON.parse(metasContent) as { entries: unknown[] };
          if (metasJson.entries && Array.isArray(metasJson.entries)) {
            for (const meta of metasJson.entries) {
              const result = ChatMetaSchemaDto.safeParse(meta);
              if (result.success) {
                const dto = result.data;
                stats.chatsCount++;
                let messageCount = 0;
                const contentFile = zip.file({ name: `${rootPath}chat-contents/${dto.id}.json` });
                if (contentFile) {
                  try {
                    const contentJson = JSON.parse(await contentFile.readText()) as { root?: { items?: unknown[] } };
                    messageCount = contentJson.root?.items?.length ?? 0;
                  } catch (e) { /* Ignore */ }
                }
                chatsMap.set(dto.id, {
                  id: dto.id,
                  title: dto.title,
                  updatedAt: dto.updatedAt,
                  messageCount,
                  _groupId: (meta as { groupId?: string | null }).groupId ?? null,
                  _order: 0,
                });
              }
            }
          }
        } catch (e) { /* Ignore */ }
      }

      // 5. Build Hierarchy (Prefer hierarchy.json if exists, fallback to legacy fields)
      const hierarchyFile = zip.file({ name: rootPath + 'hierarchy.json' });
      if (hierarchyFile) {
        try {
          const hDto = HierarchySchemaDto.parse(JSON.parse(await hierarchyFile.readText()));
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
          this.assembleLegacyHierarchy({ chatsMap, chatGroupsMap, items });
        }
      } else {
        this.assembleLegacyHierarchy({ chatsMap, chatGroupsMap, items });
      }

      const manifestFile = zip.file({ name: rootPath + 'export-manifest.json' });
      let appVersion = 'Unknown';
      let exportedAt = 0;
      if (manifestFile) {
        try {
          const m = JSON.parse(await manifestFile.readText());
          appVersion = m.app_version || 'Unknown';
          exportedAt = m.exportedAt || 0;
        } catch (e) { /* Ignore */ }
      }

      return { appVersion, exportedAt, items, stats, previewSettings };
    } finally {
      await zip.close();
    }
  }
  private assembleLegacyHierarchy({
    chatsMap,
    chatGroupsMap,
    items,
  }: {
    chatsMap: Map<string, PreviewChat & { _groupId?: string | null }>,
    chatGroupsMap: Map<string, PreviewChatGroup>,
    items: ImportPreviewItem[],
  }) {
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
  async verify({ zipFile, config }: { zipFile: Blob, config: ImportConfig }): Promise<void> {
    const zip = await this.loadZip({ blob: zipFile });
    try {
      const rootPath = this.findRootPath({ zip });

      let snapshot: StorageSnapshot;
      const mode = config.data.mode;
      switch (mode) {
      case 'replace':
        snapshot = await this.createRestoreSnapshot({ zip, rootPath });
        break;
      case 'append':
        snapshot = await this.createAppendSnapshot({ zip, rootPath, config });
        break;
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled import mode: ${_ex}`);
      }
      }

      for await (const _ of snapshot.contentStream) { /* dry run */ }
    } finally {
      await zip.close();
    }
  }
  /**
   * Execute Import.
   */
  async executeImport({ zipFile, config }: { zipFile: Blob, config: ImportConfig }): Promise<void> {
    const zip = await this.loadZip({ blob: zipFile });
    try {
      const rootPath = this.findRootPath({ zip });
      const settingsFile = zip.file({ name: rootPath + 'settings.json' });

      const mode = config.data.mode;
      switch (mode) {
      case 'replace': {
        await this.storage.clearAll();
        if (settingsFile) {
          try {
            const result = SettingsSchemaDto.safeParse(JSON.parse(await settingsFile.readText()));
            if (result.success) await this.applySettingsImport({ zipSettings: result.data, strategies: config.settings });
          } catch (e) { /* Ignore */ }
        }
        const replaceSnapshot = await this.createRestoreSnapshot({ zip, rootPath });
        await this.storage.restore({ snapshot: replaceSnapshot });
        break;
      }
      case 'append': {
        if (settingsFile) {
          try {
            const result = SettingsSchemaDto.safeParse(JSON.parse(await settingsFile.readText()));
            if (result.success) await this.applySettingsImport({ zipSettings: result.data, strategies: config.settings });
          } catch (e) { /* Ignore */ }
        }
        const appendSnapshot = await this.createAppendSnapshot({ zip, rootPath, config });
        await this.storage.restore({ snapshot: appendSnapshot });
        break;
      }
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled import mode: ${_ex}`);
      }
      }
    } finally {
      await zip.close();
    }
  }
  private async loadZip({ blob }: { blob: Blob }): Promise<IndexedZipArchive> {
    try {
      return await openIndexedZipArchive({ blob });
    } catch (e) {
      this.globalEvents.addErrorEvent({
        source: 'ImportExportService',
        message: await ensureStrings.ImportExportService__invalid_zip_file(),
        details: e as Error,
      });
      throw new Error('Invalid ZIP file');
    }
  }

  private findRootPath({ zip }: { zip: IndexedZipArchive }): string {
    const manifestPath = zip.fileNames.find(path => path.endsWith('export-manifest.json'));
    if (!manifestPath) throw new Error('Missing export-manifest.json');

    const lastSlash = manifestPath.lastIndexOf('/');
    return lastSlash !== -1 ? manifestPath.substring(0, lastSlash + 1) : '';
  }

  private async applySettingsImport({ zipSettings, strategies }: { zipSettings: SettingsDto, strategies: ImportConfig['settings'] }) {
    await this.storage.updateSettings({ updater: ({ current: currentSettings }) => {
      const newSettingsDomain = settingsToDomain({ dto: zipSettings });
      const finalSettings: Settings = currentSettings ? { ...currentSettings } : { ...newSettingsDomain };

      const applyField = <K extends keyof Settings>({ strategy, newValue, targetKey }: { strategy: ImportFieldStrategy, newValue: Settings[K], targetKey: K }) => {
        if (strategy === 'replace' && newValue !== undefined) {
          finalSettings[targetKey] = newValue;
        }
      };

      applyField({
        strategy: strategies.endpoint,
        newValue: cloneEndpoint({ endpoint: newSettingsDomain.endpoint }),
        targetKey: 'endpoint',
      });
      applyField({ strategy: strategies.model, newValue: newSettingsDomain.defaultModelId, targetKey: 'defaultModelId' });
      applyField({ strategy: strategies.titleModel, newValue: newSettingsDomain.titleModelId, targetKey: 'titleModelId' });
      applyField({ strategy: strategies.systemPrompt, newValue: newSettingsDomain.systemPrompt, targetKey: 'systemPrompt' });
      applyField({ strategy: strategies.lmParameters, newValue: newSettingsDomain.lmParameters, targetKey: 'lmParameters' });

      // Always merge UI flags if present in the import
      if (newSettingsDomain.heavyContentAlertDismissed !== undefined) {
        finalSettings.heavyContentAlertDismissed = newSettingsDomain.heavyContentAlertDismissed;
      }
      if (newSettingsDomain.autoTitleEnabled !== undefined) {
        finalSettings.autoTitleEnabled = newSettingsDomain.autoTitleEnabled;
      }

      switch (strategies.providerProfiles) {
      case 'replace':
        finalSettings.providerProfiles = newSettingsDomain.providerProfiles;
        break;
      case 'append': {
        const appended = newSettingsDomain.providerProfiles.map(profile => ({
          ...profile,
          id: generateId<ProviderProfileId>(),
          endpoint: cloneEndpoint({ endpoint: profile.endpoint }),
        }));
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
    } });
  }

  private async createRestoreSnapshot({ zip, rootPath }: { zip: IndexedZipArchive, rootPath: string }): Promise<StorageSnapshot> {
    const hierarchyFile = zip.file({ name: rootPath + 'hierarchy.json' });
    const hierarchyDto: HierarchyDto = hierarchyFile
      ? HierarchySchemaDto.parse(JSON.parse(await hierarchyFile.readText()))
      : { items: [] };

    const metasFile = zip.file({ name: rootPath + 'chat-metas.json' });
    const metasDto: ChatMetaDto[] = [];
    if (metasFile) {
      try {
        const json = JSON.parse(await metasFile.readText());
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
    for (const filename of zip.fileNames) {
      if (filename.startsWith(groupsPrefix) && !filename.endsWith('/') && filename !== groupsPrefix) {
        try {
          const result = ChatGroupSchemaDto.safeParse(JSON.parse(await zip.file({ name: filename })!.readText()));
          if (result.success) groupsDto.push(result.data);
        } catch (e) { /* Ignore */ }
      }
    }

    const settingsFile = zip.file({ name: rootPath + 'settings.json' });
    const settingsDto = settingsFile ? SettingsSchemaDto.parse(JSON.parse(await settingsFile.readText())) : null;

    // Load all shard indices from the ZIP
    const binPrefix = rootPath + 'binary-objects/';
    const unifiedBinIndex = new Map<string, BinaryObjectDto>();
    for (const filename of zip.fileNames) {
      if (filename.startsWith(binPrefix) && filename.endsWith('index.json')) {
        try {
          const shardIndex = BinaryShardIndexSchemaDto.parse(JSON.parse(await zip.file({ name: filename })!.readText()));
          for (const [id, object] of Object.entries(shardIndex.objects)) {
            unifiedBinIndex.set(id, object);
          }
        } catch (e) { /* Ignore corrupted index */ }
      }
    }

    const chatMetas = metasDto.map(dto => chatMetaToDomain({ dto }));
    const hierarchy = hierarchyToDomain({ dto: hierarchyDto });
    const chatGroups = groupsDto.map(dto => chatGroupToDomain({ dto, hierarchy, chatMetas }));

    const contentStream = async function* (): AsyncGenerator<MigrationChunkDto> {
      for (const meta of metasDto) {
        const contentFile = zip.file({ name: `${rootPath}chat-contents/${meta.id}.json` });
        if (contentFile) {
          try {
            const content = ChatContentSchemaDto.parse(JSON.parse(await contentFile.readText()));
            yield { type: 'chat' as const, data: { ...meta, ...content, experimental: meta.experimental, messages: undefined } };
          } catch (e) { /* Ignore */ }
        }
      }

      // Yield binary objects found in shards
      for (const filename of zip.fileNames) {
        if (filename.startsWith(binPrefix) && filename.endsWith('.bin') && !filename.includes('/.')) {
          const parts = filename.substring(binPrefix.length).split('/');
          if (parts.length === 2) {
            const bId = parts[1]!.replace('.bin', '');
            const meta = unifiedBinIndex.get(bId);
            if (meta) {
              const blob = await zip.file({ name: filename })!.readBlob();
              yield {
                type: 'binary_object' as const,
                id: bId,
                name: meta.name || 'file',
                mimeType: meta.mimeType,
                size: meta.size,
                createdAt: meta.createdAt,
                blob,
              };
            }
          }
        }
      }
    };

    return {
      structure: {
        settings: settingsDto ? settingsToDomain({ dto: settingsDto }) : {
          autoTitleEnabled: true,
          providerProfiles: [],
          mounts: [],
          storageType: 'local',
          endpoint: { type: 'openai', url: '' },
        } as Settings,
        hierarchy,
        chatMetas,
        chatGroups,
      },
      contentStream: contentStream(),
    };
  }

  private async createAppendSnapshot({ zip, rootPath, config }: { zip: IndexedZipArchive, rootPath: string, config: ImportConfig }): Promise<StorageSnapshot> {
    const groupIdMap = new Map<string, string>();
    const chatIdMap = new Map<string, string>();

    // 1. Groups
    const groupsPrefix = rootPath + 'chat-groups/';
    const importedGroupsDto: ChatGroupDto[] = [];
    for (const filename of zip.fileNames) {
      if (filename.startsWith(groupsPrefix) && !filename.endsWith('/') && filename !== groupsPrefix) {
        try {
          const result = ChatGroupSchemaDto.safeParse(JSON.parse(await zip.file({ name: filename })!.readText()));
          if (result.success) {
            const dto = result.data;
            const newId = idToRaw({ id: generateId<ChatGroupId>() });
            groupIdMap.set(dto.id, newId);
            dto.id = newId;
            if (config.data.chatGroupNamePrefix) dto.name = `${config.data.chatGroupNamePrefix}${dto.name}`;
            importedGroupsDto.push(dto);
          }
        } catch (e) { /* Ignore */ }
      }
    }

    // 2. Metas
    const metasFile = zip.file({ name: rootPath + 'chat-metas.json' });
    const importedMetas: { dto: ChatMetaDto, originalId: string }[] = [];
    if (metasFile) {
      try {
        const json = JSON.parse(await metasFile.readText());
        for (const meta of (json.entries || [])) {
          const res = ChatMetaSchemaDto.safeParse(meta);
          if (res.success) {
            const dto = res.data;
            const originalId = dto.id;
            const newId = idToRaw({ id: generateId<ChatId>() });
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
    const hierarchyFile = zip.file({ name: rootPath + 'hierarchy.json' });
    let importedHierarchyItems: HierarchyNode[] = [];
    if (hierarchyFile) {
      try {
        const hDto = HierarchySchemaDto.parse(JSON.parse(await hierarchyFile.readText()));
        importedHierarchyItems = hDto.items.map(node => {
          switch (node.type) {
          case 'chat':
            return { type: 'chat', id: toChatId({ raw: chatIdMap.get(node.id) || node.id }) };
          case 'chat_group':
            return { type: 'chat_group', id: toChatGroupId({ raw: groupIdMap.get(node.id) || node.id }), chat_ids: node.chat_ids.map(cid => toChatId({ raw: chatIdMap.get(cid) || cid })) };
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
        ...importedGroupsDto.map(g => ({ type: 'chat_group' as const, id: toChatGroupId({ raw: g.id }), chat_ids: [] })),
        ...importedMetas.map(m => ({ type: 'chat' as const, id: toChatId({ raw: m.dto.id }) })),
      ];
    }

    const mergedHierarchy: Hierarchy = { items: [...currentHierarchy.items, ...importedHierarchyItems] };
    const chatMetas = importedMetas.map(({ dto }) => {
      // Remap fork origin if possible
      if (dto.originChatId && chatIdMap.has(dto.originChatId)) {
        dto.originChatId = chatIdMap.get(dto.originChatId)!;
        // Note: originMessageId remapping is harder as we don't have all messageIdMaps yet.
        // But we can handle it inside contentStream if we process in a way that allows it.
      }
      return chatMetaToDomain({ dto });
    });
    const chatGroups = importedGroupsDto.map(dto => chatGroupToDomain({ dto, hierarchy: mergedHierarchy, chatMetas }));

    const contentStream = async function* (): AsyncGenerator<MigrationChunkDto> {
      // 1. Unified metadata lookup for append remapping
      const binPrefix = rootPath + 'binary-objects/';
      const unifiedBinIndex = new Map<string, BinaryObjectDto>();
      for (const filename of zip.fileNames) {
        if (filename.startsWith(binPrefix) && filename.endsWith('index.json')) {
          try {
            const shardIndex = BinaryShardIndexSchemaDto.parse(JSON.parse(await zip.file({ name: filename })!.readText()));
            for (const [id, object] of Object.entries(shardIndex.objects)) {
              unifiedBinIndex.set(id, object);
            }
          } catch (e) { /* skip */ }
        }
      }

      // Map to track which original binaryObjectId has been remapped to which new one
      const binaryRemapMap = new Map<string, string>();

      for (const { dto: meta, originalId } of importedMetas) {
        const contentFile = zip.file({ name: `${rootPath}chat-contents/${originalId}.json` });
        if (contentFile) {
          try {
            const content = ChatContentSchemaDto.parse(JSON.parse(await contentFile.readText()));
            const dto: ChatDto = {
              ...meta,
              ...content,
              experimental: meta.experimental,
              // ChatContentSchemaDto materializes missing currentLeafId as undefined.
              currentLeafId: content.currentLeafId ?? meta.currentLeafId,
              messages: undefined,
            };

            const messageIdMap = new Map<string, string>();
            const process = ({ node }: { node: MessageNodeDto }) => {
              const oldMsgId = node.id;
              const newMsgId = idToRaw({ id: generateId<MessageId>() });
              messageIdMap.set(oldMsgId, newMsgId);
              node.id = newMsgId;

              if (node.attachments) {
                node.attachments.forEach(a => {
                  // remap attachment ID (the reference)
                  const originalAttId = a.id;
                  a.id = idToRaw({ id: generateId<AttachmentId>() });

                  // Resolve binaryObjectId from V1 or V2
                  const oldBinaryId = ('binaryObjectId' in a) ? a.binaryObjectId : originalAttId;

                  if (!binaryRemapMap.has(oldBinaryId)) {
                    binaryRemapMap.set(oldBinaryId, idToRaw({ id: generateId<BinaryObjectId>() }));
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
              if (node.replies?.items) node.replies.items.forEach(node => process({ node }));
            };
            if (dto.root?.items) dto.root.items.forEach(node => process({ node }));

            // Remap currentLeafId using the messageIdMap
            if (dto.currentLeafId && messageIdMap.has(dto.currentLeafId)) {
              dto.currentLeafId = messageIdMap.get(dto.currentLeafId);
            }

            // Remap originMessageId if it refers to a message in this chat
            if (dto.originMessageId && messageIdMap.has(dto.originMessageId)) {
              dto.originMessageId = messageIdMap.get(dto.originMessageId);
            }

            yield { type: 'chat' as const, data: dto };
          } catch (e) { /* Ignore */ }
        }
      }

      // Yield binary objects from shards using the remapped IDs
      for (const filename of zip.fileNames) {
        if (filename.startsWith(binPrefix) && filename.endsWith('.bin') && !filename.includes('/.')) {
          const parts = filename.substring(binPrefix.length).split('/');
          if (parts.length === 2) {
            const oldBinaryId = parts[1]!.replace('.bin', '');
            const newBinaryId = binaryRemapMap.get(oldBinaryId);
            const meta = unifiedBinIndex.get(oldBinaryId);
            if (newBinaryId && meta) {
              const blob = await zip.file({ name: filename })!.readBlob();
              yield {
                type: 'binary_object' as const,
                id: newBinaryId,
                name: meta.name || 'file',
                mimeType: meta.mimeType,
                size: meta.size,
                createdAt: meta.createdAt,
                blob,
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
          mounts: [],
          storageType: 'local',
          endpoint: { type: 'openai', url: '' },
        } as Settings,
        hierarchy: mergedHierarchy,
        chatMetas,
        chatGroups,
      },
      contentStream: contentStream(),
    };
  }
}
