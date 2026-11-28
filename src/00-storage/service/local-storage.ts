import { buildChatGroup, buildSidebarItemsFromHierarchy } from './sidebar-items';
import { localStorageFormat } from '@/00-format/01-layout/layout';
import { type ExperimentalModelGraphRegistryDto } from '@/00-format/00-dto/experimental-model-graph.dto';
import { iterateAttachmentParts } from './message-attachments';
import { DEFAULT_SETTINGS_ENDPOINT, type Chat, type Settings, type ChatGroup, type MessageNode, type ChatMeta, type ChatContent, type SidebarItem, type StorageSnapshot, type BinaryObject, type Hierarchy } from '@/01-models/types';
import type { AttachmentId, BinaryObjectId, ChatGroupId, ChatId, VolumeId } from '@/01-models/ids';
import type { StoredChatMeta, StoredChatGroup } from '@/00-format/core-records';
import { chatToDomain, chatToDto } from '@/00-format/mapper/mappers';
import { IStorageProvider } from './interface';

import { promiseAllKeyed } from '@/utils/promise';
import { type ExperimentalNaidanRpcRegistryDto } from '@/00-format/00-dto/experimental-naidan-rpc.dto';

/**
 * LocalStorage Implementation
 * Optimized by splitting metadata and content into individual keys.
 * Uses a centralized hierarchy record for ordering.
 */
export class LocalStorageProvider extends IStorageProvider {
  readonly canPersistBinary = false;
  private blobCache = new Map<AttachmentId, Blob>();

  async readNaidanRpcRegistryForTransfer(): Promise<ExperimentalNaidanRpcRegistryDto | undefined> {
    return localStorageFormat.provider.rpcConnections.readForTransfer({ storage: localStorage });
  }

  async writeNaidanRpcRegistryForTransfer({ registry }: { registry: ExperimentalNaidanRpcRegistryDto | undefined }): Promise<void> {
    localStorageFormat.provider.rpcConnections.writeForTransfer({ registry, storage: localStorage });
  }

  async readModelGraphRegistryForTransfer(): Promise<ExperimentalModelGraphRegistryDto | undefined> {
    return localStorageFormat.provider.modelGraph.readForTransfer({ storage: localStorage });
  }

  async writeModelGraphRegistryForTransfer({ registry }: { registry: ExperimentalModelGraphRegistryDto | undefined }): Promise<void> {
    localStorageFormat.provider.modelGraph.writeForTransfer({ registry, storage: localStorage });
  }

  private restoreBlobs({ nodes }: { nodes: MessageNode[] }): void {
    for (const part of iterateAttachmentParts({ nodes })) {
      const att = part.attachment;
      switch (att.status) {
      case 'memory': {
        const cached = this.blobCache.get(att.id);
        if (cached) {
          part.attachment = { ...att, blob: cached };
        }
        break;
      }
      case 'persisted':
      case 'missing':
        break;
      default: {
        const _ex: never = att;
        throw new Error(`Unhandled attachment status: ${_ex}`);
      }
      }
    }
  }

  private loadUnhydratedChatContent({ id }: { id: ChatId }): ChatContent | null {
    // A stored but unreadable record must not become a new, empty conversation
    // when a caller performs a read-update-write operation.
    return localStorageFormat.provider.chatContents.read({ id, storage: localStorage }) ?? null;
  }

  async init(): Promise<void> {
    // No-op for localStorage
  }

  // --- Internal Data Access ---

  protected async listStoredChatMetas(): Promise<StoredChatMeta[]> {
    return localStorageFormat.provider.chatMetas.list({ storage: localStorage });
  }

  protected async listStoredChatGroups(): Promise<StoredChatGroup[]> {
    return localStorageFormat.provider.chatGroups.list({ storage: localStorage });
  }

  async loadHierarchy(): Promise<Hierarchy> {
    return localStorageFormat.provider.hierarchy.read({ storage: localStorage }) ?? { items: [] };
  }

  async saveHierarchy({ hierarchy }: { hierarchy: Hierarchy }): Promise<void> {
    localStorageFormat.provider.hierarchy.write({ hierarchy, storage: localStorage });
  }

