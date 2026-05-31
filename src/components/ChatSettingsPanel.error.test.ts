import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatSettingsPanel from './ChatSettingsPanel.vue';
import { computed, ref, nextTick } from 'vue';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { fetchAvailableModelsForChat } from '@/composables/chat/chat-scoped/chat-model-helpers';

// --- Mocks ---
const { mockAvailableModelsRef, mockFetchingModelsRef } = vi.hoisted(() => ({
  mockAvailableModelsRef: { value: [] as string[] },
  mockFetchingModelsRef: { value: false },
}));

const mockCurrentChat = ref<any>(null);
const mockFetchAvailableModels = vi.fn();

vi.mock('../composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: vi.fn(),
}));

vi.mock('../composables/chat/global/chat-core-singletons', async () => {
  const actual = await vi.importActual<typeof import('../composables/chat/global/chat-core-singletons')>(
    '../composables/chat/global/chat-core-singletons'
  );

  return {
    ...actual,
    availableModels: mockAvailableModelsRef,
    fetchingModels: mockFetchingModelsRef,
  };
});

vi.mock('../composables/chat/chat-scoped/chat-model-helpers', () => ({
  fetchAvailableModelsForChat: vi.fn(),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpointUrl: 'http://localhost' }),
  }),
}));

describe('ChatSettingsPanel Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentChat.value = {
      id: '1',
      title: 'Test Chat',
      endpointUrl: 'http://old-url',
      endpointType: 'openai',
      systemPrompt: null,
      lmParameters: {},
    };

    vi.mocked(useCurrentChatState).mockReturnValue({
      currentChatId: computed(() => mockCurrentChat.value?.id),
      currentChat: computed(() => mockCurrentChat.value),
      currentChatGroup: computed(() => null),
      activeMessages: computed(() => []),
      allMessages: computed(() => []),
      resolvedSettings: computed(() => null),
      inheritedSettings: computed(() => null),
      chatGroups: computed(() => []),
      sidebarItems: computed(() => []),
      TEST_ONLY: {},
    } as ReturnType<typeof useCurrentChatState>);
    mockAvailableModelsRef.value = [];
    mockFetchingModelsRef.value = false;
    vi.mocked(fetchAvailableModelsForChat).mockImplementation(async ({ chatId, errorSource }) => {
      return await mockFetchAvailableModels({ chatId, errorSource });
    });
  });

  it('should reset error state when endpoint URL changes', async () => {
    // Mock a failed fetch to set an error
    mockFetchAvailableModels.mockResolvedValue([]); // No models found triggers error in component logic

    const wrapper = mount(ChatSettingsPanel, {
      props: { show: true },
      global: {
        stubs: {
          ModelSelector: true,
          LmParametersEditor: true,
          'router-link': true,
        },
      },
    });

    // Act: Set URL to localhost via input to trigger auto-fetch
    const input = wrapper.find('input[data-testid="chat-setting-url-input"]');
    await input.setValue('http://localhost:11434');

    // Wait for debounce/watch/fetchModels
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    // Verify error is shown
    expect(wrapper.text()).toContain('No models found');

    // Now change URL again
    await input.setValue('http://new-url');

    // Error should be cleared immediately on @input or via watch
    expect(wrapper.text()).not.toContain('No models found');
  });
});
