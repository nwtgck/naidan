import { ref } from 'vue';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import { useChat } from '../composables/useChat';
import { useSettings } from '../composables/useSettings';

vi.mock('../composables/useChat', () => ({
  useChat: vi.fn(),
}));
vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(),
}));
vi.mock('vue-router', () => ({
  useRouter: vi.fn(),
}));

describe('ChatArea Design Specifications', () => {
  beforeEach(() => {
    (useChat as unknown as Mock).mockReturnValue({
      currentChat: ref({ id: '1', title: 'Test Chat', overrideModelId: 'gemma3n:e2b' }),
      streaming: ref(false),
      activeMessages: ref([]),
      availableModels: ref([]),
      fetchingModels: ref(false),
      fetchAvailableModels: vi.fn(),
      saveCurrentChat: vi.fn(),
    });
    (useSettings as unknown as Mock).mockReturnValue({
      settings: ref({ defaultModelId: 'gpt-4' }),
    });
  });

  it('uses backdrop-blur-md on the header for a glass effect', () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true, ChatSettingsPanel: true } },
    });
    const header = wrapper.find('.backdrop-blur-md');
    expect(header.exists()).toBe(true);
    expect(header.classes()).toContain('bg-white/80');
  });

  it('preserves the case of the Model ID (no forced uppercase)', () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true, ChatSettingsPanel: true } },
    });
    const modelTrigger = wrapper.find('[data-testid="model-trigger"]');
    expect(modelTrigger.text()).toContain('gemma3n:e2b');
    expect(modelTrigger.text()).not.toContain('GEMMA3N');
  });

  it('preserves the case of the keyboard shortcut labels (e.g., Cmd + Enter)', () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true, ChatSettingsPanel: true } },
    });
    const sendBtn = wrapper.find('[data-testid="send-button"]');
    expect(sendBtn.exists()).toBe(true);
    expect(sendBtn.text()).toContain('Enter');
    expect(sendBtn.text()).not.toContain('ENTER');
  });

  it('uses rounded-2xl for the chat input to match the premium aesthetic', () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true, ChatSettingsPanel: true } },
    });
    const textarea = wrapper.find('[data-testid="chat-input"]');
    expect(textarea.classes()).toContain('rounded-2xl');
  });

  it('uses gray-800 for chat content text to ensure eye comfort', () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true, ChatSettingsPanel: true } },
    });
    const title = wrapper.find('h2');
    expect(title.classes()).toContain('text-gray-800');
  });

  it('displays the critical "only for localhost" notice in ChatSettingsPanel', async () => {
    const wrapper = mount(ChatArea, {
      global: { 
        stubs: { Logo: true, MessageItem: true, WelcomeScreen: true }, 
      },
    });
    
    // Toggle settings panel
    const settingsBtn = wrapper.find('[data-testid="model-trigger"]');
    await settingsBtn?.trigger('click');
    
    // Check if the panel text contains the important wording
    expect(wrapper.text()).toContain('only for localhost');
  });
});
