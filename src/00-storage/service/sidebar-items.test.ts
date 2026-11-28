import { describe, it, expect } from 'vitest';
import { toChatGroupId, toChatId } from '@/01-models/ids';
import type { ChatGroup, ChatMeta, Hierarchy } from '@/01-models/types';
import { buildSidebarItemsFromHierarchy } from './sidebar-items';

describe('Sidebar assembly', () => {
  it('should filter out orphan chat entries from hierarchy', () => {
    const hierarchy: Hierarchy = {
      items: [
        { type: 'chat', id: toChatId({ raw: 'exists' }) },
        { type: 'chat', id: toChatId({ raw: 'orphan' }) },
      ],
    };
    const metas: ChatMeta[] = [
      { id: toChatId({ raw: 'exists' }), title: 'Exists', updatedAt: 100, createdAt: 100, debugEnabled: false },
    ];
    const groups: ChatGroup[] = [];

    const items = buildSidebarItemsFromHierarchy({ hierarchy, chatMetas: metas, chatGroups: groups });
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('chat:exists');
  });

  it('should filter out orphan groups from hierarchy', () => {
    const hierarchy: Hierarchy = {
      items: [
        { type: 'chat_group', id: toChatGroupId({ raw: 'orphan-group' }), chat_ids: [] },
      ],
    };
    const items = buildSidebarItemsFromHierarchy({ hierarchy, chatMetas: [], chatGroups: [] });
    expect(items).toHaveLength(0);
  });
});
