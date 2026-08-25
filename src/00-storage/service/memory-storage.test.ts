import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorageProvider } from './memory-storage';
import type { Chat, ChatContent, ChatGroup } from '@/01-models/types';
import type { MigrationChunkDto } from '@/00-storage/00-dto/dto';
import { idToRaw, toAttachmentId, toBinaryObjectId, toChatGroupId, toChatId, toMessageId, toVolumeId } from '@/01-models/ids';

describe('MemoryStorageProvider', () => {
  let provider: MemoryStorageProvider;

  beforeEach(() => {
    provider = new MemoryStorageProvider();
  });

  it('should save and load a chat', async () => {
    const mockChat: Chat = {
      id: toChatId({ raw: '123e4567-e89b-12d3-a456-426614174000' }),
      title: 'Test Chat',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      systemPrompt: undefined,
      debugEnabled: false,
    };

    await provider.saveChatContent({ id: mockChat.id, content: mockChat });
    await provider.saveChatMeta({ meta: mockChat });
    const loaded = await provider.loadChat({ id: mockChat.id });
    expect(loaded).toEqual(expect.objectContaining(mockChat));
  });

  it('should load chat content without restoring attachment blobs', async () => {
    const blob = new Blob(['attachment'], { type: 'text/plain' });
    const chatId = toChatId({ raw: '123e4567-e89b-12d3-a456-426614174000' });
    const content: ChatContent = {
      root: {
        items: [{
          id: toMessageId({ raw: '123e4567-e89b-12d3-a456-426614174001' }),
          role: 'user',
          content: 'hello',
          timestamp: 1,
          attachments: [{
            id: toAttachmentId({ raw: '123e4567-e89b-12d3-a456-426614174002' }),
            binaryObjectId: toBinaryObjectId({ raw: '123e4567-e89b-12d3-a456-426614174003' }),
            originalName: 'attachment.txt',
            mimeType: blob.type,
            size: blob.size,
            uploadedAt: 1,
            status: 'memory',
            blob,
          }],
          replies: { items: [] },
        }],
      },
    };

    await provider.saveChatContent({ id: chatId, content });

    const unhydrated = await provider.loadChatContentWithoutAttachments({ id: chatId });
    const hydrated = await provider.loadChatContent({ id: chatId });

    expect(unhydrated?.root.items[0]?.attachments?.[0]).not.toHaveProperty('blob');
    expect(hydrated?.root.items[0]?.attachments?.[0]).toHaveProperty('blob', blob);
  });

  it('finds a volume reference in chat metadata even when the chat is detached from the hierarchy', async () => {
    const volumeId = toVolumeId({ raw: 'volume-detached-chat' });
    const chatId = toChatId({ raw: 'detached-chat' });
    await provider.saveChatMeta({ meta: {
      id: chatId,
      title: 'Detached',
      createdAt: 1,
      updatedAt: 1,
      debugEnabled: false,
      mounts: [{ type: 'volume', volumeId, mountPath: '/workspace', readOnly: false }],
    } });

    await expect(provider.hasVolumeMountReference({ volumeId })).resolves.toBe(true);
    await expect(provider.hasVolumeMountReference({ volumeId: toVolumeId({ raw: 'unreferenced' }) })).resolves.toBe(false);
  });

  it('finds a volume reference in a chat group even when the group is detached from the hierarchy', async () => {
    const volumeId = toVolumeId({ raw: 'volume-detached-group' });
    await provider.saveChatGroup({ chatGroup: {
      id: toChatGroupId({ raw: 'detached-group' }),
      name: 'Detached Group',
      updatedAt: 1,
      isCollapsed: false,
      items: [],
      mounts: [{ type: 'volume', volumeId, mountPath: '/workspace', readOnly: false }],
    } });

    await expect(provider.hasVolumeMountReference({ volumeId })).resolves.toBe(true);
  });

  it('should list saved chats based on hierarchy', async () => {
    const mockChat: Chat = {
      id: toChatId({ raw: '123e4567-e89b-12d3-a456-426614174000' }),
      title: 'Test Chat',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      systemPrompt: undefined,
      debugEnabled: false,
    };

    await provider.saveChatContent({ id: mockChat.id, content: mockChat });
    await provider.saveChatMeta({ meta: mockChat });
    await provider.saveHierarchy({ hierarchy: { items: [{ type: 'chat', id: idToRaw({ id: mockChat.id }) }] } });
    const list = await provider.listChats();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(mockChat.id);
  });

  it('should delete a chat', async () => {
    const mockChat: Chat = {
      id: toChatId({ raw: '123e4567-e89b-12d3-a456-426614174000' }),
      title: 'Test Chat',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      systemPrompt: undefined,
      debugEnabled: false,
    };

    await provider.saveChatContent({ id: mockChat.id, content: mockChat });
    await provider.saveChatMeta({ meta: mockChat });
    await provider.deleteChat({ id: mockChat.id });
    const loaded = await provider.loadChat({ id: mockChat.id });
    expect(loaded).toBeNull();
  });

  it('should save and load binary files', async () => {
    const blob = new Blob(['hello'], { type: 'text/plain' });
    const binaryObjectId = 'bin-123';
    const name = 'test.txt';

    await provider.saveFile({ blob, binaryObjectId: toBinaryObjectId({ raw: binaryObjectId }), name });
    const loadedBlob = await provider.getFile({ binaryObjectId: toBinaryObjectId({ raw: binaryObjectId }) });
    expect(loadedBlob).not.toBeNull();
    expect(loadedBlob?.size).toBe(blob.size);
    expect(loadedBlob?.type).toBe(blob.type);

    const meta = await provider.getBinaryObject({ binaryObjectId: toBinaryObjectId({ raw: binaryObjectId }) });
    expect(meta?.name).toBe(name);
  });

  it('should preserve binary metadata across migration restore and dump', async () => {
    const binaryObjectId = toBinaryObjectId({ raw: 'bin-metadata-1' });
    const blob = new Blob(['hello'], { type: 'text/plain' });
    const createdAt = 123456789;
    const chunk = {
      type: 'binary_object',
      id: idToRaw({ id: binaryObjectId }),
      name: '',
      mimeType: '',
      size: blob.size,
      createdAt,
      blob,
    } satisfies MigrationChunkDto;

    async function* contentStream() {
      yield chunk;
    }

    await provider.restore({
      snapshot: {
        structure: {
          settings: {
            endpoint: { type: 'openai', url: '' },
            titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
            storageType: 'memory',
            providerProfiles: [],
            mounts: [],
          },
          hierarchy: { items: [] },
          chatMetas: [],
          chatGroups: [],
        },
        contentStream: contentStream(),
      },
    });

    const meta = await provider.getBinaryObject({ binaryObjectId });
    expect(meta).toEqual(expect.objectContaining({
      name: '',
      mimeType: '',
      createdAt,
    }));

    const snapshot = await provider.dump();
    const chunks: MigrationChunkDto[] = [];
    for await (const item of snapshot.contentStream) {
      chunks.push(item);
    }

    expect(chunks).toEqual([
      expect.objectContaining({
        type: 'binary_object',
        id: idToRaw({ id: binaryObjectId }),
        name: '',
        mimeType: '',
        createdAt,
      }),
    ]);
  });

  describe('Hierarchy Persistence', () => {
    it('should save and load hierarchy correctly', async () => {
      const mockHierarchy = {
        items: [
          { type: 'chat' as const, id: '019bd241-2d57-716b-a9fd-1efbba88cfb1' },
          { type: 'chat_group' as const, id: '019bd241-2d57-716b-a9fd-1efbba88cfb2', chat_ids: ['019bd241-2d57-716b-a9fd-1efbba88cfb3'] },
        ],
      };

      await provider.saveHierarchy({ hierarchy: mockHierarchy });
      const loaded = await provider.loadHierarchy();
      expect(loaded).toEqual(mockHierarchy);
    });

    it('should return empty items if hierarchy is missing', async () => {
      const loaded = await provider.loadHierarchy();
      expect(loaded).toEqual({ items: [] });
    });
  });

  describe('Strict Hierarchy Visibility', () => {
    it('should NOT show chats or groups in lists unless they are present in the hierarchy', async () => {
      const mockChat: Chat = {
        id: toChatId({ raw: '019bd241-2d57-716b-a9fd-1efbba88cfb1' }),
        title: 'Hidden Chat',
        root: { items: [] },
        createdAt: 100,
        updatedAt: 100,
        debugEnabled: false,
      };

      const mockGroup: ChatGroup = {
        id: toChatGroupId({ raw: '019bd241-2d57-716b-a9fd-1efbba88cfb2' }),
        name: 'Hidden Group',
        isCollapsed: false,
        updatedAt: 100,
        items: [],
      };

      await provider.saveChatMeta({ meta: mockChat });
      await provider.saveChatContent({ id: mockChat.id, content: mockChat });
      await provider.saveChatGroup({ chatGroup: mockGroup });

      const chats = await provider.listChats();
      const groups = await provider.listChatGroups();

      expect(chats).toHaveLength(0);
      expect(groups).toHaveLength(0);

      await provider.saveHierarchy({ hierarchy: {
        items: [
          { type: 'chat_group', id: idToRaw({ id: mockGroup.id }), chat_ids: [idToRaw({ id: mockChat.id })] },
        ],
      } });

      const visibleChats = await provider.listChats();
      const visibleGroups = await provider.listChatGroups();

      expect(visibleChats).toHaveLength(1);
      expect(visibleChats[0]?.id).toBe(mockChat.id);
      expect(visibleGroups).toHaveLength(1);
      expect(visibleGroups[0]?.id).toBe(mockGroup.id);
    });
  });
});
