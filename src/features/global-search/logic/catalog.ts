import { UNTITLED_CHAT_TITLE } from '@/constants';
import { idToRaw } from '@/01-models/ids';
import type { SidebarItem } from '@/01-models/types';
import type {
  FlatSearchResultItem,
  SearchChatGroup,
  SearchChatSource,
  SearchOptions,
  SearchSource,
} from '@/features/global-search/types';

function getKeywords({ searchQuery }: {
  searchQuery: string,
}): string[] {
  return searchQuery.toLowerCase().split(/[\s\u3000]+/).filter(keyword => keyword.length > 0);
}

export function createSearchSource({ sidebarItems }: {
  sidebarItems: readonly SidebarItem[],
}): SearchSource {
  const chatGroups: SearchChatGroup[] = [];
  const chats: SearchChatSource[] = [];

  for (const item of sidebarItems) {
    switch (item.type) {
    case 'chat_group':
      chatGroups.push({
        id: idToRaw({ id: item.chatGroup.id }),
        name: item.chatGroup.name,
        updatedAt: item.chatGroup.updatedAt,
        chatCount: item.chatGroup.items.length,
      });
      for (const chatItem of item.chatGroup.items) {
        switch (chatItem.type) {
        case 'chat':
          chats.push({
            chat: {
              id: idToRaw({ id: chatItem.chat.id }),
              title: chatItem.chat.title,
              updatedAt: chatItem.chat.updatedAt,
              groupId: chatItem.chat.groupId === undefined || chatItem.chat.groupId === null
                ? chatItem.chat.groupId
                : idToRaw({ id: chatItem.chat.groupId }),
            },
            groupName: item.chatGroup.name,
          });
          break;
        default: {
          const _ex: never = chatItem.type;
          throw new Error(`Unhandled chat group item type: ${_ex}`);
        }
        }
      }
      break;
    case 'chat':
      chats.push({
        chat: {
          id: idToRaw({ id: item.chat.id }),
          title: item.chat.title,
          updatedAt: item.chat.updatedAt,
          groupId: item.chat.groupId === undefined || item.chat.groupId === null
            ? item.chat.groupId
            : idToRaw({ id: item.chat.groupId }),
        },
        groupName: undefined,
      });
      break;
    default: {
      const _ex: never = item;
      throw new Error(`Unhandled sidebar item type: ${String(_ex)}`);
    }
    }
  }

  return { chatGroups, chats };
}

export function filterSearchChats({ source, options }: {
  source: SearchSource,
  options: SearchOptions,
}): SearchChatSource[] {
  const chatGroupIds = options.chatGroupIds;
  const targetChatId = options.chatId;
  const hasGroupFilter = chatGroupIds !== undefined && chatGroupIds.length > 0;

  if (targetChatId !== undefined) {
    return source.chats.filter(({ chat }) => chat.id === targetChatId);
  }
  if (hasGroupFilter) {
    return source.chats.filter(({ chat }) => chat.groupId !== undefined
      && chat.groupId !== null
      && chatGroupIds.includes(chat.groupId));
  }
  return source.chats;
}

export function searchTitles({ source, searchQuery, options }: {
  source: SearchSource,
  searchQuery: string,
  options: SearchOptions,
}): FlatSearchResultItem[] {
  const keywords = getKeywords({ searchQuery });
  const chatGroupIds = options.chatGroupIds;
  const targetChatId = options.chatId;
  const hasGroupFilter = chatGroupIds !== undefined && chatGroupIds.length > 0;

  const filteredChatGroups = targetChatId !== undefined
    ? []
    : hasGroupFilter
      ? source.chatGroups.filter(chatGroup => chatGroupIds.includes(chatGroup.id))
      : source.chatGroups;
  const filteredChats = filterSearchChats({ source, options });
  const flatResults: FlatSearchResultItem[] = [];

  for (const chatGroup of filteredChatGroups) {
    const lowerName = chatGroup.name.toLowerCase();
    if (keywords.every(keyword => lowerName.includes(keyword))) {
      flatResults.push({
        type: 'chat_group',
        item: {
          type: 'chat_group',
          groupId: chatGroup.id,
          name: chatGroup.name,
          updatedAt: chatGroup.updatedAt,
          chatCount: chatGroup.chatCount,
          matchType: 'title',
        },
      });
    }
  }

  for (const { chat, groupName } of filteredChats) {
    const title = chat.title || UNTITLED_CHAT_TITLE;
    const lowerTitle = title.toLowerCase();
    if (keywords.every(keyword => lowerTitle.includes(keyword))) {
      flatResults.push({
        type: 'chat',
        item: {
          type: 'chat',
          chatId: chat.id,
          title,
          groupId: chat.groupId,
          groupName,
          updatedAt: chat.updatedAt,
          matchType: 'title',
          titleMatch: true,
          contentMatches: [],
        },
      });
    }
  }

  return flatResults;
}
