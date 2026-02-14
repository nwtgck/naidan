import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatSettingsPanel from './ChatSettingsPanel.vue';
import { ref, nextTick } from 'vue';

// --- Mocks ---

const mockCurrentChat = ref<any>(null);
const mockFetchAvailableModels = vi.fn();

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    fetchingModels: ref(false),
    updateChatSettings: vi.fn(),
    fetchAvailableModels: mockFetchAvailableModels,
  }),
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