import { describe, it, expect } from 'vitest';
import { searchChatTree, searchLinearBranch } from './chat-search';
import type { MessageBranch, MessageNode } from '../models/types';

describe('searchChatTree', () => {
  const createNode = (id: string, content: string, replies: MessageNode[] = []): MessageNode => ({
    id,
    role: 'user',
    content,
    replies: { items: replies },
    timestamp: Date.now(),
  });

  it('finds match in root level', () => {
    const root: MessageBranch = {
      items: [
        createNode('1', 'Hello world'),
        createNode('2', 'Another message'),
      ]
    };

    const matches = searchChatTree({ root, query: 'world', chatId: 'chat-1' });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.messageId).toBe('1');
    expect(matches[0]!.targetLeafId).toBe('1');
  });

  it('finds match in nested branch and identifies correct leaf', () => {
    // Structure:
    // 1: "Start" -> 2: "Target content here" -> 3: "End leaf"
    const node3 = createNode('3', 'End leaf');
    const node2 = createNode('2', 'Target content here', [node3]);
    const node1 = createNode('1', 'Start', [node2]);

    const root: MessageBranch = { items: [node1] };

    const matches = searchChatTree({ root, query: 'Target', chatId: 'chat-1' });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.messageId).toBe('2');
    // The target leaf for navigation should be the deepest node in that branch (node3)
    // so that when we open the chat, we see the full conversation including the match.
    expect(matches[0]!.targetLeafId).toBe('3');
  });

  it('finds multiple matches across branches', () => {
    // Structure:
    // 1: "Common"
    //    -> 2a: "Branch A specific"
    //    -> 2b: "Branch B specific"

    const node2a = createNode('2a', 'Branch A specific');
    const node2b = createNode('2b', 'Branch B specific');
    const node1 = createNode('1', 'Common', [node2a, node2b]);

    const root: MessageBranch = { items: [node1] };

    const matches = searchChatTree({ root, query: 'specific', chatId: 'chat-1' });
    expect(matches).toHaveLength(2);
    const ids = matches.map(m => m.messageId).sort();
    expect(ids).toEqual(['2a', '2b']);
  });

  it('is case insensitive', () => {
    const root: MessageBranch = {
      items: [createNode('1', 'HeLLo ThErE')]
    };

    const matches = searchChatTree({ root, query: 'hello', chatId: 'chat-1' });
    expect(matches).toHaveLength(1);
  });
});

describe('searchLinearBranch', () => {
  const createNode = (id: string, content: string): MessageNode => ({
    id,
    role: 'user',
    content,
    replies: { items: [] },
    timestamp: Date.now(),
  });

  it('searches only the provided array', () => {
    const branch = [
      createNode('1', 'Hello world'),
      createNode('2', 'Hidden text in linear path'),
    ];

    const matches = searchLinearBranch({ branch, query: 'Hidden', chatId: 'chat-1', targetLeafId: '99' });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.messageId).toBe('2');
    expect(matches[0]!.targetLeafId).toBe('99');
  });
});
