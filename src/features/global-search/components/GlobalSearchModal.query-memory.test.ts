import { computed, defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { useGlobalSearch } from '@/features/global-search/composables/useGlobalSearch';
import GlobalSearchModal from './GlobalSearchModal.vue';

const executedQuery = ref('');
vi.mock('../composables/useChatSearch', () => ({
  useChatSearch: () => ({
    query: executedQuery,
    results: ref([]),
    isSearching: ref(false),
    isScanningContent: ref(false),
    search: vi.fn(({ searchQuery }: { searchQuery: string }) => {
      executedQuery.value = searchQuery;
    }),
    stopSearch: vi.fn(),
    disposeSearch: vi.fn(),
  }),
}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/composables/chat/ui/useChatNavigation', () => ({
  useChatNavigation: () => ({ openChat: vi.fn(), openChatAtMessage: vi.fn(), openChatGroup: vi.fn() }),
}));
vi.mock('@/composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: () => ({ chatGroups: computed(() => []), currentChat: computed(() => undefined), sidebarItems: computed(() => []) }),
}));
vi.mock('@/composables/useLayout', () => ({
  useLayout: () => ({ setActiveFocusArea: vi.fn(), activeFocusArea: ref('chat') }),
}));
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

const search = useGlobalSearch();
const Host = defineComponent({
  setup: () => () => search.isSearchOpen.value ? h(GlobalSearchModal) : undefined,
});

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  search.closeSearch();
  search.openSearch({});
  search.query.value = '';
  search.closeSearch();
});

describe('Global Search query memory wiring', () => {
  it('restores the final input after the modal is destroyed and reopened from another caller', async () => {
    const host = mount(Host);
    using _cleanup = {
      [Symbol.dispose]() {
        search.closeSearch();
        host.unmount();
      },
    };
    search.openSearch({});
    await nextTick();
    await host.get('[data-testid="search-input"]').setValue('whole');
    search.closeSearch();
    await nextTick();
    expect(host.find('[data-testid="search-input"]').exists()).toBe(false);
    search.openSearch({ groupIds: ['remembered-group'] });
    await nextTick();
    expect(host.get<HTMLInputElement>('[data-testid="search-input"]').element.value).toBe('');
    await host.get('[data-testid="search-input"]').setValue('  最後の文字  ');
    search.closeSearch();
    await nextTick();
    useGlobalSearch().openSearch({ groupIds: ['remembered-group'] });
    await nextTick();
    expect(host.get<HTMLInputElement>('[data-testid="search-input"]').element.value).toBe('  最後の文字  ');
    search.openSearch({ chatId: 'new-chat' });
    await nextTick();
    expect(host.get<HTMLInputElement>('[data-testid="search-input"]').element.value).toBe('');
    search.openSearch({});
    await nextTick();
    expect(host.get<HTMLInputElement>('[data-testid="search-input"]').element.value).toBe('whole');
  });

  it('does not let an executed query overwrite the current input or its memory', async () => {
    const host = mount(Host);
    using _cleanup = {
      [Symbol.dispose]() {
        search.closeSearch();
        host.unmount();
      },
    };
    search.openSearch({ chatId: 'input-owner' });
    await nextTick();
    await host.get('[data-testid="search-input"]').setValue('latest input');
    executedQuery.value = 'older executed query';
    await nextTick();
    expect(host.get<HTMLInputElement>('[data-testid="search-input"]').element.value).toBe('latest input');
    search.closeSearch();
    await nextTick();
    search.openSearch({ chatId: 'input-owner' });
    await nextTick();
    expect(host.get<HTMLInputElement>('[data-testid="search-input"]').element.value).toBe('latest input');
  });
});
