import { ref } from 'vue';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import ChatInput from './ChatInput.vue';
import ChatSettingsPanel from './ChatSettingsPanel.vue';
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
      resolvedSettings: ref({ 
        modelId: 'gemma3n:e2b', 
        sources: { modelId: 'chat' } 
      }),
      isTaskRunning: vi.fn().mockReturnValue(false),
      isProcessing: vi.fn().mockReturnValue(false),
      abortChat: vi.fn(),
      isImageMode: vi.fn(() => false),
      toggleImageMode: vi.fn(),
      getResolution: vi.fn(() => ({ width: 512, height: 512 })), 
      getCount: vi.fn(() => 1), 
      updateCount: vi.fn(),
      getPersistAs: vi.fn(() => 'original'),
      updatePersistAs: vi.fn(),
      updateResolution: vi.fn(),
      setImageModel: vi.fn(),
      getSelectedImageModel: vi.fn(),
      getSortedImageModels: vi.fn(() => []),
      imageModeMap: ref({}),
      imageResolutionMap: ref({}), 
      imageCountMap: ref({}),
      imagePersistAsMap: ref({}),
      imageModelOverrideMap: ref({}),
    });
    (useSettings as unknown as Mock).mockReturnValue({
      settings: ref({ defaultModelId: 'gpt-4' }),
    });
  });

  it('uses backdrop-blur-md on the header for a glass effect', () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true } },
    });
    const header = wrapper.find('.backdrop-blur-md');
    expect(header.exists()).toBe(true);
    expect(header.classes()).toContain('bg-white/80');
  });

  it('provides enough bottom padding to account for the floating input', () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true } },
    });
    const scrollContainer = wrapper.find('[data-testid="scroll-container"]');
    const paddingBottom = (scrollContainer.element as HTMLElement).style.paddingBottom;
    expect(parseInt(paddingBottom)).toBeGreaterThanOrEqual(300);
  });

  it('uses a large conditional spacer for the maximized state', async () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true } },
    });
    
    // Initially spacer should not exist
    expect(wrapper.find('[data-testid="maximized-spacer"]').exists()).toBe(false);

    // Toggle maximized
    (wrapper.vm as any).isMaximized = true;
    await flushPromises();
    
    expect(wrapper.find('[data-testid="maximized-spacer"]').exists()).toBe(true);
  });

  it('preserves the case of the Model ID (no forced uppercase)', () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true } },
    });
    const modelTrigger = wrapper.find('[data-testid="model-trigger"]');
    expect(modelTrigger.text()).toContain('gemma3n:e2b');
    expect(modelTrigger.text()).not.toContain('GEMMA3N');
  });

  it('preserves the case of the keyboard shortcut labels (e.g., Cmd + Enter)', () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true } },
    });
    const sendBtn = wrapper.find('[data-testid="send-button"]');
    expect(sendBtn.exists()).toBe(true);
    expect(sendBtn.text()).toContain('Enter');
    expect(sendBtn.text()).not.toContain('ENTER');
  });

  it('uses rounded-2xl for the chat input container to match the premium aesthetic', () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true } },
    });
    const container = wrapper.find('.max-w-4xl.mx-auto.w-full.pointer-events-auto');
    expect(container.classes()).toContain('rounded-2xl');
  });

  it('ensures the input container stays within viewport when maximized', async () => {
    // Mock window.innerHeight
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 1000 });
    
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true } },
    });
    
    // Simulate maximization
    (wrapper.vm as any).isMaximized = true;
    const chatInput = wrapper.findComponent(ChatInput);
    await (chatInput.vm as any).adjustTextareaHeight();
    
    const textarea = wrapper.find('[data-testid="chat-input"]');
    const height = parseFloat((textarea.element as HTMLElement).style.height);
    
    // 70% of 1000 is 700.
    expect(height).toBeLessThan(1000 * 0.8); 
    expect(height).toBeGreaterThan(100);

    window.innerHeight = originalInnerHeight;
  });

  it('ensures the textarea and buttons are stacked vertically inside the floating container', () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true } },
    });
    
    const inputContainer = wrapper.find('.max-w-4xl.mx-auto.w-full.pointer-events-auto');
    expect(inputContainer.classes()).toContain('flex-col');
    
    const textarea = inputContainer.find('[data-testid="chat-input"]');
    const buttonRow = inputContainer.find('.flex.items-center.justify-between');
    
    expect(textarea.exists()).toBe(true);
    expect(buttonRow.exists()).toBe(true);
    
    // Verify vertical order in DOM: textarea should come before buttonRow
    const html = inputContainer.html();
    expect(html.indexOf('data-testid="chat-input"')).toBeLessThan(html.indexOf('justify-between'));
  });

  it('applies animation classes when toggling maximized state', async () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true } },
    });
    
    const textarea = wrapper.find('[data-testid="chat-input"]');
    
    // Initially should not have animation class
    expect(textarea.classes()).not.toContain('animate-height');

    // Toggle maximized
    const chatInput = wrapper.findComponent(ChatInput);
    await (chatInput.vm as any).toggleMaximized();
    await flushPromises();
    
    // Should have animation class
    expect(textarea.classes()).toContain('animate-height');

    // Wait for animation duration (350ms + some buffer)
    await new Promise(resolve => setTimeout(resolve, 450));
    await flushPromises();

    // Should no longer have animation class after timeout
    expect(textarea.classes()).not.toContain('animate-height');
  });

  it('uses gray-800 for chat content text to ensure eye comfort', () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true } },
    });
    const title = wrapper.find('h2');
    expect(title.classes()).toContain('text-gray-800');
  });

  it('displays the critical "only for localhost" notice in ChatSettingsPanel', async () => {
    const wrapper = mount(ChatArea, {
      global: { 
        stubs: { 
          Logo: true, 
          MessageItem: true, 
          WelcomeScreen: true,
          ChatSettingsPanel: ChatSettingsPanel,
        }, 
      },
    });
    
    // Toggle settings panel
    const settingsBtn = wrapper.find('[data-testid="model-trigger"]');
    await settingsBtn?.trigger('click');
    await flushPromises();
    
    // Check if the panel text contains the important wording
    expect(wrapper.text()).toContain('only for localhost');
  });

  it('implements overflow-anchor: none to prevent message jumping during layout changes', () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true } },
    });
    const scrollContainer = wrapper.find('[data-testid="scroll-container"]');
    expect((scrollContainer.element as HTMLElement).style.overflowAnchor).toBe('none');
  });

  it('uses an opaque background for the input card to ensure readability', () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true } },
    });
    const inputCard = wrapper.find('.max-w-4xl.mx-auto.w-full.pointer-events-auto');
    expect(inputCard.classes()).toContain('bg-white');
    // It should not have backdrop-blur on the card itself anymore
    expect(inputCard.classes()).not.toContain('backdrop-blur-md');
  });

  it('contains a glass-zone-mask for the background blur effect', () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true } },
    });
    const glassZone = wrapper.find('.glass-zone-mask');
    expect(glassZone.exists()).toBe(true);
    expect(glassZone.classes()).toContain('absolute');
    expect(glassZone.classes()).toContain('inset-0');
  });

  it('positions the input area as absolute at the bottom to overlap messages', () => {
    const wrapper = mount(ChatArea, {
      global: { stubs: { Logo: true, MessageItem: true, WelcomeScreen: true } },
    });
    // The Input Layer (Overlay)
    const inputLayer = wrapper.find('.absolute.bottom-0.left-0.right-0.p-2');
    expect(inputLayer.exists()).toBe(true);
    expect(inputLayer.classes()).toContain('z-30');
    expect(inputLayer.classes()).toContain('bg-transparent');
  });
});