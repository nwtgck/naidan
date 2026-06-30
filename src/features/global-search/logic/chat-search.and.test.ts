import { describe, it, expect } from 'vitest';
import { searchChatTree, searchLinearBranch } from './chat-search';
import type { MessageBranch, MessageNode } from '@/01-models/types';
import { idToRaw, toMessageId, toChatId } from '@/01-models/ids';

describe('chat-search AND logic', () => {
  const mockRoot: MessageBranch = {
    items: [
      {
        id: toMessageId({ raw: '1' }),
        role: 'user',
        content: 'Hello world, this is a test message with multiple keywords',
        timestamp: Date.now(),
        replies: {
          items: [
            {
              id: toMessageId({ raw: '2' }),
              role: 'assistant',
              content: 'I see your test message about the world',
              timestamp: Date.now(),
              replies: { items: [] },
            } as MessageNode,
          ],
        },
      } as MessageNode,
      {
        id: toMessageId({ raw: '3' }),
        role: 'user',
        content: 'Another unrelated message',
        timestamp: Date.now(),
        replies: { items: [] },
      } as MessageNode,
    ],
  };

  describe('searchChatTree', () => {
    it('should find matches with multiple keywords (AND search)', () => {
      const results = searchChatTree({
        root: mockRoot,
        query: 'test world',
        chatId: toChatId({ raw: 'chat1' }),
      });

      expect(results).toHaveLength(2); // Both message 1 and 2 have both words
      expect(results.some(r => idToRaw({ id: r.messageId }) === '1')).toBe(true);
      expect(results.some(r => idToRaw({ id: r.messageId }) === '2')).toBe(true);
    });

    it('should handle full-width spaces for multi-keyword search', () => {
      const results = searchChatTree({
        root: mockRoot,
        query: 'test　world', // IDEographic space
        chatId: toChatId({ raw: 'chat1' }),
      });

      expect(results).toHaveLength(2);
    });

    it('should not find matches if one keyword is missing', () => {
      const results = searchChatTree({
        root: mockRoot,
        query: 'test missing',
        chatId: toChatId({ raw: 'chat1' }),
      });

      expect(results).toHaveLength(0);
    });

    it('should be case-insensitive', () => {
      const results = searchChatTree({
        root: mockRoot,
        query: 'TEST WORLD',
        chatId: toChatId({ raw: 'chat1' }),
      });

      expect(results).toHaveLength(2);
    });
  });

  describe('searchLinearBranch', () => {
    it('should perform AND search in a linear branch', () => {
      const node1 = mockRoot.items[0]!;
      const node2 = node1.replies.items[0]!;
      const branch: MessageNode[] = [node1, node2];
      const results = searchLinearBranch({
        branch,
        query: 'message world',
        chatId: toChatId({ raw: 'chat1' }),
      });

      expect(results).toHaveLength(2);
    });
  });
});
