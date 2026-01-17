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
      currentChat: ref({ id: '1', title: 'Test Chat', modelId: 'gemma3n:e2b' }),
      streaming: ref(false),
      activeGenerations: new Map(),
      activeMessages: ref([]),
      availableModels: ref([]),
      fetchingModels: ref(false),
      fetchAvailableModels: vi.fn(),
      saveChat: vi.fn(),
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

  it('uses rounded-2xl for the chat input container to match the premium aesthetic', () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true, ChatSettingsPanel: true } },
    });
    const container = wrapper.find('.max-w-4xl.mx-auto.relative.group.border');
    expect(container.classes()).toContain('rounded-2xl');
  });

  it('ensures the input container stays within viewport when maximized', async () => {
    // Mock window.innerHeight
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 1000 });
    
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true, ChatSettingsPanel: true } },
    });
    
    // Simulate maximization
    (wrapper.vm as any).isMaximized = true;
    await (wrapper.vm as any).adjustTextareaHeight();
    
    const textarea = wrapper.find('[data-testid="chat-input"]');
    const height = parseFloat((textarea.element as HTMLElement).style.height);
    
    // 70% of 1000 is 700. It should be around that and certainly less than 1000.
    expect(height).toBeLessThan(1000 * 0.8); 
    expect(height).toBeGreaterThan(100);

    window.innerHeight = originalInnerHeight;
  });

  it('ensures the textarea and buttons are stacked vertically to avoid overlap', () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true, ChatSettingsPanel: true } },
    });
    
    const inputContainer = wrapper.find('.max-w-4xl.mx-auto.relative.group.border');
    expect(inputContainer.classes()).toContain('flex-col');
    
    const textarea = inputContainer.find('[data-testid="chat-input"]');
    const buttonRow = inputContainer.find('.flex.items-center.justify-between');
    
    expect(textarea.exists()).toBe(true);
    expect(buttonRow.exists()).toBe(true);
    
    // Verify vertical order in DOM: textarea should come before buttonRow
    const html = inputContainer.html();
    expect(html.indexOf('data-testid="chat-input"')).toBeLessThan(html.indexOf('justify-between'));
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