  // --- Persistence Implementation ---

  async saveChatMeta({ meta }: { meta: ChatMeta }): Promise<void> {
    localStorageFormat.provider.chatMetas.write({ meta, storage: localStorage });
  }

  async saveChatContent({ id, content }: { id: ChatId, content: ChatContent }): Promise<void> {
    for (const part of iterateAttachmentParts({ nodes: content.root.items })) {
      const att = part.attachment;
      switch (att.status) {
      case 'memory':
        if (att.blob) {
          this.blobCache.set(att.id, att.blob);
        }
        break;
      case 'persisted':
      case 'missing':
        break;
      default: {
        const _ex: never = att;
        throw new Error(`Unhandled attachment status: ${_ex}`);
      }
      }
    }

    localStorageFormat.provider.chatContents.write({ id, content, storage: localStorage });
  }

  async loadChat({ id }: { id: ChatId }): Promise<Chat | null> {
    const chat = localStorageFormat.provider.chats.read({ id, storage: localStorage });
    if (chat === undefined) {
      return null;
    }

    const groupId = localStorageFormat.provider.hierarchy.findChatGroupId({ id, storage: localStorage });
    if (groupId !== undefined) {
      chat.groupId = groupId;
    }

    this.restoreBlobs({ nodes: chat.root.items });

    return chat;
  }

  async loadChatMeta({ id }: { id: ChatId }): Promise<ChatMeta | null> {
    const meta = localStorageFormat.provider.chatMetas.read({ id, storage: localStorage });
    if (meta === undefined) {
      return null;
    }
    const groupId = localStorageFormat.provider.hierarchy.findChatGroupId({ id, storage: localStorage });
    if (groupId !== undefined) {
      meta.groupId = groupId;
    }
    return meta;
  }

  async loadChatContent({ id }: { id: ChatId }): Promise<ChatContent | null> {
    const content = this.loadUnhydratedChatContent({ id });
    if (content === null) {
      return null;
    }

    this.restoreBlobs({ nodes: content.root.items });
    return content;
  }

  async loadChatContentWithoutAttachments({ id }: { id: ChatId }): Promise<ChatContent | null> {
    return this.loadUnhydratedChatContent({ id });
  }

  async deleteChat({ id }: { id: ChatId }): Promise<void> {
    localStorageFormat.provider.chats.remove({ id, storage: localStorage });
  }

  async saveChatGroup({ chatGroup }: { chatGroup: ChatGroup }): Promise<void> {
    localStorageFormat.provider.chatGroups.write({ chatGroup, storage: localStorage });
  }

  async loadChatGroupConfiguration({ id }: { id: ChatGroupId }): Promise<Omit<ChatGroup, 'items'> | null> {
    return localStorageFormat.provider.chatGroups.capture({ id, storage: localStorage })?.().configuration() ?? null;
  }

  async loadChatGroup({ id }: { id: ChatGroupId }): Promise<ChatGroup | null> {
    const decode = localStorageFormat.provider.chatGroups.capture({ id, storage: localStorage });
    if (decode === undefined) {
      return null;
    }
    const { hierarchy, allMetas } = await promiseAllKeyed({
      hierarchy: this.loadHierarchy(),
      allMetas: this.listStoredChatMetas(),
    });
    const chatMetas = allMetas.map(record => record.toDomain());
    return buildChatGroup({ configuration: decode().configuration(), hierarchy, chatMetas });
  }

