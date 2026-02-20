import { ref, shallowRef } from 'vue';
import { storageService } from '../services/storage';
import { searchChatTree, searchLinearBranch, type ContentMatch } from '../utils/chat-search';
import { getChatBranch } from '../utils/chat-tree';
import { UNTITLED_CHAT_TITLE } from '../models/constants';
import type { SidebarItem, ChatSummary, ChatGroup } from '../models/types';

export type { ContentMatch };

export type SearchResultItem =
  | {
      type: 'chat';
      chatId: string;
      title: string | null;
      groupId?: string | null;
      groupName?: string;
      updatedAt: number;
      matchType: 'title' | 'content' | 'both';
      titleMatch?: boolean;
      contentMatches: ContentMatch[];
    }
  | {
      type: 'chat_group';
      groupId: string;
      name: string;
      updatedAt: number;
      chatCount: number;
      matchType: 'title';
    };

export type FlatSearchResultItem =
  | { type: 'chat'; item: Extract<SearchResultItem, { type: 'chat' }> }
  | { type: 'chat_group'; item: Extract<SearchResultItem, { type: 'chat_group' }> }
  | { type: 'message'; item: ContentMatch; parentChat: Extract<SearchResultItem, { type: 'chat' }> };

export type SearchScope = 'all' | 'title_only' | 'current_thread';

