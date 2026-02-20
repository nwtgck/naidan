import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import GlobalSearchModal from './GlobalSearchModal.vue';
import { ref, nextTick } from 'vue';

// --- Mocks ---

const mockIsSearchOpen = ref(false);
const mockChatGroupIds = ref<string[]>([]);
const mockChatId = ref<string | undefined>(undefined);
const mockCloseSearch = vi.fn();

const mockSetActiveFocusArea = vi.fn();
const mockActiveFocusArea = ref('chat');
vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    setActiveFocusArea: mockSetActiveFocusArea,
    activeFocusArea: mockActiveFocusArea,
  }),
}));

const mockPush = vi.fn();
vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

vi.mock('../composables/useGlobalSearch', () => ({
  useGlobalSearch: () => ({
    isSearchOpen: mockIsSearchOpen,
    chatGroupIds: mockChatGroupIds,
    chatId: mockChatId,
    closeSearch: mockCloseSearch,
  }),
}));

const mockQuery = ref('');
const mockIsSearching = ref(false);
const mockIsScanningContent = ref(false);
const mockResults = ref([]);
const mockSearch = vi.fn();
const mockClearSearch = vi.fn();
const mockStopSearch = vi.fn();

vi.mock('../composables/useChatSearch', () => ({
  useChatSearch: () => ({
    query: mockQuery,
    isSearching: mockIsSearching,
    isScanningContent: mockIsScanningContent,
    results: mockResults,
    search: mockSearch,
    clearSearch: mockClearSearch,
    stopSearch: mockStopSearch,
  }),
}));

const mockOpenChat = vi.fn();
const mockOpenChatGroup = vi.fn();
vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    openChat: mockOpenChat,
    openChatGroup: mockOpenChatGroup,
    chatGroups: ref([{ id: 'g1', name: 'Group 1' }]),
    currentChat: ref(null),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    searchPreviewMode: ref('always'),
    searchContextSize: ref(2),
    setSearchPreviewMode: vi.fn(),
    setSearchContextSize: vi.fn(),
  }),
}));

// Mock Lucide icons
vi.mock('lucide-vue-next', () => ({
  Search: { render: () => null },
  X: { render: () => null },
  Loader2: { render: () => null },
  MessageSquare: { render: () => null },
  CornerDownRight: { render: () => null },
  Clock: { render: () => null },
  GitBranch: { render: () => null },
  Folder: { render: () => null },
  Filter: { render: () => null },
  Check: { render: () => null },
  Eye: { render: () => null },
}));

// Mock scrollIntoView
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// --- Tests ---

