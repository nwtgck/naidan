import { ref, shallowRef } from 'vue';
import { UNTITLED_CHAT_TITLE } from '@/models/constants';
import { storageService } from '@/services/storage';
import { createGlobalSearchWorkerClient } from '@/services/global-search-worker-client';
import type {
  ContentMatch,
  FlatSearchResultItem,
  SearchChatGroup,
  SearchChatSource,
  SearchResultItem,
  SearchScope,
  SearchSource,
} from '@/services/global-search.types';
import type { SidebarItem } from '@/models/types';

export type { ContentMatch, FlatSearchResultItem, SearchResultItem, SearchScope };

function flattenSidebarForSearch({ sidebarItems }: {
  sidebarItems: SidebarItem[]
}): SearchSource {
  const chatGroups: SearchChatGroup[] = []
  const chats: SearchChatSource[] = []

  const flattenItems = (items: SidebarItem[]) => {
    for (const item of items) {
      switch (item.type) {
      case 'chat_group':
        chatGroups.push({
          id: item.chatGroup.id,
          name: item.chatGroup.name,
          updatedAt: item.chatGroup.updatedAt,
          chatCount: item.chatGroup.items.length,
        })
        for (const chatItem of item.chatGroup.items) {
          switch (chatItem.type) {
          case 'chat':
            chats.push({
              chat: {
                id: chatItem.chat.id,
                title: chatItem.chat.title,
                updatedAt: chatItem.chat.updatedAt,
                groupId: chatItem.chat.groupId,
              },
              groupName: item.chatGroup.name,
            })
            break
          default: {
            const _exhaustiveCheck: never = chatItem.type
            throw new Error(`Unhandled chat group item type: ${_exhaustiveCheck}`)
          }
          }
        }
        break
      case 'chat':
        chats.push({
          chat: {
            id: item.chat.id,
            title: item.chat.title,
            updatedAt: item.chat.updatedAt,
            groupId: item.chat.groupId,
          },
          groupName: undefined,
        })
        break
      default: {
        const _exhaustiveCheck: never = item
        throw new Error(`Unhandled sidebar item type: ${_exhaustiveCheck}`)
      }
      }
    }
  }

  flattenItems(sidebarItems)

  return { chatGroups, chats }
}

export function useChatSearch() {
  const query = ref('');
  const isSearching = ref(false);
  const isScanningContent = ref(false); // New flag for heavy content scanning
  const results = shallowRef<FlatSearchResultItem[]>([]);
  let lastSearchKey: string | null = null;
  let searchSourceCache: SearchSource | null = null;
  let searchClient: Awaited<ReturnType<typeof createGlobalSearchWorkerClient>> | undefined
  let searchSessionId: string | undefined

  function createSearchKey({ trimmedQuery, options }: {
    trimmedQuery: string
    options: { scope: SearchScope, chatGroupIds?: string[], chatId?: string }
  }): string {
    return JSON.stringify({
      trimmedQuery,
      scope: options.scope,
      chatId: options.chatId,
      chatGroupIds: options.chatGroupIds ? [...options.chatGroupIds] : undefined,
    })
  }

  async function disposeSearchClient(_args: { noop?: never }) {
    const client = searchClient
    const sessionId = searchSessionId
    searchClient = undefined
    searchSessionId = undefined
    searchSourceCache = null

    if (!client) {
      return
    }

    try {
      if (sessionId) {
        await client.disposeSession({ request: { sessionId } })
      }
    } finally {
      await client.dispose({})
    }
  }

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
      lastSearchKey = null;
      return;
    }

    const searchKey = createSearchKey({
      trimmedQuery,
      options,
    })

    if (searchKey === lastSearchKey) {
      return;
    }
    lastSearchKey = searchKey;

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

      if (!searchClient) {
        searchClient = await createGlobalSearchWorkerClient({})
      }

      if (!searchSourceCache) {
        if (searchSessionId && searchClient) {
          await searchClient.disposeSession({ request: { sessionId: searchSessionId } })
          searchSessionId = undefined
        }
        const sidebar = await storageService.getSidebarStructure();
        searchSourceCache = flattenSidebarForSearch({ sidebarItems: sidebar });
        const sessionResponse = await searchClient.prepareSession({
          request: {
            source: searchSourceCache,
          },
        })
        searchSessionId = sessionResponse.sessionId
      }

      if (!searchSessionId || !searchClient) {
        throw new Error('Search worker session is not initialized')
      }

      const { chats: allChatsSource } = searchSourceCache;

      // Filter by options (Groups/ChatId)
      const chatGroupIds = options.chatGroupIds;
      const targetChatId = options.chatId;
      const hasGroupFilter = !!(chatGroupIds && chatGroupIds.length > 0);

      const filteredChats = targetChatId
        ? allChatsSource.filter(({ chat }) => chat.id === targetChatId)
        : (hasGroupFilter ? allChatsSource.filter(({ chat }) => chat.groupId && chatGroupIds!.includes(chat.groupId)) : allChatsSource);

      const titlesResponse = await searchClient.searchTitles({
        request: {
          sessionId: searchSessionId,
          searchQuery: trimmedQuery,
          options: {
            scope: options.scope,
            chatGroupIds: options.chatGroupIds ? [...options.chatGroupIds] : undefined,
            chatId: options.chatId,
          },
        },
      })
      const flatResults: FlatSearchResultItem[] = [...titlesResponse.flatResults]
      const chatHeaderMap = new Map<string, Extract<SearchResultItem, { type: 'chat' }>>()
      for (const entry of flatResults) {
        switch (entry.type) {
        case 'chat':
          chatHeaderMap.set(entry.item.chatId, entry.item)
          break
        case 'chat_group':
        case 'message':
          break
        default: {
          const _exhaustiveCheck: never = entry
          throw new Error(`Unhandled search result type: ${_exhaustiveCheck}`)
        }
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
            const response = await searchClient.searchChatContent({
              request: {
                sessionId: searchSessionId,
                searchQuery: trimmedQuery,
                scope,
                chat,
                groupName,
                content,
              },
            })
            const matches: ContentMatch[] = response.matches

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
    lastSearchKey = null;
    void disposeSearchClient({});
  };

  /**
   * Resets searching state and invalidates cache without clearing query/results.
   * Used when closing the modal to ensure fresh data on reopen while preserving UX.
   */
  const stopSearch = () => {
    isSearching.value = false;
    isScanningContent.value = false;
    lastSearchKey = null;
    void disposeSearchClient({});
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
