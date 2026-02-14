import { describe, it, expect } from 'vitest';
import { createBranchFromMessages, type HistoryItem } from './chat-tree';

describe('chat-tree utils', () => {
  describe('createBranchFromMessages', () => {
    it('should create a chain of MessageNodes from a list of HistoryItems', () => {
      const messages: HistoryItem[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!', modelId: 'gpt-4' },
        { role: 'user', content: 'How are you?' }
      ];

      const nodes = createBranchFromMessages(messages);

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
      const nodes = createBranchFromMessages([]);
      expect(nodes).toEqual([]);
    });

    it('should preserve attachments and thinking content', () => {
      const messages: HistoryItem[] = [
        {
          role: 'assistant',
          content: 'I thought about it.',
          thinking: 'Inner thoughts',
          attachments: [{ id: '1', binaryObjectId: '1', status: 'persisted', originalName: 'n.png', mimeType: 'image/png', size: 10, uploadedAt: 0 }]
        }
      ];

      const nodes = createBranchFromMessages(messages);
      expect(nodes[0]!.thinking).toBe('Inner thoughts');
      expect(nodes[0]!.attachments?.[0]!.id).toBe('1');
    });
  });
});
