import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, ref, nextTick } from 'vue';
import ChatSettingsPanel from './ChatSettingsPanel.vue';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { useChatModels } from '@/composables/chat/useChatModels';

// --- Mocks ---
const {
  mockAvailableModelsRef,
  mockFetchingModelsRef,
  mockUpdateScopedSettings,
} = vi.hoisted(() => ({
  mockAvailableModelsRef: { value: [] as string[] },
  mockFetchingModelsRef: { value: false },
  mockUpdateScopedSettings: vi.fn(),
}));

const mockCurrentChat = ref<any>(null);
const mockFetchAvailableModels = vi.fn();

vi.mock('../composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: vi.fn(),
}));

vi.mock('../composables/chat/useChatModels', () => ({
  useChatModels: vi.fn(),
}));

vi.mock('../composables/chat/useChatMetadata', () => ({
  useChatMetadata: () => ({
    rename: vi.fn(),
    toggleDebug: vi.fn(),
    updateModel: vi.fn(),
    updateScopedSettings: mockUpdateScopedSettings,
    updateSettings: vi.fn(),
    reasoningEffort: vi.fn(),
    updateReasoningEffort: vi.fn(),
    TEST_ONLY: {},
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
    vi.mocked(useChatModels).mockReturnValue({
      availableModels: computed(() => mockAvailableModelsRef.value) as unknown as ReturnType<typeof useChatModels>['availableModels'],
      fetchingModels: computed(() => mockFetchingModelsRef.value),
      fetchForChat: async ({ chatId }) => {
        return await mockFetchAvailableModels({ chatId });
      },
      fetchForGlobalEndpoint: vi.fn(),
      fetchForEndpoint: vi.fn(),
      TEST_ONLY: {},
    });
  });

  it('keeps the panel open and preserves a visible error when saving fails', async () => {
    mockUpdateScopedSettings.mockRejectedValue(new Error('storage failed'));

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

    const input = wrapper.get('input[data-testid="chat-setting-url-input"]');
    await input.setValue('http://failed-save.example');
    await input.trigger('blur');
    await wrapper.get('[data-testid="close-button"]').trigger('click');
    await flushPromises();

    expect(wrapper.emitted('close')).toBeUndefined();
    expect(wrapper.get('[data-testid="chat-settings-save-error"]').text()).toContain('storage failed');
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

  it('preserves_the_draft_when_a_prop_driven_close_save_fails_and_the_panel_reopens', async () => {
    mockUpdateScopedSettings.mockRejectedValue(new Error('storage failed'));

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

    const input = wrapper.get('input[data-testid="chat-setting-url-input"]');
    await input.setValue('http://failed-background-save.example');
    await wrapper.setProps({ show: false });
    await flushPromises();
    await wrapper.setProps({ show: true });
    await nextTick();

    expect((wrapper.get('input[data-testid="chat-setting-url-input"]').element as HTMLInputElement).value)
      .toBe('http://failed-background-save.example');
    expect(wrapper.get('[data-testid="chat-settings-save-error"]').text()).toContain('storage failed');
  });

});
