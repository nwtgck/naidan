import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, VueWrapper } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import ChatInput from './ChatInput.vue';
import { ref, nextTick } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import type { MessageNode, Chat } from '../models/types';

// Mock dependencies
const mockCurrentChat = ref<Chat | null>(null);

const mockActiveFocusArea = ref('chat');

vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    isSidebarOpen: ref(true),
    activeFocusArea: mockActiveFocusArea,
    setActiveFocusArea: vi.fn((area) => {
      mockActiveFocusArea.value = area;
    }),
    toggleSidebar: vi.fn(),
  }),
}));

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    chatGroups: ref([]),
    resolvedSettings: ref({ modelId: 'm1', sources: { modelId: 'global' } }),
    inheritedSettings: ref({ modelId: 'm1', sources: { modelId: 'global' } }),
    availableModels: ref([]),
    fetchingModels: ref(false),
    generatingTitle: ref(false),
    streaming: ref(false),
    activeMessages: ref([]),
    isProcessing: vi.fn().mockReturnValue(false),
    fetchAvailableModels: vi.fn(),
    getSiblings: vi.fn().mockReturnValue([]),
    abortChat: vi.fn(),
    updateChatModel: vi.fn(),
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
    moveChatToGroup: vi.fn(),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({}),
    availableModels: ref([]),
    isFetchingModels: ref(false),
  }),
}));

vi.mock('../composables/useChatDraft', () => ({
  useChatDraft: () => ({
    getDraft: vi.fn(() => ({ input: '', attachments: [], attachmentUrls: {} })),
    saveDraft: vi.fn(),
    clearDraft: vi.fn(),
    revokeAll: vi.fn(),
  }),
}));

describe('ChatArea Peek Mode Specifications', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', component: { template: 'div' } }],
  });

  let wrapper: VueWrapper<any> | null = null;

  beforeEach(async () => {
    mockCurrentChat.value = {
      id: '1',
      title: 'Test Chat',
      root: { items: [] } as { items: MessageNode[] },
      currentLeafId: undefined,
      debugEnabled: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    mockActiveFocusArea.value = 'chat';
    document.body.innerHTML = '<div id="app"></div>';
  });

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount();
      wrapper = null;
    }
  });

  it('toggles submerged state when the submerge button is clicked', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'ModelSelector': true, 'ChatToolsMenu': true, 'lucide-vue-next': true, 'BinaryObjectPreviewModal': true, 'HistoryManipulationModal': true } },
    });
    await nextTick();

    const button = wrapper.get('[data-testid="submerge-button"]');

    // Initially active
    expect(wrapper.vm.inputVisibility).toBe('active');

    // Click to submerge
    await button.trigger('click');
    expect(wrapper.vm.inputVisibility).toBe('submerged');

    // Click again to unsubmerge (becomes active)
    await button.trigger('click');
    expect(wrapper.vm.inputVisibility).toBe('active');
  });

  it('automatically unsubmerges when mouse enters the input area', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'ModelSelector': true, 'ChatToolsMenu': true, 'lucide-vue-next': true, 'BinaryObjectPreviewModal': true, 'HistoryManipulationModal': true } },
    });
    await nextTick();

    await wrapper.get('[data-testid="submerge-button"]').trigger('click');
    expect(wrapper.vm.inputVisibility).toBe('submerged');

    // Find the input container (the one with the border and rounded-2xl)
    const inputContainer = wrapper.find('.max-w-4xl.mx-auto.w-full.pointer-events-auto');
    await inputContainer.trigger('mouseenter');

    // Should become peeking
    expect(wrapper.vm.inputVisibility).toBe('peeking');
  });

  it('maintains submerged state when switching chats', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'ModelSelector': true, 'ChatToolsMenu': true, 'lucide-vue-next': true, 'BinaryObjectPreviewModal': true, 'HistoryManipulationModal': true } },
    });
    await nextTick();

    // Submerge in chat 1
    await wrapper.get('[data-testid="submerge-button"]').trigger('click');
    expect(wrapper.vm.inputVisibility).toBe('submerged');

    // Switch to chat 2
    mockCurrentChat.value = {
      id: '2',
      title: 'Chat 2',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now()
    } as any;

    await nextTick();
    await nextTick();

    // Should still be submerged
    expect(wrapper.vm.inputVisibility).toBe('submerged');
  });

  it('adjusts scroll container padding-bottom based on visibility state', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'ModelSelector': true, 'ChatToolsMenu': true, 'lucide-vue-next': true, 'BinaryObjectPreviewModal': true, 'HistoryManipulationModal': true } },
    });
    await nextTick();

    const scrollContainer = wrapper.get('[data-testid="scroll-container"]');

    // Default padding (active)
    expect((scrollContainer.element as HTMLElement).style.paddingBottom).toBe('300px');

    // Submerge
    await wrapper.get('[data-testid="submerge-button"]').trigger('click');
    await nextTick();
    expect((scrollContainer.element as HTMLElement).style.paddingBottom).toBe('48px');
  });

  it('resets maximized state when submerging', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'ModelSelector': true, 'ChatToolsMenu': true, 'lucide-vue-next': true, 'BinaryObjectPreviewModal': true, 'HistoryManipulationModal': true } },
    });
    await nextTick();

    // Manually set maximized
    const chatInput = wrapper.findComponent(ChatInput);
    (chatInput.vm as any).isMaximized = true;
    await nextTick();

    // Submerge
    await wrapper.get('[data-testid="submerge-button"]').trigger('click');
    expect(wrapper.vm.inputVisibility).toBe('submerged');
    expect((chatInput.vm as any).isMaximized).toBe(false);
  });

  it('stays in active state on mouseleave if focused', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'ModelSelector': true, 'ChatToolsMenu': true, 'lucide-vue-next': true, 'BinaryObjectPreviewModal': true, 'HistoryManipulationModal': true } },
    });
    await nextTick();

    const inputContainer = wrapper.find('.max-w-4xl.mx-auto.w-full.pointer-events-auto');
    const textarea = wrapper.find('textarea');

    // Submerge first
    await wrapper.get('[data-testid="submerge-button"]').trigger('click');
    expect(wrapper.vm.inputVisibility).toBe('submerged');

    // Hover -> peeking
    await inputContainer.trigger('mouseenter');
    expect(wrapper.vm.inputVisibility).toBe('peeking');

    // Focus -> active
    await textarea.trigger('focus');
    expect(wrapper.vm.inputVisibility).toBe('active');

    // Mouse leave -> should STAY active
    await inputContainer.trigger('mouseleave');
    expect(wrapper.vm.inputVisibility).toBe('active');
  });

  it('contains a hit area extension for stable hover detection', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'ModelSelector': true, 'ChatToolsMenu': true, 'lucide-vue-next': true, 'BinaryObjectPreviewModal': true, 'HistoryManipulationModal': true } },
    });
    await nextTick();

    const hitArea = wrapper.find('[data-testid="hit-area-extension"]');
    expect(hitArea.exists()).toBe(true);
    expect(hitArea.classes()).toContain('-bottom-16');
  });
});
