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
    saveChat: vi.fn(),
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
      global: {
        stubs: {
          ModelSelector: true,
          LmParametersEditor: true,
        },
      },
    });

    // Trigger fetch to get error
    // In ChatSettingsPanel.vue, fetchModels is called on mount if localhost, 
    // or we can trigger it manually if we mock isLocalhost or just wait for the watch
    
    // Let's manually trigger the watch by changing URL to something that looks like localhost
    mockCurrentChat.value.endpointUrl = 'http://localhost:11434';
    await nextTick();
    await nextTick(); // Wait for fetchModels promise
    
    // Verify error is shown (it should be "No models found..." based on our mock)
    expect(wrapper.text()).toContain('No models found');

    // Now change URL again
    const input = wrapper.find('input[type="text"]');
    await input.setValue('http://new-url');
    
    // Error should be cleared immediately on @input or via watch
    expect(wrapper.text()).not.toContain('No models found');
  });
});