  async deleteChatGroup({ id }: { id: ChatGroupId }): Promise<void> {
    localStorageFormat.provider.chatGroups.remove({ id, storage: localStorage });
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

  async saveSettings({ settings }: { settings: Settings }): Promise<void> {
    localStorageFormat.provider.settings.write({ settings, storage: localStorage });
  }

  async loadSettings(): Promise<Settings | null> {
    const decode = localStorageFormat.provider.settings.capture({ storage: localStorage });
    if (decode === undefined) {
      return null;
    }
    try {
      return decode();
    } catch {
      // Unavailable RPC bytes must not masquerade as absent settings.
      return null;
    }
  }

  // --- Volume Management ---

  async *listVolumes(): AsyncIterable<import('@/01-models/types').Volume> {
    // LocalStorage doesn't support volumes
  }

  async createVolume({ name: _name, type: _type, sourceHandle: _sourceHandle }: {
    name: string,
    type: import('@/01-models/types').VolumeType,
    sourceHandle: FileSystemDirectoryHandle,
  }): Promise<import('@/01-models/types').Volume> {
    throw new Error('Volume management is not supported in LocalStorage provider.');
  }

  async createVolumeFromFiles({ name: _name, entries: _entries, onProgress: _onProgress, signal: _signal }: {
    name: string,
    entries: Array<{ file: File, relativePath: string }>,
    onProgress?: ({ processed, total }: { processed: number, total: number }) => void,
    signal?: AbortSignal,
  }): Promise<import('@/01-models/types').Volume> {
    throw new Error('Volume management is not supported in LocalStorage provider.');
  }

  async getVolumeDirectoryHandle({ volumeId: _volumeId }: {
    volumeId: VolumeId,
  }): Promise<FileSystemDirectoryHandle | null> {
    return null;
  }

  async deleteVolume({ volumeId: _volumeId }: {
    volumeId: VolumeId,
  }): Promise<void> {
    throw new Error('Volume management is not supported in LocalStorage provider.');
  }

  async renameVolume({ volumeId: _volumeId, name: _name }: {
    volumeId: VolumeId,
    name: string,
  }): Promise<void> {
    throw new Error('Volume management is not supported in LocalStorage provider.');
  }

  // --- File Storage ---

  async saveFile({
    blob: _blob,
    binaryObjectId: _binaryObjectId,
    name: _name,
    mimeType: _mimeType,
  }: {
    blob: Blob,
    binaryObjectId: BinaryObjectId,
    name: string,
    mimeType?: string,
  }): Promise<void> {
    throw new Error('File persistence is not supported in LocalStorage provider.');
  }

  async getFile({ binaryObjectId: _binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<Blob | null> {
    return null;
  }

  async getBinaryObject({ binaryObjectId: _id }: { binaryObjectId: BinaryObjectId }): Promise<BinaryObject | null> {
    return null;
  }

  async hasAttachments(): Promise<boolean> {
    return false;
  }

  async *listBinaryObjects(): AsyncIterable<BinaryObject> {
    // Yields nothing
  }

  async deleteBinaryObject({ binaryObjectId: _binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<void> {
    // No-op
  }

  async clearAll(): Promise<void> {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null && localStorageFormat.provider.ownsKey({ key })) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
    this.blobCache.clear();
  }

  // --- Migration Implementation ---

  async dump(): Promise<StorageSnapshot> {
    const { settings, hierarchy, metas, groups } = await promiseAllKeyed({
      settings: this.loadSettings(),
      hierarchy: this.loadHierarchy(),
      metas: this.listStoredChatMetas(),
      groups: this.listStoredChatGroups(),
    });

    const chatMetas = metas.map(record => record.toDomain());
    const chatGroups = groups.map(record => buildChatGroup({ configuration: record.configuration(), hierarchy, chatMetas }));

    const contentStream = async function* (this: LocalStorageProvider) {
      for (const m of metas) {
        const chat = await this.loadChat({ id: m.id });
        if (chat) {
          yield { type: 'chat' as const, data: chatToDto({ domain: chat }) };
        }
      }
    };

    return {
      structure: {
        settings: settings || {
          titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
          providerProfiles: [],
          mounts: [],
          storageType: 'local',
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

    // 1. Restore Structural Metadata (skeleton)
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

    // 2. Restore Heavy Content (trees)
    for await (const chunk of contentStream) {
      const type = chunk.type;
      switch (type) {
      case 'chat': {
        const domainChat = chatToDomain({ dto: chunk.data });
        await this.saveChatContent({ id: domainChat.id, content: domainChat });
        // Ensure meta is consistent with content
        await this.saveChatMeta({ meta: domainChat });
        break;
      }
      case 'binary_object':
        // LocalStorage does not support binary attachments, skip
        break;
      default: {
        const _ex: never = type;
        throw new Error(`Unknown chunk type: ${_ex}`);
      }
      }
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
