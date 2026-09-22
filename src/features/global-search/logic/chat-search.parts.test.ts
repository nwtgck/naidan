import { describe, expect, it } from 'vitest';
import { searchChatTree, searchLinearBranch } from './chat-search';
import { toChatId, toMessageId, toToolCallId } from '@/01-models/ids';
import type { AssistantMessageNode, MessageNode } from '@/01-models/types';
import { MemoryStorageProvider } from '@/00-storage/service/memory-storage';
import { createGlobalSearchWorker } from '@/features/global-search/worker/impl';

function assistant({ parts }: { parts: AssistantMessageNode['parts'] }): AssistantMessageNode {
  return {
    id: toMessageId({ raw: 'assistant' }), role: 'assistant', createdAt: 23,
    modelId: undefined, lmParameters: undefined, interruption: { type: 'cancelled' },
    parts, replies: { items: [] },
  };
}
function find({ messages, query }: { messages: MessageNode[]; query: string }) {
  return searchChatTree({ root: { items: messages }, query, chatId: toChatId({ raw: 'chat' }) });
}

describe('parts-backed chat search', () => {
  it('finds each body part and uses node creation time without changing the source', () => {
    const message = assistant({ parts: [
      { type: 'reasoning', text: 'private reasoning word', completeness: 'complete' },
      { type: 'text', text: '  First body. ', completeness: 'complete' },
      { type: 'text', text: 'Second 🙂 body.', completeness: 'partial' },
    ] });
    const before = structuredClone(message);
    const results = find({ messages: [message], query: 'SECOND' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ messageId: message.id, timestamp: 23, excerpt: 'Second 🙂 body.' });
    expect(message).toEqual(before);
  });

  it('keeps AND matching across text parts without inventing words at a part boundary', () => {
    const message = assistant({ parts: [
      { type: 'text', text: 'Alpha', completeness: 'complete' },
      { type: 'text', text: 'Beta', completeness: 'complete' },
    ] });
    expect(find({ messages: [message], query: 'alpha beta' })).toHaveLength(1);
    expect(find({ messages: [message], query: 'alphabeta' })).toHaveLength(0);
    expect(find({ messages: [message], query: 'alpha beta' })[0]?.excerpt).toBe('Alpha');
  });

  it('searches literal think tags as text but does not expand body search to reasoning or calls', () => {
    const message = assistant({ parts: [
      { type: 'reasoning', text: 'reasoning-only', completeness: 'partial' },
      { type: 'text', text: '<think>literal-only</think> body', completeness: 'partial' },
      { type: 'tool_call', toolCall: { id: toToolCallId({ raw: 'call' }), type: 'function', function: { name: 'function-only', arguments: '{"private-argument":true}' } } },
    ] });
    expect(find({ messages: [message], query: '<think>literal-only' })).toHaveLength(1);
    for (const query of ['reasoning-only', 'function-only', 'private-argument']) {
      expect(find({ messages: [message], query })).toHaveLength(0);
    }
  });

  it('keeps role, selected-thread, and deepest-leaf behavior with parts', () => {
    const child = assistant({ parts: [{ type: 'text', text: 'shared', completeness: 'complete' }] });
    const parent: MessageNode = { id: toMessageId({ raw: 'user' }), role: 'user', createdAt: 1,
      modelId: undefined, lmParameters: undefined,
      parts: [{ type: 'text', text: 'shared', completeness: 'complete' }], replies: { items: [child] } };
    const results = searchChatTree({ root: { items: [parent] }, query: 'shared', chatId: toChatId({ raw: 'chat' }),
      activeBranchIds: new Set([parent.id]), roleFilter: 'all' });
    expect(results.map(item => [item.messageId, item.targetLeafId, item.isCurrentThread])).toEqual([
      [parent.id, child.id, true], [child.id, child.id, false],
    ]);
    expect(searchLinearBranch({ branch: [parent, child], query: 'shared', chatId: toChatId({ raw: 'chat' }), roleFilter: 'assistant' }).map(item => item.messageId)).toEqual([child.id]);
  });

  it('returns no body matches from empty text or tool results', () => {
    const empty = assistant({ parts: [{ type: 'text', text: '', completeness: 'complete' }] });
    const tool: MessageNode = { id: toMessageId({ raw: 'tool' }), role: 'tool', createdAt: 2, modelId: undefined, lmParameters: undefined,
      parts: [{ type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'c' }), status: 'success', content: { type: 'text', text: 'result-only' } } }], replies: { items: [] } };
    expect(find({ messages: [empty, tool], query: 'result-only' })).toHaveLength(0);
  });

  it('finds a saved partial body through the actual memory serialization and worker implementation', async () => {
    const storage = new MemoryStorageProvider();
    await storage.init();
    const chatId = toChatId({ raw: 'persisted-search' });
    const message = assistant({ parts: [
      { type: 'reasoning', text: 'not-indexed', completeness: 'complete' },
      { type: 'text', text: '保存された🙂回答', completeness: 'partial' },
    ] });
    await storage.saveChatContent({ id: chatId, content: { currentLeafId: message.id, root: { items: [message] } } });
    const worker = createGlobalSearchWorker();
    await worker.configureStorage('memory', {
      loadChatContentWithoutAttachments({ chatId }) {
        return storage.loadChatContentWithoutAttachments({ id: toChatId({ raw: chatId }) });
      },
    });
    const result = await worker.searchChatContent({ request: {
      storageType: 'memory', chatId: 'persisted-search', searchQuery: '保存 回答', scope: 'all', roleFilter: 'assistant',
    } });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ excerpt: '保存された🙂回答', timestamp: 23 });
    const stored = await storage.loadChatContentWithoutAttachments({ id: chatId });
    expect(stored?.root.items[0]).toMatchObject({ interruption: { type: 'cancelled' }, parts: message.parts });
  });
});
