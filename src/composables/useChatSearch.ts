import { ref, shallowRef } from 'vue';
import { storageService } from '../services/storage';
import { searchChatTree, searchLinearBranch, type ContentMatch } from '../utils/chat-search';
import { getChatBranch } from '../utils/chat-tree';
import { UNTITLED_CHAT_TITLE } from '../models/constants';

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
      matchType: 'title';
    };

export type SearchScope = 'all' | 'title_only' | 'current_thread';

export function useChatSearch() {
  const query = ref('');
  const isSearching = ref(false);
  const isScanningContent = ref(false); // New flag for heavy content scanning
  const results = shallowRef<SearchResultItem[]>([]);
  let lastSearchedTrimmedQuery = '';

  const sortResults = (items: SearchResultItem[]) => {
    return items.sort((a, b) => {
      // Priority 1: Groups first
      if (a.type !== b.type) {
        const typeA = a.type;
        switch (typeA) {
        case 'chat_group':
          return -1;
        case 'chat':
          return 1;
        default: {
          const _ex: never = typeA;
          throw new Error(`Unhandled type: ${_ex}`);
        }
        }
      }
      // Priority 2: Newest first
      return b.updatedAt - a.updatedAt;
    });
  };

  /**
   * Performs the search.
   * Prioritizes title matches, then performs content search.
   * Uses time-slicing to avoid blocking the main thread.
   */
  const search = async ({ searchQuery, options = { scope: 'all' } }: { searchQuery: string, options?: { scope: SearchScope, chatGroupIds?: string[], chatId?: string } }) => {
    query.value = searchQuery;
    const trimmedQuery = searchQuery.trim();

    if (!trimmedQuery) {
      results.value = [];
      isSearching.value = false;
      isScanningContent.value = false;
      lastSearchedTrimmedQuery = '';
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
      if (keywords.length === 0) {
        results.value = [];
        isSearching.value = false;
        return;
      }

      const allChatsRaw = await storageService.listChats();
      const allGroups = await storageService.listChatGroups();
      const groupMap = new Map(allGroups.map(g => [g.id, g.name]));

      const chatGroupIds = options.chatGroupIds;
      const targetChatId = options.chatId;

      let allChats = allChatsRaw;
      if (targetChatId) {
        allChats = allChatsRaw.filter(c => c.id === targetChatId);
      } else if (chatGroupIds && chatGroupIds.length > 0) {
        allChats = allChatsRaw.filter(c => c.groupId && chatGroupIds.includes(c.groupId));
      }

      const resultMap = new Map<string, SearchResultItem>();

      // 1. Title Search (Fast - can be done in one go)

      // Search Groups
      if (!targetChatId) { // If filtering by specific chat, groups are irrelevant
        for (const group of allGroups) {
          const lowerName = group.name.toLowerCase();
          const allMatch = keywords.every(k => lowerName.includes(k));
          if (allMatch) {
            resultMap.set(`group:${group.id}`, {
              type: 'chat_group',
              groupId: group.id,
              name: group.name,
              updatedAt: group.updatedAt,
              matchType: 'title',
            });
          }
        }
      }

      // Search Chat Titles
      for (const chat of allChats) {
        const title = chat.title || UNTITLED_CHAT_TITLE;
        const lowerTitle = title.toLowerCase();

        // Match if ALL keywords are found in the chat title
        const allMatch = keywords.every(k => lowerTitle.includes(k));

        if (allMatch) {
          resultMap.set(`chat:${chat.id}`, {
            type: 'chat',
            chatId: chat.id,
            title: title,
            groupName: chat.groupId ? groupMap.get(chat.groupId) : undefined,
            updatedAt: chat.updatedAt,
            matchType: 'title',
            titleMatch: true,
            contentMatches: [],
          });
        }
      }

      // Update UI with initial title results
      results.value = sortResults(Array.from(resultMap.values()));

      // If scope is title_only, we stop here.
      const scope = options.scope;
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

      // 2. Content Search (Slower - Time Sliced)
      isScanningContent.value = true;
      let processedCount = 0;
      const CHUNK_SIZE = 1; // Process 1 chat at a time to be safe, or 5 if they are small.

      for (const chat of allChats) {
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
          // Load full content
          // TODO: If storageService.loadChatContent becomes the bottleneck,
          // we might need to optimize it or accept the cost.
          const content = await storageService.loadChatContent(chat.id);
          if (content) {
            let matches: ContentMatch[] = [];

            const scope = options.scope;
            switch (scope) {
            case 'current_thread': {
              // Reconstruct the Chat object structure expected by getChatBranch
              // We cast to Chat because getChatBranch only depends on root and currentLeafId,
              // but requires the full type.
              const fullChat = { ...chat, ...content } as unknown as import('../models/types').Chat;
              const branch = getChatBranch(fullChat);

              matches = searchLinearBranch({
                branch,
                query: trimmedQuery,
                chatId: chat.id,
                targetLeafId: content.currentLeafId // Navigation should go to the current leaf
              });
              break;
            }
            case 'all': {
              // 'all' - recursive search
              // Identify active branch for UI indicators
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
            case 'title_only':
              // Should not happen here due to earlier check
              break;
            default: {
              const _ex: never = scope;
              throw new Error(`Unhandled scope: ${_ex}`);
            }
            }

            if (matches.length > 0) {
              const existing = resultMap.get(`chat:${chat.id}`);
              if (existing && existing.type === 'chat') {
                existing.matchType = 'both';
                existing.contentMatches = matches;
              } else {
                const title = chat.title || UNTITLED_CHAT_TITLE;
                const groupName = chat.groupId ? groupMap.get(chat.groupId) : undefined;
                resultMap.set(`chat:${chat.id}`, {
                  type: 'chat',
                  chatId: chat.id,
                  title: title,
                  groupName: groupName,
                  updatedAt: chat.updatedAt,
                  matchType: 'content',
                  titleMatch: false,
                  contentMatches: matches,
                });
              }
              // Progressively update results
              // We create a new array to trigger Vue reactivity
              results.value = sortResults(Array.from(resultMap.values()));
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
    lastSearchedTrimmedQuery = '';
  };

  return {
    query,
    isSearching,
    isScanningContent,
    results,
    search,
    clearSearch,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
