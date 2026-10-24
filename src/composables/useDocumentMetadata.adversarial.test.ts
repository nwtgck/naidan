import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, nextTick, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GlobalSearchModal from '@/features/global-search/components/GlobalSearchModal.vue';
import type { FlatSearchResultItem } from '@/features/global-search/types';
import { toChatId } from '@/01-models/ids';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { APPLICATION_METADATA } from '@/logic/document-metadata';
import { TEST_ONLY as presentationTestOnly } from './useAppPresentation';
import { provideDocumentMetadata } from './useDocumentMetadata';

const searchOpen = ref(true);
const searchResults = ref<FlatSearchResultItem[]>([]);
const openChat = vi.fn(async () => undefined);
vi.mock('@/features/global-search/composables/useGlobalSearch', () => ({
  useGlobalSearch: () => ({
    isSearchOpen: searchOpen,
    chatGroupIds: ref([]),
    chatId: ref(undefined),
    closeSearch: () => {
      searchOpen.value = false;
    },
  }),
}));
vi.mock('@/features/global-search/composables/useChatSearch', () => ({
  useChatSearch: () => ({
    query: ref(''),
    isSearching: ref(false),
    isScanningContent: ref(false),
    results: searchResults,
    search: vi.fn(),
    stopSearch: vi.fn(),
    disposeSearch: vi.fn(),
  }),
}));
vi.mock('@/composables/chat/ui/useChatNavigation', () => ({ useChatNavigation: () => ({ openChat, openChatAtMessage: vi.fn(), openChatGroup: vi.fn() }) }));
vi.mock('@/composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: () => ({
    chatGroups: computed(() => []),
    currentChat: computed(() => null),
    sidebarItems: computed(() => []),
  }),
}));
vi.mock('@/composables/useLayout', () => ({ useLayout: () => ({ setActiveFocusArea: vi.fn(), activeFocusArea: ref('chat') }) }));
vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    globalSearchScope: ref('title_only'),
    globalSearchRoleFilter: ref('all'),
    searchPreviewMode: ref('disabled'),
    searchContextSize: ref(2),
    setGlobalSearchScope: vi.fn(),
    setGlobalSearchRoleFilter: vi.fn(),
    setSearchPreviewMode: vi.fn(),
    setSearchContextSize: vi.fn(),
  }),
}));
vi.mock('@/features/global-search/components/SearchPreview.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/features/global-search/components/ChatGroupSearchPreview.vue', () => ({ default: { template: '<div />' } }));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  document.head.innerHTML = '';
  searchOpen.value = true;
  searchResults.value = [{ type: 'chat', item: { type: 'chat', chatId: 'automatic', title: 'New chat', groupId: undefined, groupName: undefined, updatedAt: 1, matchType: 'title', titleMatch: true, contentMatches: [] } }];
  openChat.mockClear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.scrollTo = vi.fn();
});

describe('explicit navigation after the home introduction', () => {
  it('ends the introduction when the settings button opens its query-based screen', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: {} }, { path: '/chat/:id', component: {} }] });
    await router.push('/');
    const wrapper = mount(defineComponent({
      setup() {
        const introduction = presentationTestOnly.createHomeIntroduction({ router });
        provideDocumentMetadata({ router, document, ...introduction });
        return () => h('div');
      },
    }), { global: { plugins: [router] } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await router.push('/chat/automatic');
    await nextTick();
    expect(document.title).toBe(APPLICATION_METADATA.title);
    // This is the exact router operation used by Sidebar's settings button.
    await router.push({ query: { settings: 'connection' } });
    await flushPromises();
    expect(document.title).toBe(APPLICATION_METADATA.title);
  });

  it('ends the introduction when Global Search explicitly selects the current automatic chat', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: {} }, { path: '/chat/:id', component: {} }] });
    await router.push('/');
    const wrapper = mount(defineComponent({
      setup() {
        const introduction = presentationTestOnly.createHomeIntroduction({ router });
        provideDocumentMetadata({ router, document, ...introduction });
        return () => h(GlobalSearchModal);
      },
    }), { global: { plugins: [router] } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await router.push('/chat/automatic');
    await flushPromises();
    expect(document.title).toBe(APPLICATION_METADATA.title);
    await wrapper.get('[data-testid="search-input"]').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(openChat).toHaveBeenCalledWith({ chatId: toChatId({ raw: 'automatic' }) });
    expect(searchOpen.value).toBe(false);
    expect(router.currentRoute.value.path).toBe('/chat/automatic');
    expect(document.title).toBe(APPLICATION_METADATA.title);
  });
});
