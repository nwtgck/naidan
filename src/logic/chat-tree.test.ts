import { describe, it, expect } from 'vitest';
import { createBranchFromMessages, getChatBranchIterator, type HistoryItem } from './chat-tree';
import { toAttachmentId, toBinaryObjectId, toMessageId } from '@/01-models/ids';
import type { ChatContent, MessageNode } from '@/01-models/types';

describe('chat-tree utils', () => {
  describe('getChatBranchIterator', () => {
    it('should resolve a deeply nested current branch without recursion', () => {
      const depth = 10_000;
      const root: MessageNode = {
        id: toMessageId({ raw: 'message-0' }),
        role: 'user',
        content: '0',
        timestamp: 0,
        replies: { items: [] },
      };
      let current: MessageNode = root;

      for (let index = 1; index < depth; index++) {
        const next: MessageNode = {
          id: toMessageId({ raw: `message-${index}` }),
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: String(index),
          timestamp: index,
          replies: { items: [] },
        };
        current.replies.items.push(next);
        current = next;
      }

      const content: ChatContent = {
        root: { items: [root] },
        currentLeafId: current.id,
      };
      const branch = Array.from(getChatBranchIterator({ chat: content }));

      expect(branch).toHaveLength(depth);
      expect(branch[0]?.id).toBe(root.id);
      expect(branch.at(-1)?.id).toBe(current.id);
    });
  });

  describe('createBranchFromMessages', () => {
    it('should create a chain of MessageNodes from a list of HistoryItems', () => {
      const messages: HistoryItem[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!', modelId: 'gpt-4' },
        { role: 'user', content: 'How are you?' },
      ];

      const nodes = createBranchFromMessages({ messages });

      expect(nodes.length).toBe(3);

      // Check first node
      expect(nodes[0]!.role).toBe('user');
      expect(nodes[0]!.content).toBe('Hello');
      expect(nodes[0]!.replies.items.length).toBe(1);
      expect(nodes[0]!.replies.items[0]!.id).toBe(nodes[1]!.id);

      // Check second node
      expect(nodes[1]!.role).toBe('assistant');
      expect(nodes[1]!.content).toBe('Hi there!');
      expect(nodes[1]!.modelId).toBe('gpt-4');
      expect(nodes[1]!.replies.items.length).toBe(1);
      expect(nodes[1]!.replies.items[0]!.id).toBe(nodes[2]!.id);

      // Check third node
      expect(nodes[2]!.role).toBe('user');
      expect(nodes[2]!.content).toBe('How are you?');
      expect(nodes[2]!.replies.items.length).toBe(0);
    });

    it('should return empty array for empty input', () => {
      const nodes = createBranchFromMessages({ messages: [] });
      expect(nodes).toEqual([]);
    });

    it('should preserve thinking content for assistant', () => {
      const messages: HistoryItem[] = [
        {
          role: 'assistant',
          content: 'I thought about it.',
          thinking: 'Inner thoughts',
        },
      ];

      const nodes = createBranchFromMessages({ messages });
      expect(nodes[0]!.thinking).toBe('Inner thoughts');
    });

    it('should preserve attachments for user', () => {
      const messages: HistoryItem[] = [
        {
          role: 'user',
          content: 'Here is an image.',
          attachments: [{ id: toAttachmentId({ raw: '1' }), binaryObjectId: toBinaryObjectId({ raw: '1' }), status: 'persisted', originalName: 'n.png', mimeType: 'image/png', size: 10, uploadedAt: 0 }],
        },
      ];

      const nodes = createBranchFromMessages({ messages });
      expect(nodes[0]!.attachments?.[0]!.id).toBe('1');
    });
  });
});