export function useChatSearch() {
  const query = ref('');
  const isSearching = ref(false);
  const isScanningContent = ref(false); // New flag for heavy content scanning
  const results = shallowRef<FlatSearchResultItem[]>([]);
  let lastSearchedTrimmedQuery: string | null = null;

  // Cache for the search source data, valid for the duration of the search session
  let searchSourceCache: {
    chatGroups: ChatGroup[];
    chats: { chat: ChatSummary; groupName?: string }[];
  } | null = null;

  /**
   * Performs the search.
   * Prioritizes title matches, then performs content search.
   * Uses time-slicing to avoid blocking the main thread.
   */
  const search = async ({ searchQuery, options = { scope: 'all' } }: { searchQuery: string, options?: { scope: SearchScope, chatGroupIds?: string[], chatId?: string } }) => {
    query.value = searchQuery;
    const trimmedQuery = searchQuery.trim();
    const scope = options.scope;

    if (!trimmedQuery && scope !== 'title_only') {
      results.value = [];
      isSearching.value = false;
      isScanningContent.value = false;
      lastSearchedTrimmedQuery = null;
      return;
    }

    // Skip if query hasn't changed after trimming
    if (trimmedQuery === lastSearchedTrimmedQuery) {
      return;
    }
    lastSearchedTrimmedQuery = trimmedQuery;

    isSearching.value = true;
    isScanningContent.value = false;

    // NOTE: We do NOT clear results.value immediately here.
    // This prevents the UI from flickering to an empty state while searching.
    // The results will be updated as soon as title search or content matches are found.

    try {
      const keywords = trimmedQuery.toLowerCase().split(/[\s\u3000]+/).filter(k => k.length > 0);
      if (keywords.length === 0 && scope !== 'title_only') {
        results.value = [];
        isSearching.value = false;
        return;
      }

      // Fetch and cache sidebar structure if not already cached
      if (!searchSourceCache) {
        const sidebar = await storageService.getSidebarStructure();
        const chatGroups: ChatGroup[] = [];
        const chats: { chat: ChatSummary; groupName?: string }[] = [];

        const flattenSidebar = (items: SidebarItem[]) => {
          for (const item of items) {
            const type = item.type;
            switch (type) {
            case 'chat_group': {
              const chatGroup = item.chatGroup;
              chatGroups.push(chatGroup);
              for (const chatItem of chatGroup.items) {
                const cType = chatItem.type;
                switch (cType) {
                case 'chat':
                  chats.push({ chat: chatItem.chat, groupName: chatGroup.name });
                  break;
                case 'chat_group':
                  break; // Not supported
                default: {
                  const _ex: never = cType;
                  throw new Error(`Unhandled sidebar item type: ${_ex}`);
                }
                }
              }
              break;
            }
            case 'chat':
              chats.push({ chat: item.chat });
              break;
            default: {
              const _ex: never = type;
              throw new Error(`Unhandled sidebar item type: ${_ex}`);
            }
            }
          }
        };
        flattenSidebar(sidebar);
        searchSourceCache = { chatGroups, chats };
      }

      const { chatGroups: allChatGroups, chats: allChatsSource } = searchSourceCache;

      // Filter by options (Groups/ChatId)
      const chatGroupIds = options.chatGroupIds;
      const targetChatId = options.chatId;
      const hasGroupFilter = !!(chatGroupIds && chatGroupIds.length > 0);

      const filteredChatGroups = targetChatId
        ? []
        : (hasGroupFilter ? allChatGroups.filter(cg => chatGroupIds!.includes(cg.id)) : allChatGroups);

      const filteredChats = targetChatId
        ? allChatsSource.filter(({ chat }) => chat.id === targetChatId)
        : (hasGroupFilter ? allChatsSource.filter(({ chat }) => chat.groupId && chatGroupIds!.includes(chat.groupId)) : allChatsSource);

      const flatResults: FlatSearchResultItem[] = [];
      const chatHeaderMap = new Map<string, Extract<SearchResultItem, { type: 'chat' }>>();

      // 1. Search Group Titles
      for (const chatGroup of filteredChatGroups) {
        const lowerName = chatGroup.name.toLowerCase();
        if (keywords.every(k => lowerName.includes(k))) {
          const item: SearchResultItem = {
            type: 'chat_group',
            groupId: chatGroup.id,
            name: chatGroup.name,
            updatedAt: chatGroup.updatedAt,
            chatCount: chatGroup.items.length,
            matchType: 'title',
          };
          flatResults.push({ type: 'chat_group', item });
        }
      }

      // 2. Search Chat Titles
      for (const { chat, groupName } of filteredChats) {
        const title = chat.title || UNTITLED_CHAT_TITLE;
        const lowerTitle = title.toLowerCase();
        if (keywords.every(k => lowerTitle.includes(k))) {
          const item: Extract<SearchResultItem, { type: 'chat' }> = {
            type: 'chat',
            chatId: chat.id,
            title: title,
            groupName,
            updatedAt: chat.updatedAt,
            matchType: 'title',
            titleMatch: true,
            contentMatches: [],
          };
          chatHeaderMap.set(chat.id, item);
          flatResults.push({ type: 'chat', item });
        }
      }

      // Update UI with initial title results
      results.value = [...flatResults];

      // If scope is title_only, we stop here.
      switch (scope) {
      case 'title_only':
        isSearching.value = false;
        return;
      case 'all':
      case 'current_thread':
        break;
      default: {
        const _ex: never = scope;
        throw new Error(`Unhandled scope: ${_ex}`);
      }
      }

      // 3. Content Search (Progressive)
      isScanningContent.value = true;
      let processedCount = 0;
      const CHUNK_SIZE = 1;

      for (const { chat, groupName } of filteredChats) {
        // Yield to event loop to keep UI responsive
        if (processedCount % CHUNK_SIZE === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        processedCount++;

        // ABORT CHECK: If query changed while we were waiting, stop.
        if (query.value !== trimmedQuery) {
          return;
        }

        try {
          const content = await storageService.loadChatContent(chat.id);
          if (content) {
            let matches: ContentMatch[] = [];

            switch (scope) {
            case 'current_thread': {
              const fullChat = { ...chat, ...content } as unknown as import('../models/types').Chat;
              const branch = getChatBranch(fullChat);
              matches = searchLinearBranch({
                branch,
                query: trimmedQuery,
                chatId: chat.id,
                targetLeafId: content.currentLeafId
              });
              break;
            }
            case 'all': {
              const fullChat = { ...chat, ...content } as unknown as import('../models/types').Chat;
              const activeNodes = getChatBranch(fullChat);
              const activeBranchIds = new Set(activeNodes.map(n => n.id));
              matches = searchChatTree({
                root: content.root,
                query: trimmedQuery,
                chatId: chat.id,
                activeBranchIds
              });
              break;
            }
            default: {
              const _ex: never = scope;
              throw new Error(`Unhandled scope: ${_ex}`);
            }
            }

            if (matches.length > 0) {
              const header = chatHeaderMap.get(chat.id);
              if (header && header.type === 'chat') {
                header.matchType = 'both';
                header.contentMatches = matches;

                // Insert matches after the header to keep them grouped
                const headerIndex = flatResults.findIndex(r => r.type === 'chat' && r.item === header);
                if (headerIndex !== -1) {
                  const messageEntries: FlatSearchResultItem[] = matches.map(m => ({ type: 'message', item: m, parentChat: header }));
                  flatResults.splice(headerIndex + 1, 0, ...messageEntries);
                }
              } else {
                // Header wasn't pushed yet (title didn't match), so push it now
                const newHeader: Extract<SearchResultItem, { type: 'chat' }> = {
                  type: 'chat',
                  chatId: chat.id,
                  title: chat.title || UNTITLED_CHAT_TITLE,
                  groupName,
                  updatedAt: chat.updatedAt,
                  matchType: 'content',
                  titleMatch: false,
                  contentMatches: matches,
                };
                chatHeaderMap.set(chat.id, newHeader);
                flatResults.push({ type: 'chat', item: newHeader });
                const messageEntries: FlatSearchResultItem[] = matches.map(m => ({ type: 'message', item: m, parentChat: newHeader }));
                flatResults.push(...messageEntries);
              }
              // Progressively update results
              results.value = [...flatResults];
            }
          }
        } catch (e) {
          console.warn(`Failed to search content for chat ${chat.id}`, e);
        }
      }

    } finally {
      // Only unset loading if we are still on the same query
      if (query.value === trimmedQuery) {
        isSearching.value = false;
        isScanningContent.value = false;
      }
    }
  };

  const clearSearch = () => {
    query.value = '';
    results.value = [];
    isSearching.value = false;
    isScanningContent.value = false;
    lastSearchedTrimmedQuery = null;
    searchSourceCache = null;
  };

  /**
   * Resets searching state and invalidates cache without clearing query/results.
   * Used when closing the modal to ensure fresh data on reopen while preserving UX.
   */
  const stopSearch = () => {
    isSearching.value = false;
    isScanningContent.value = false;
    lastSearchedTrimmedQuery = null;
    searchSourceCache = null;
  };

  return {
    query,
    isSearching,
    isScanningContent,
    results,
    search,
    clearSearch,
    stopSearch,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
