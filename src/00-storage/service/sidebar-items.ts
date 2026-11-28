import { idToRaw } from '@/01-models/ids';
import type { ChatGroup, ChatMeta, ChatSidebarItem, ChatSummary, Hierarchy, HierarchyNode, SidebarItem } from '@/01-models/types';
import { exactObject } from '@/utils/exact-object';

const chatMetaToSummary = ({ domain }: { domain: ChatMeta }): ChatSummary => {
  const {
    id,
    title,
    groupId,
    currentLeafId: _currentLeafId,
    createdAt: _createdAt,
    updatedAt,
    debugEnabled: _debugEnabled,
    endpoint: _endpoint,
    modelId: _modelId,
    titleGeneration: _titleGeneration,
    originChatId: _originChatId,
    originMessageId: _originMessageId,
    systemPrompt: _systemPrompt,
    lmParameters: _lmParameters,
    mounts: _mounts,
    toolConfigs: _toolConfigs,
    ...unhandled
  } = domain;

  unhandled satisfies Record<PropertyKey, never>;

  return exactObject<ChatSummary>()({
    id,
    title,
    updatedAt,
    groupId,
  });
};

export function buildChatGroup({ configuration, hierarchy, chatMetas }: {
  configuration: Omit<ChatGroup, 'items'>, hierarchy: Hierarchy, chatMetas: ChatMeta[],
}): ChatGroup {
  const group = hierarchy.items.find((item): item is Extract<HierarchyNode, { type: 'chat_group' }> => item.type === 'chat_group' && item.id === configuration.id);
  const items: ChatSidebarItem[] = (group?.chat_ids ?? []).map(id => {
    const meta = chatMetas.find(candidate => candidate.id === id);
    return {
      id: `chat:${idToRaw({ id })}`,
      type: 'chat',
      chat: {
        id,
        title: meta?.title || null,
        updatedAt: meta?.updatedAt || 0,
        groupId: configuration.id,
      },
    };
  });
  return { ...configuration, items };
}

export const buildSidebarItemsFromHierarchy = (
  { hierarchy, chatMetas, chatGroups }: { hierarchy: Hierarchy, chatMetas: ChatMeta[], chatGroups: Omit<ChatGroup, 'items'>[] },
): SidebarItem[] => {
  const metaMap = new Map(chatMetas.map(m => [m.id, m]));
  const groupMap = new Map(chatGroups.map(g => [g.id, g]));

  const assembleNode = ({ node }: { node: HierarchyNode }): SidebarItem | null => {
    switch (node.type) {
    case 'chat': {
      const meta = metaMap.get(node.id);
      if (!meta) {
        return null;
      }
      return {
        id: `chat:${idToRaw({ id: node.id })}`,
        type: 'chat',
        chat: { ...chatMetaToSummary({ domain: meta }), groupId: null },
      };
    }
    case 'chat_group': {
      const groupMeta = groupMap.get(node.id);
      if (!groupMeta) {
        return null;
      }

      const nestedItems: ChatSidebarItem[] = node.chat_ids
        .map(cid => {
          const m = metaMap.get(cid);
          if (!m) {
            return null;
          }
          return {
            id: `chat:${idToRaw({ id: cid })}`,
            type: 'chat' as const,
            chat: { ...chatMetaToSummary({ domain: m }), groupId: groupMeta.id },
          } as ChatSidebarItem;
        })
        .filter((i): i is ChatSidebarItem => i !== null);

      return {
        id: `chat_group:${idToRaw({ id: node.id })}`,
        type: 'chat_group',
        chatGroup: { ...groupMeta, items: nestedItems },
      };
    }
    default: {
      const _ex: never = node;
      throw new Error(`Unhandled hierarchy node type: ${_ex}`);
    }
    }
  };

  return hierarchy.items
    .map((node) => assembleNode({ node }))
    .filter((i): i is SidebarItem => i !== null);
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