describe('GlobalSearchModal Component', () => {
  beforeEach(() => {
    mockIsSearchOpen.value = true;
    mockQuery.value = '';
    mockChatGroupIds.value = [];
    mockChatId.value = undefined;
    mockResults.value = [];
    vi.clearAllMocks();
  });

  it('should render when open', () => {
    const wrapper = mount(GlobalSearchModal);
    expect(wrapper.find('[data-testid="search-input"]').exists()).toBe(true);
  });

  it('should call search on input with debounce', async () => {
    const wrapper = mount(GlobalSearchModal);
    const input = wrapper.get('[data-testid="search-input"]');
    await input.setValue('test');

    // Wait for debounce (300ms + buffer)
    await new Promise(resolve => setTimeout(resolve, 400));

    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
      searchQuery: 'test'
    }));
  });

  it('should toggle group filter when clicking in dropdown', async () => {
    const wrapper = mount(GlobalSearchModal);

    // Open group selector
    await wrapper.get('[data-testid="group-filter-button"]').trigger('click');

    // Find and click the group button in the dropdown
    const groupButton = wrapper.get('[data-testid="group-filter-item-g1"]');
    await groupButton.trigger('click');

    expect(mockChatGroupIds.value).toContain('g1');
  });

  it('should show group filter indicator when groupIds are present', () => {
    mockChatGroupIds.value = ['g1'];
    const wrapper = mount(GlobalSearchModal);
    expect(wrapper.text()).toContain('Group 1');
  });

  it('should show chat filter indicator when chatId is present', () => {
    mockChatId.value = 'c1';
    const wrapper = mount(GlobalSearchModal);
    // targetChatTitle will be 'Filtered Chat' if currentChat is not c1
    expect(wrapper.text()).toContain('Filtered Chat');
  });

  it('should re-trigger search when opening with a filter if query is present', async () => {
    mockQuery.value = 'stale query';
    mockIsSearchOpen.value = false;

    // Simulate opening with a chatId
    mockChatId.value = 'c1';
    mockIsSearchOpen.value = true;

    mount(GlobalSearchModal);

    // Wait for watch(isSearchOpen) nextTick and performSearch
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
      searchQuery: 'stale query',
      options: expect.objectContaining({ chatId: 'c1' })
    }));
  });

  it('should navigate and select results with keyboard', async () => {
    mockQuery.value = 'test';
    mockResults.value = [
      { type: 'chat', item: { chatId: 'chat1', title: 'Chat 1', updatedAt: 1, contentMatches: [], matchType: 'title' } },
      { type: 'chat', item: { chatId: 'chat2', title: 'Chat 2', updatedAt: 2, contentMatches: [], matchType: 'title' } },
    ] as any;

    const wrapper = mount(GlobalSearchModal);
    await nextTick();

    // Initial selection should be index 0
    expect((wrapper.vm as any).selectedIndex).toBe(0);

    // ArrowDown to select index 1
    await wrapper.get('[data-testid="search-input"]').trigger('keydown', { key: 'ArrowDown' });
    expect((wrapper.vm as any).selectedIndex).toBe(1);

    // Enter to select the item
    await wrapper.get('[data-testid="search-input"]').trigger('keydown', { key: 'Enter' });

    expect(mockOpenChat).toHaveBeenCalledWith('chat2');
    expect(mockCloseSearch).toHaveBeenCalled();
  });

  it('should select a result when clicked', async () => {
    mockQuery.value = 'test';
    mockResults.value = [
      { type: 'chat', item: { chatId: 'chat1', title: 'Chat 1', updatedAt: 1, contentMatches: [], matchType: 'title' } },
    ] as any;

    const wrapper = mount(GlobalSearchModal);
    await nextTick();

    await wrapper.get('[data-testid="search-result-item-0"]').trigger('click');

    expect(mockOpenChat).toHaveBeenCalledWith('chat1');
    expect(mockCloseSearch).toHaveBeenCalled();
  });

  it('should select input text when opening with existing query', async () => {
    mockQuery.value = 'existing query';
    mockIsSearchOpen.value = false;

    const selectSpy = vi.spyOn(HTMLInputElement.prototype, 'select');

    mount(GlobalSearchModal);

    mockIsSearchOpen.value = true;
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0)); // wait for nextTick in watch

    expect(selectSpy).toHaveBeenCalled();
    selectSpy.mockRestore();
  });

  it('should navigate to group when a chat_group result is selected', async () => {
    mockQuery.value = 'work';
    mockResults.value = [
      { type: 'chat_group', item: { groupId: 'g1', name: 'Work', updatedAt: 1, chatCount: 5, matchType: 'title' } },
    ] as any;

    const wrapper = mount(GlobalSearchModal);
    await nextTick();

    await wrapper.get('[data-testid="search-result-item-0"]').trigger('click');

    expect(mockOpenChatGroup).toHaveBeenCalledWith('g1');
    expect(mockCloseSearch).toHaveBeenCalled();
  });

  it('should hide SearchPreview while scanning content', async () => {
    mockQuery.value = 'test'; // Ensure query is present to enter the results block
    mockIsScanningContent.value = true;
    mockResults.value = [{ type: 'chat', item: { chatId: 'c1', title: 'C1', updatedAt: 1, contentMatches: [], matchType: 'title' } }] as any;

    const wrapper = mount(GlobalSearchModal);
    await nextTick();

    // The container for SearchPreview should be hidden by v-if="... && !isScanningContent"
    expect(wrapper.findComponent({ name: 'SearchPreview' }).exists()).toBe(false);
    expect(wrapper.text()).toContain('SCANNING CONTENT...');
  });

  it('should manage FocusArea when opening and closing', async () => {
    mockIsSearchOpen.value = false;
    mockActiveFocusArea.value = 'sidebar';
    mount(GlobalSearchModal);

    mockIsSearchOpen.value = true;
    await nextTick();
    expect(mockSetActiveFocusArea).toHaveBeenCalledWith('search');

    mockIsSearchOpen.value = false;
    await nextTick();
    // Should restore to previous ('sidebar')
    expect(mockSetActiveFocusArea).toHaveBeenCalledWith('sidebar');
  });

  it('should switch between results and preview panes with ArrowRight/Left', async () => {
    mockQuery.value = 'work';
    mockResults.value = [
      { type: 'chat_group', item: { groupId: 'g1', name: 'Work', updatedAt: 1, matchType: 'title' } },
    ] as any;

    const wrapper = mount(GlobalSearchModal);
    await nextTick();

    // Initial state
    expect((wrapper.vm as any).activePane).toBe('results');

    // ArrowRight to switch to preview
    await wrapper.get('[data-testid="search-input"]').trigger('keydown', { key: 'ArrowRight' });
    expect((wrapper.vm as any).activePane).toBe('preview');

    // ArrowLeft to switch back to results
    await wrapper.get('[data-testid="search-input"]').trigger('keydown', { key: 'ArrowLeft' });
    expect((wrapper.vm as any).activePane).toBe('results');
  });

  it('should list all items if opened with empty query in title_only mode', async () => {
    mockQuery.value = '';
    mockIsSearchOpen.value = false;

    mount(GlobalSearchModal);

    mockIsSearchOpen.value = true;
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0)); // wait for watch and performSearch

    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
      searchQuery: '',
      options: expect.objectContaining({ scope: 'title_only' })
    }));
  });

  it('should render results list even if query is empty in title_only mode', async () => {
    mockQuery.value = '';
    mockIsSearching.value = false;
    mockResults.value = [
      { type: 'chat', item: { chatId: 'chat1', title: 'Chat 1', updatedAt: 1, contentMatches: [], matchType: 'title' } },
    ] as any;

    const wrapper = mount(GlobalSearchModal);
    await nextTick();

    expect(wrapper.text()).not.toContain('Type to search...');
    expect(wrapper.find('[data-testid="search-result-item-0"]').exists()).toBe(true);
  });

  it('should maintain expanded preview during the 100ms mouseleave buffer', async () => {
    vi.useFakeTimers();
    mockQuery.value = 'test';
    mockIsScanningContent.value = false; // Ensure it's not hidden by scanning state
    mockResults.value = [
      { type: 'chat', item: { chatId: 'chat1', title: 'Chat 1', updatedAt: 1, contentMatches: [], matchType: 'title' } },
    ] as any;

    const wrapper = mount(GlobalSearchModal);
    await nextTick();

    const previewContainer = wrapper.get('[data-testid="search-preview-container"]');

    // Trigger expansion via click (since hover expansion was removed)
    await previewContainer.trigger('click');
    await nextTick();
    expect((wrapper.vm as any).isPreviewExpanded).toBe(true);

    // Trigger leave - should still be true due to buffer
    await previewContainer.trigger('mouseleave');
    await nextTick();
    expect((wrapper.vm as any).isPreviewExpanded).toBe(true);

    // Advance time by 50ms - should still be true
    vi.advanceTimersByTime(50);
    expect((wrapper.vm as any).isPreviewExpanded).toBe(true);

    // Advance time beyond 100ms - should finally be false
    vi.advanceTimersByTime(60);
    expect((wrapper.vm as any).isPreviewExpanded).toBe(false);

    vi.useRealTimers();
  });

  it('should expand preview on click and focus input on collapse', async () => {
    vi.useFakeTimers();
    mockQuery.value = 'test';
    mockResults.value = [
      { type: 'chat', item: { chatId: 'chat1', title: 'Chat 1', updatedAt: 1, contentMatches: [], matchType: 'title' } },
    ] as any;

    const wrapper = mount(GlobalSearchModal);
    await nextTick();

    const previewContainer = wrapper.get('[data-testid="search-preview-container"]');
    const input = wrapper.find('[data-testid="search-input"]').element as HTMLInputElement;
    const focusSpy = vi.spyOn(input, 'focus');

    // Click to expand (capture phase handler)
    await previewContainer.trigger('click');
    expect((wrapper.vm as any).isPreviewExpanded).toBe(true);

    // Leave - should trigger collapse after delay and focus input
    await previewContainer.trigger('mouseleave');
    vi.advanceTimersByTime(150);
    await nextTick();

    expect((wrapper.vm as any).isPreviewExpanded).toBe(false);
    expect(focusSpy).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('should expand preview with ArrowRight for chat results', async () => {
    mockQuery.value = 'test';
    mockResults.value = [
      { type: 'chat', item: { chatId: 'chat1', title: 'Chat 1', updatedAt: 1, contentMatches: [], matchType: 'title' } },
    ] as any;

    const wrapper = mount(GlobalSearchModal);
    await nextTick();

    expect((wrapper.vm as any).activePane).toBe('results');

    // ArrowRight to switch to preview
    await wrapper.get('[data-testid="search-input"]').trigger('keydown', { key: 'ArrowRight' });
    expect((wrapper.vm as any).activePane).toBe('preview');
  });

  it('should focus search input when switching back from preview with ArrowLeft', async () => {
    mockQuery.value = 'test';
    mockResults.value = [
      { type: 'chat', item: { chatId: 'chat1', title: 'Chat 1', updatedAt: 1, contentMatches: [], matchType: 'title' } },
    ] as any;

    const wrapper = mount(GlobalSearchModal);
    await nextTick();

    const input = wrapper.find('[data-testid="search-input"]').element as HTMLInputElement;
    const focusSpy = vi.spyOn(input, 'focus');

    // Switch to preview
    (wrapper.vm as any).activePane = 'preview';

    // ArrowLeft to switch back
    await wrapper.get('[data-testid="search-input"]').trigger('keydown', { key: 'ArrowLeft' });

    expect((wrapper.vm as any).activePane).toBe('results');
    await nextTick();
    expect(focusSpy).toHaveBeenCalled();
  });

  it('should delay highlighting of search results', async () => {
    vi.useFakeTimers();
    mockQuery.value = 'initial';
    const wrapper = mount(GlobalSearchModal);

    // Initially disabled
    expect((wrapper.vm as any).isHighlightingEnabled).toBe(false);

    // Advance 100ms
    vi.advanceTimersByTime(100);
    expect((wrapper.vm as any).isHighlightingEnabled).toBe(true);

    // Update query - should disable highlighting again
    mockQuery.value = 'updated';
    await nextTick(); // trigger watch
    expect((wrapper.vm as any).isHighlightingEnabled).toBe(false);

    vi.advanceTimersByTime(100);
    expect((wrapper.vm as any).isHighlightingEnabled).toBe(true);

    vi.useRealTimers();
  });

  it('should update query state immediately on input before debounce', async () => {
    vi.useFakeTimers();
    const wrapper = mount(GlobalSearchModal);

    // Wait for any initial searches triggered on mount/open
    await nextTick();
    vi.advanceTimersByTime(500);
    mockSearch.mockClear();

    const input = wrapper.get('[data-testid="search-input"]');

    // Simulate typing
    await input.setValue('fast typing');

    // Verify query is updated immediately (stability fix)
    expect(mockQuery.value).toBe('fast typing');

    // Search should not have been called yet due to debounce
    expect(mockSearch).not.toHaveBeenCalled();

    // Advance time to trigger search
    vi.advanceTimersByTime(350);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
      searchQuery: 'fast typing'
    }));

    vi.useRealTimers();
  });

  it('should persist query and select it on reopen', async () => {
    // 1. Open and type something
    mockIsSearchOpen.value = true;
    mockQuery.value = 'persistent query';
    const wrapper = mount(GlobalSearchModal);
    await nextTick();

    // 2. Close modal
    mockIsSearchOpen.value = false;
    await nextTick();

    // Verify stopSearch was called, NOT clearSearch
    expect(mockStopSearch).toHaveBeenCalled();
    expect(mockClearSearch).not.toHaveBeenCalled();

    // 3. Reopen modal
    const selectSpy = vi.spyOn(HTMLInputElement.prototype, 'select');
    mockIsSearchOpen.value = true;
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0)); // wait for watcher's nextTick

    // Verify query is still there and selected
    const input = wrapper.find('[data-testid="search-input"]').element as HTMLInputElement;
    expect(input.value).toBe('persistent query');
    expect(selectSpy).toHaveBeenCalled();

    selectSpy.mockRestore();
  });
});
