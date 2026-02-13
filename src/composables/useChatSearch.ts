import { ref, shallowRef } from 'vue';
import { storageService } from '../services/storage';
import { searchChatTree, searchLinearBranch, type ContentMatch } from '../utils/chat-search';
import { getChatBranch } from '../utils/chat-tree';

export type { ContentMatch };

export interface SearchResultItem {
  chatId: string;
  title: string | null;
  updatedAt: number;
  matchType: 'title' | 'content' | 'both'; // 'both' if matches found in both title and content
  titleMatch?: boolean;
  contentMatches: ContentMatch[];
}

export type SearchScope = 'all' | 'title_only' | 'current_thread';

export function useChatSearch() {
  const query = ref('');
  const isSearching = ref(false);
  const results = shallowRef<SearchResultItem[]>([]);

  /**
   * Performs the search.
   * Prioritizes title matches, then performs content search.
   * Uses time-slicing to avoid blocking the main thread.
   */
  const search = async ({ searchQuery, options = { scope: 'all' } }: { searchQuery: string, options?: { scope: SearchScope, chatGroupIds?: string[], chatId?: string } }) => {
    const trimmedQuery = searchQuery.trim();
    query.value = trimmedQuery;
    
    if (!trimmedQuery) {
      results.value = [];
      isSearching.value = false;
      return;
    }

    isSearching.value = true;
    // Do not clear results immediately if you want to keep showing old ones while typing, 
    // but here we clear to show we are searching anew.
    results.value = []; 

    try {
      const keywords = trimmedQuery.toLowerCase().split(/[\s\u3000]+/).filter(k => k.length > 0);
      if (keywords.length === 0) {
        results.value = [];
        isSearching.value = false;
        return;
      }

      const allChatsRaw = await storageService.listChats();
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
      // Always perform title search unless we decide to have a "content only" mode later.
      for (const chat of allChats) {
        if (chat.title) {
          const lowerTitle = chat.title.toLowerCase();
          const allMatch = keywords.every(k => lowerTitle.includes(k));
          if (allMatch) {
            resultMap.set(chat.id, {
              chatId: chat.id,
              title: chat.title,
              updatedAt: chat.updatedAt,
              matchType: 'title',
              titleMatch: true,
              contentMatches: [],
            });
          }
        }
      }

      // Update UI with initial title results
      results.value = Array.from(resultMap.values()).sort((a, b) => b.updatedAt - a.updatedAt);

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
              const existing = resultMap.get(chat.id);
              if (existing) {
                existing.matchType = 'both';
                existing.contentMatches = matches;
              } else {
                resultMap.set(chat.id, {
                  chatId: chat.id,
                  title: chat.title,
                  updatedAt: chat.updatedAt,
                  matchType: 'content',
                  titleMatch: false,
                  contentMatches: matches,
                });
              }
              // Progressively update results
              // We create a new array to trigger Vue reactivity
              results.value = Array.from(resultMap.values()).sort((a, b) => b.updatedAt - a.updatedAt);
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
      }
    }
  };

  const clearSearch = () => {
    query.value = '';
    results.value = [];
    isSearching.value = false;
  };

  return {
    query,
    isSearching,
    results,
    search,
    clearSearch,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
