import { describe, it, expect } from 'vitest';
import { chatToDomain, buildSidebarItemsFromHierarchy } from './mappers';
import { v7 as uuidv7 } from 'uuid';
import type { ChatMeta, ChatGroup, Hierarchy } from './types';

describe('Sidebar assembly', () => {
  it('should filter out orphan chat entries from hierarchy', () => {
    const hierarchy: Hierarchy = {
      items: [
        { type: 'chat', id: 'exists' },
        { type: 'chat', id: 'orphan' }
      ]
    };
    const metas: ChatMeta[] = [
      { id: 'exists', title: 'Exists', updatedAt: 100, createdAt: 100, debugEnabled: false }
    ];
    const groups: ChatGroup[] = [];

    const items = buildSidebarItemsFromHierarchy(hierarchy, metas, groups);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('chat:exists');
  });

  it('should filter out orphan groups from hierarchy', () => {
    const hierarchy: Hierarchy = {
      items: [
        { type: 'chat_group', id: 'orphan-group', chat_ids: [] }
      ]
    };
    const items = buildSidebarItemsFromHierarchy(hierarchy, [], []);
    expect(items).toHaveLength(0);
  });
});

describe('Legacy Migration (Flat to Tree)', () => {
  it('should migrate linear messages to a recursive tree structure', () => {
    const legacyId1 = uuidv7();
    const legacyId2 = uuidv7();
    const legacyChat: any = {
      id: uuidv7(),
      title: 'Legacy',
      messages: [
        { id: legacyId1, role: 'user', content: 'Hi', timestamp: 1 },
        { id: legacyId2, role: 'assistant', content: 'Hello', timestamp: 2 },
      ],
      modelId: 'gpt-4',
      createdAt: 1,
      updatedAt: 2,
    };

    const domain = chatToDomain(legacyChat);

    expect(domain.root.items).toHaveLength(1);
    expect(domain.root.items[0]?.id).toBe(legacyId1);
    expect(domain.root.items[0]?.replies.items).toHaveLength(1);
    expect(domain.root.items[0]?.replies.items[0]?.id).toBe(legacyId2);
    expect(domain.root.items[0]?.replies.items[0]?.replies.items).toHaveLength(0);
  });
});
