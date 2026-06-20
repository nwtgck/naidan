import type { ChatId, MessageId } from '@/models/ids';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, VueWrapper } from '@vue/test-utils';
import ChatPane from './ChatPane.vue';
import { ref, nextTick, computed } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import type { MessageNode, Chat } from '@/models/types';


import { setupScrollToMock } from '@/utils/test-utils';
import type { FocusArea } from '@/composables/useLayout';
import { toChatId } from '@/models/ids';


// Mock dependencies
const mockCurrentChat = ref<Chat | null>({
  id: toChatId({ raw: '1' }),
  title: 'Test Chat',
  root: { items: [] } as { items: MessageNode[] },
  currentLeafId: undefined,
  debugEnabled: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const mockActiveMessages = ref<MessageNode[]>([]);
const mockCurrentChatGroup = ref(null);
const mockChatGroups = ref<any[]>([]);
const mockResolvedSettings = ref({ modelId: 'm1', sources: { modelId: 'global', titleModelId: 'global' } });
const mockInheritedSettings = ref({ modelId: 'm1', sources: { modelId: 'global', titleModelId: 'global' } });

const mockActiveFocusArea = ref('chat');
const mockSetActiveFocusArea = vi.fn(({ area }: { area: FocusArea }) => {
  mockActiveFocusArea.value = area;
});

vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    isSidebarOpen: ref(true),
    activeFocusArea: mockActiveFocusArea,
    mediaShelfVisibility: ref('hidden'),
    setMediaShelfVisibility: vi.fn(),
    toggleMediaShelf: vi.fn(),
    isChatWeshTerminalOpen: ref(false),
    toggleChatWeshTerminal: vi.fn(),
    setActiveFocusArea: mockSetActiveFocusArea,
    toggleSidebar: vi.fn(),
  }),
}));

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    currentChatGroup: mockCurrentChatGroup,
    chatGroups: mockChatGroups,
    resolvedSettings: mockResolvedSettings,
    inheritedSettings: mockInheritedSettings,
    availableModels: ref([]),
    fetchingModels: ref(false),
    generatingTitle: ref(false),
    generateChatTitle: vi.fn(),
    abortTitleGeneration: vi.fn(),
    streaming: ref(false),
    activeMessages: mockActiveMessages,
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
    getSteps: vi.fn(() => undefined),
    updateSteps: vi.fn(),
    getSeed: vi.fn(() => 'browser_random'),
    updateSeed: vi.fn(),
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
    getReasoningEffort: vi.fn(),
    updateReasoningEffort: vi.fn(),
    updateChatSettings: vi.fn(),
    getLiveChat: vi.fn().mockImplementation((c) => c),
    chatFlow: computed(() => mockActiveMessages.value.map(m => ({
      type: 'message',
      node: m,
      mode: 'content',
      flow: { position: 'standalone', nesting: 'none' },
      isFirstInNode: true,
      isLastInNode: true,
      isFirstInTurn: true
    }))),
    isThinkingActive: vi.fn(() => false),
    isWaitingResponse: vi.fn(() => false),
  }),
}));


vi.mock('../composables/chat/ui/useChatPaneState', () => ({
  useChatPaneState: () => ({
    chat: computed(() => mockCurrentChat.value),
    chatGroup: computed(() => mockCurrentChatGroup.value),
    activeMessages: computed(() => mockActiveMessages.value),
    allMessages: computed(() => mockActiveMessages.value),
    resolvedSettings: computed(() => mockResolvedSettings.value),
    inheritedSettings: computed(() => mockInheritedSettings.value),
    chatGroups: computed(() => mockChatGroups.value),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({}),
    availableModels: ref([]),
    isFetchingModels: ref(false),
  }),
}));

function mountChatPane({
  props,
  attachTo,
  global,
}: {
  props?: {
    chatId?: ChatId;
    autoSendPrompt?: string;
    targetMessageId?: MessageId;
  };
  attachTo?: Element | string;
  global?: Record<string, unknown>;
} = {}) {
  return mount(ChatPane, {
    props: {
      chatId: props?.chatId ?? mockCurrentChat.value?.id ?? toChatId({ raw: '1' }),
      autoSendPrompt: props?.autoSendPrompt,
      targetMessageId: props?.targetMessageId,
    },
    attachTo,
    global,
  });
}

describe('ChatPane Focus Specifications', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', component: { template: 'div' } }],
  });

  let wrapper: VueWrapper<any> | null = null;

  beforeEach(() => {
    setupScrollToMock();
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
    wrapper = mountChatPane( {
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'Logo': true, 'ModelSelector': true, 'lucide-vue-next': true } },
    });

    // Click the main container
    await wrapper.trigger('click');
    expect(mockSetActiveFocusArea).toHaveBeenCalledWith({ area: 'chat' });
  });

  it('sets focus area to chat when the textarea is focused', async () => {
    wrapper = mountChatPane( {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'Logo': true, 'ModelSelector': true, 'lucide-vue-next': true } },
    });

    const textarea = wrapper.find('[data-testid="chat-input"]');
    await textarea.trigger('focus');
    expect(mockSetActiveFocusArea).toHaveBeenCalledWith({ area: 'chat' });
  });

  it('prevents automatic focus on textarea when focus area is sidebar', async () => {
    mockActiveFocusArea.value = 'sidebar';

    wrapper = mountChatPane( {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'Logo': true, 'ModelSelector': true, 'lucide-vue-next': true } },
    });

    const textarea = wrapper.find('[data-testid="chat-input"]').element as HTMLTextAreaElement;

    // Switch chat while focused on sidebar
    mockCurrentChat.value = { ...mockCurrentChat.value!, id: toChatId({ raw: '2' }) };
    await nextTick();
    await nextTick();

    expect(document.activeElement).not.toBe(textarea);
  });

  it('automatically focuses textarea when a new chat is created and area is chat', async () => {
    mockActiveFocusArea.value = 'chat';

    wrapper = mountChatPane( {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'Logo': true, 'ModelSelector': true, 'lucide-vue-next': true } },
    });

    const textarea = wrapper.find('[data-testid="chat-input"]').element as HTMLTextAreaElement;

    // Simulate new chat creation
    mockCurrentChat.value = { ...mockCurrentChat.value!, id: toChatId({ raw: 'new-chat-id' }) };
    await nextTick();
    await nextTick();

    expect(document.activeElement).toBe(textarea);
  });

  it('focuses textarea when a grouped chat is created even if starting from sidebar focus', async () => {
    // 1. Start with sidebar focus (e.g. user clicked sidebar or a group)
    mockActiveFocusArea.value = 'sidebar';

    wrapper = mountChatPane( {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'Logo': true, 'ModelSelector': true, 'lucide-vue-next': true } },
    });

    const textarea = wrapper.find('[data-testid="chat-input"]').element as HTMLTextAreaElement;
    expect(document.activeElement).not.toBe(textarea);

    // 2. Simulate handleNewChat setting area to 'chat' before store update
    mockActiveFocusArea.value = 'chat';

    // 3. Simulate store update (new chat ID set)
    mockCurrentChat.value = { ...mockCurrentChat.value!, id: toChatId({ raw: 'grouped-chat-id' }) };
    await nextTick();
    await nextTick();

    // 4. Should be focused now
    expect(document.activeElement).toBe(textarea);
  });
});
