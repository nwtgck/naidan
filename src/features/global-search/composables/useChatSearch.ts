import { ref, shallowRef, type Ref } from 'vue';
import type { SidebarItem, StorageType } from '@/01-models/types';
import { storageService } from '@/00-storage/service';
import { createGlobalSearchWorkerClient } from '@/features/global-search/worker/client';
import { createSearchSource, filterSearchChats, searchTitles } from '@/features/global-search/logic/catalog';
import { createSearchResultStore } from '@/features/global-search/logic/result-store';
import type {
  ContentMatch,
  FlatSearchResultItem,
  SearchOptions,
  SearchRoleFilter,
  SearchResultItem,
  SearchScope,
} from '@/features/global-search/types';

export type { ContentMatch, FlatSearchResultItem, SearchResultItem, SearchRoleFilter, SearchScope };

export function useChatSearch({ sidebarItems }: {
  sidebarItems: Readonly<Ref<SidebarItem[]>>,
}) {
  const query = ref('');
  const isSearching = ref(false);
  const isScanningContent = ref(false);
  const results = shallowRef<FlatSearchResultItem[]>([]);
  let lastSearchKey: string | undefined;
  let lastSearchRequest: { searchQuery: string, options: SearchOptions } | undefined;
  let searchActive = false;
  let activeRunId = 0;
  type SearchClient = Awaited<ReturnType<typeof createGlobalSearchWorkerClient>>;
  let searchClient: { storageType: StorageType, client: SearchClient } | undefined;
  let searchClientPromise: {
    storageType: StorageType,
    promise: Promise<SearchClient>,
  } | undefined;

  function createSearchKey({ trimmedQuery, options, storageType }: {
    trimmedQuery: string,
    options: SearchOptions,
    storageType: StorageType | undefined,
  }): string {
    return JSON.stringify({
      trimmedQuery,
      scope: options.scope,
      chatId: options.chatId,
      chatGroupIds: options.chatGroupIds === undefined
        ? undefined
        : [...options.chatGroupIds].sort(),
      roleFilter: options.roleFilter ?? 'all',
      storageType,
    });
  }

  async function getSearchClient({ storageType }: {
    storageType: StorageType,
  }): Promise<SearchClient> {
    if (searchClient !== undefined && searchClient.storageType === storageType) {
      return searchClient.client;
    }
    if (searchClient !== undefined || (
      searchClientPromise !== undefined
      && searchClientPromise.storageType !== storageType
    )) {
      disposeSearchClient();
    }
    if (searchClientPromise === undefined) {
      searchClientPromise = {
        storageType,
        promise: createGlobalSearchWorkerClient({ storageType }),
      };
    }

    const pending = searchClientPromise;
    try {
      const client = await pending.promise;
      if (searchClientPromise === pending) {
        searchClient = { storageType, client };
      }
      return client;
    } finally {
      if (searchClientPromise === pending) {
        searchClientPromise = undefined;
      }
    }
  }

  function disposeSearchClient(): void {
    const active = searchClient;
    const pending = searchClientPromise;
    searchClient = undefined;
    searchClientPromise = undefined;

    if (active !== undefined) {
      void active.client.dispose().catch(error => {
        console.error('Failed to dispose Global Search worker client', error);
      });
    }

    if (pending !== undefined) {
      void pending.promise.then(async pendingClient => {
        await pendingClient.dispose();
      }).catch(error => {
        console.error('Failed to dispose pending Global Search worker client', error);
      });
    }
  }

  const search = async ({ searchQuery, options }: {
    searchQuery: string,
    options: SearchOptions,
  }) => {
    searchActive = true;
    lastSearchRequest = {
      searchQuery,
      options: {
        ...options,
        chatGroupIds: options.chatGroupIds === undefined
          ? undefined
          : [...options.chatGroupIds],
      },
    };
    query.value = searchQuery;
    const trimmedQuery = searchQuery.trim();
    const scope = options.scope;
    const roleFilter: SearchRoleFilter = options.roleFilter ?? 'all';
    const source = createSearchSource({ sidebarItems: sidebarItems.value });
    const storageType = (() => {
      switch (scope) {
      case 'title_only':
        return undefined;
      case 'all':
      case 'current_thread':
        return storageService.getCurrentType();
      default: {
        const _ex: never = scope;
        throw new Error(`Unhandled search scope: ${_ex}`);
      }
      }
    })();
    const searchKey = createSearchKey({ trimmedQuery, options, storageType });

    if (!trimmedQuery && scope !== 'title_only') {
      activeRunId++;
      results.value = [];
      isSearching.value = false;
      isScanningContent.value = false;
      lastSearchKey = undefined;
      disposeSearchClient();
      return;
    }

    if (searchKey === lastSearchKey) return;
    lastSearchKey = searchKey;

    const runId = ++activeRunId;
    if (isScanningContent.value) {
      disposeSearchClient();
    }
    isSearching.value = true;
    isScanningContent.value = false;

    try {
      const keywords = trimmedQuery.toLowerCase().split(/[\s\u3000]+/).filter(keyword => keyword.length > 0);
      if (keywords.length === 0 && scope !== 'title_only') {
        results.value = [];
        return;
      }

      const titleResults = searchTitles({
        source,
        searchQuery: trimmedQuery,
        options: {
          ...options,
          roleFilter,
        },
      });
      const resultStore = createSearchResultStore({ titleResults });
      let pendingResultsFrame: number | undefined;

      const publishResults = () => {
        if (pendingResultsFrame !== undefined) {
          cancelAnimationFrame(pendingResultsFrame);
          pendingResultsFrame = undefined;
        }
        if (runId === activeRunId) {
          results.value = resultStore.toFlatResults();
        }
      };

      const scheduleResultsPublish = () => {
        if (pendingResultsFrame !== undefined) return;
        pendingResultsFrame = requestAnimationFrame(() => {
          pendingResultsFrame = undefined;
          if (runId === activeRunId) {
            results.value = resultStore.toFlatResults();
          }
        });
      };

      if (runId !== activeRunId) return;
      publishResults();

      switch (scope) {
      case 'title_only':
        return;
      case 'all':
      case 'current_thread':
        break;
      default: {
        const _ex: never = scope;
        throw new Error(`Unhandled scope: ${_ex}`);
      }
      }

      isScanningContent.value = true;
      if (storageType === undefined) {
        throw new Error('Global Search content scan requires an initialized storage type');
      }
      const filteredChats = filterSearchChats({ source, options });
      if (filteredChats.length === 0) return;

      const client = await getSearchClient({ storageType });
      if (runId !== activeRunId) return;

      for (const sourceChat of filteredChats) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (runId !== activeRunId) return;

        const { chat } = sourceChat;
        try {
          const response = await client.searchChatContent({
            request: {
              searchQuery: trimmedQuery,
              scope,
              roleFilter,
              chatId: chat.id,
            },
          });
          if (runId !== activeRunId) return;

          const matches: ContentMatch[] = response.matches;
          if (matches.length === 0) continue;

          resultStore.addContentMatches({
            source: sourceChat,
            matches,
          });
          scheduleResultsPublish();
        } catch (error) {
          console.warn(`Failed to search content for chat ${chat.id}`, error);
          lastSearchKey = undefined;
          disposeSearchClient();
          break;
        }
      }

      publishResults();
    } catch (error) {
      if (runId === activeRunId) {
        console.error('Failed to run Global Search', error);
      }
    } finally {
      if (runId === activeRunId) {
        isSearching.value = false;
        isScanningContent.value = false;
      }
    }
  };

  const clearSearch = () => {
    searchActive = false;
    lastSearchRequest = undefined;
    activeRunId++;
    query.value = '';
    results.value = [];
    isSearching.value = false;
    isScanningContent.value = false;
    lastSearchKey = undefined;
    disposeSearchClient();
  };

  const stopSearch = () => {
    searchActive = false;
    activeRunId++;
    isSearching.value = false;
    isScanningContent.value = false;
    lastSearchKey = undefined;
    disposeSearchClient();
  };


  const unsubscribeStorageChanges = storageService.subscribeToChanges({
    listener: ({ event }) => {
      switch (event.type) {
      case 'migration':
        activeRunId++;
        lastSearchKey = undefined;
        isSearching.value = false;
        isScanningContent.value = false;
        disposeSearchClient();

        if (searchActive && lastSearchRequest !== undefined) {
          void search(lastSearchRequest);
        }
        break;
      case 'chat_meta_and_chat_group':
      case 'chat_content':
      case 'chat_content_generation':
      case 'settings':
      case 'binary_objects':
        break;
      default: {
        const _ex: never = event;
        throw new Error(
          `Unhandled storage change event: ${((_ex satisfies never) as { readonly type: string }).type}`,
        );
      }
      }
    },
  });

  const disposeSearch = () => {
    stopSearch();
    unsubscribeStorageChanges();
  };

  return {
    query,
    isSearching,
    isScanningContent,
    results,
    search,
    clearSearch,
    stopSearch,
    disposeSearch,
    TEST_ONLY: {},
  };
}
