import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, VueWrapper } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import { ref, nextTick } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import type { MessageNode, Chat } from '../models/types';


// Mock dependencies
const mockCurrentChat = ref<Chat | null>({
  id: '1',
  title: 'Test Chat',
  root: { items: [] } as { items: MessageNode[] },
  currentLeafId: undefined,
  debugEnabled: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const mockActiveFocusArea = ref('chat');
const mockSetActiveFocusArea = vi.fn((area) => {
  mockActiveFocusArea.value = area;
});

vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    isSidebarOpen: ref(true),
    activeFocusArea: mockActiveFocusArea,
    setActiveFocusArea: mockSetActiveFocusArea,
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
    imageModeMap: ref({}),
    imageResolutionMap: ref({}),
    imageCountMap: ref({}),
    imagePersistAsMap: ref({}),
    imageModelOverrideMap: ref({}),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({}),
    availableModels: ref([]),
    isFetchingModels: ref(false),
  }),
}));

describe('ChatArea Focus Specifications', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', component: { template: 'div' } }],
  });

  let wrapper: VueWrapper<any> | null = null;

  beforeEach(() => {
    mockActiveFocusArea.value = 'chat';
    mockSetActiveFocusArea.mockClear();
    document.body.innerHTML = '<div id="app"></div>';
  });

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount();
      wrapper = null;
    }
    document.body.innerHTML = '';
  });

  it('sets focus area to chat when the container is clicked', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'Logo': true, 'ModelSelector': true, 'lucide-vue-next': true } },
    });

    // Click the main container
    await wrapper.trigger('click');
    expect(mockSetActiveFocusArea).toHaveBeenCalledWith('chat');
  });

  it('sets focus area to chat when the textarea is focused', async () => {
    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'Logo': true, 'ModelSelector': true, 'lucide-vue-next': true } },
    });

    const textarea = wrapper.find('[data-testid="chat-input"]');
    await textarea.trigger('focus');
    expect(mockSetActiveFocusArea).toHaveBeenCalledWith('chat');
  });

  it('prevents automatic focus on textarea when focus area is sidebar', async () => {
    mockActiveFocusArea.value = 'sidebar';

    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'Logo': true, 'ModelSelector': true, 'lucide-vue-next': true } },
    });

    const textarea = wrapper.find('[data-testid="chat-input"]').element as HTMLTextAreaElement;

    // Switch chat while focused on sidebar
    mockCurrentChat.value = { ...mockCurrentChat.value!, id: '2' };
    await nextTick();
    await nextTick();

    expect(document.activeElement).not.toBe(textarea);
  });

  it('automatically focuses textarea when a new chat is created and area is chat', async () => {
    mockActiveFocusArea.value = 'chat';

    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'Logo': true, 'ModelSelector': true, 'lucide-vue-next': true } },
    });

    const textarea = wrapper.find('[data-testid="chat-input"]').element as HTMLTextAreaElement;

    // Simulate new chat creation
    mockCurrentChat.value = { ...mockCurrentChat.value!, id: 'new-chat-id' };
    await nextTick();
    await nextTick();

    expect(document.activeElement).toBe(textarea);
  });

  it('focuses textarea when a grouped chat is created even if starting from sidebar focus', async () => {
    // 1. Start with sidebar focus (e.g. user clicked sidebar or a group)
    mockActiveFocusArea.value = 'sidebar';

    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'Logo': true, 'ModelSelector': true, 'lucide-vue-next': true } },
    });

    const textarea = wrapper.find('[data-testid="chat-input"]').element as HTMLTextAreaElement;
    expect(document.activeElement).not.toBe(textarea);

    // 2. Simulate handleNewChat setting area to 'chat' before store update
    mockActiveFocusArea.value = 'chat';

    // 3. Simulate store update (new chat ID set)
    mockCurrentChat.value = { ...mockCurrentChat.value!, id: 'grouped-chat-id' };
    await nextTick();
    await nextTick();

    // 4. Should be focused now
    expect(document.activeElement).toBe(textarea);
  });
});
