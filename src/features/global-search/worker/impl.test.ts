import { describe, expect, it, vi } from 'vitest';
import { createGlobalSearchWorker } from './impl';
import type { ChatContent, MessageNode } from '@/01-models/types';
import { toMessageId } from '@/01-models/ids';

function createContent(): ChatContent {
  return {
    root: {
      items: [{
        id: toMessageId({ raw: 'message-1' }),
        role: 'user',
        modelId: undefined, lmParameters: undefined,
        parts: [{ id: 'text', type: 'text', text: 'searchable content', completeness: 'complete' }],
        createdAt: 1,
        replies: { items: [] },
      }],
    },
    currentLeafId: toMessageId({ raw: 'message-1' }),
  };
}

describe('createGlobalSearchWorker', () => {
  it('loads content through the configured remote reader', async () => {
    const loadChatContentWithoutAttachments = vi.fn().mockResolvedValue(createContent());
    const worker = createGlobalSearchWorker();
    await worker.configureStorage('memory', {
      loadChatContentWithoutAttachments,
    });

    const response = await worker.searchChatContent({
      request: {
        storageType: 'memory',
        searchQuery: 'searchable',
        scope: 'all',
        roleFilter: 'all',
        chatId: 'chat-1',
      },
    });

    expect(loadChatContentWithoutAttachments).toHaveBeenCalledWith({ chatId: 'chat-1' });
    expect(response.matches).toHaveLength(1);
    expect(response.matches[0]?.messageId).toBe('message-1');
  });

  it('searches deeply nested content from the remote reader without recursive boundary validation', async () => {
    const depth = 10_000;
    const content = createContent();
    const root = content.root.items[0];
    if (root === undefined) throw new Error('Expected root message');
    let current: MessageNode = root;

    for (let index = 1; index < depth; index++) {
      const next: MessageNode = {
        id: toMessageId({ raw: `message-${index + 1}` }),
        ...(index % 2 === 0 ? { role: 'user' as const } : { role: 'assistant' as const, interruption: undefined }),
        modelId: undefined, lmParameters: undefined,
        parts: [{ id: 'text', type: 'text', text: index === depth - 1 ? 'deep searchable content' : String(index), completeness: 'complete' }],
        createdAt: index + 1,
        replies: { items: [] },
      };
      current.replies.items.push(next);
      current = next;
    }
    content.currentLeafId = current.id;

    const worker = createGlobalSearchWorker();
    await worker.configureStorage('memory', {
      loadChatContentWithoutAttachments: vi.fn().mockResolvedValue(content),
    });

    const response = await worker.searchChatContent({
      request: {
        storageType: 'memory',
        searchQuery: 'deep searchable',
        scope: 'all',
        roleFilter: 'all',
        chatId: 'chat-1',
      },
    });

    expect(response.matches).toHaveLength(1);
    expect(response.matches[0]?.messageId).toBe(`message-${depth}`);
  });

  it('rejects content searches before storage is configured', async () => {
    const worker = createGlobalSearchWorker();

    await expect(worker.searchChatContent({
      request: {
        storageType: 'memory',
        searchQuery: 'searchable',
        scope: 'all',
        roleFilter: 'all',
        chatId: 'chat-1',
      },
    })).rejects.toThrow('storage is not configured');
  });

  it('rejects a search request for a different storage type', async () => {
    const worker = createGlobalSearchWorker();
    await worker.configureStorage('memory', {
      loadChatContentWithoutAttachments: vi.fn().mockResolvedValue(createContent()),
    });

    await expect(worker.searchChatContent({
      request: {
        storageType: 'local',
        searchQuery: 'searchable',
        scope: 'all',
        roleFilter: 'all',
        chatId: 'chat-1',
      },
    })).rejects.toThrow('configured for memory storage');
  });

  it('requires a remote reader for local and memory storage', async () => {
    const worker = createGlobalSearchWorker();

    await expect(worker.configureStorage('local')).rejects.toThrow(
      'local storage requires a remote content reader',
    );
  });

  it('returns no matches when the chat no longer exists', async () => {
    const worker = createGlobalSearchWorker();
    await worker.configureStorage('memory', {
      loadChatContentWithoutAttachments: vi.fn().mockResolvedValue(null),
    });

    await expect(worker.searchChatContent({
      request: {
        storageType: 'memory',
        searchQuery: 'searchable',
        scope: 'all',
        roleFilter: 'all',
        chatId: 'chat-1',
      },
    })).resolves.toEqual({ matches: [] });
  });
});
