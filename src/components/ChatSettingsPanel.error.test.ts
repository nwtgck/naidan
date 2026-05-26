import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatSettingsPanel from './ChatSettingsPanel.vue';
import { computed, ref, nextTick } from 'vue';
import { useChatSettingsPanel } from '@/composables/chat/chat-scoped/useChatSettingsPanel';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';

// --- Mocks ---

const mockCurrentChat = ref<any>(null);
const mockFetchAvailableModels = vi.fn();

vi.mock('../composables/chat/chat-scoped/useChatSettingsPanel', () => ({
  useChatSettingsPanel: vi.fn(),
}));

vi.mock('../composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: vi.fn(),
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
      TEST_ONLY: {},
    });

    vi.mocked(useChatSettingsPanel).mockReturnValue({
      currentChat: mockCurrentChat,
      fetchingModels: computed(() => false),
      availableModels: ref([]),
      resolvedSettings: computed(() => ({
        endpointType: mockCurrentChat.value.endpointType,
        endpointUrl: mockCurrentChat.value.endpointUrl,
        modelId: undefined,
        sources: {
          endpointType: 'chat',
          endpointUrl: 'chat',
          modelId: 'global',
        },
      })),
      inheritedSettings: computed(() => ({
        endpointType: 'openai',
        endpointUrl: 'http://localhost',
        modelId: undefined,
        sources: {
          endpointType: 'global',
          endpointUrl: 'global',
          modelId: 'global',
        },
      })),
      updateSettings: vi.fn(),
      fetchModels: vi.fn().mockImplementation(async () => {
        return await mockFetchAvailableModels();
      }),
      TEST_ONLY: {},
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
