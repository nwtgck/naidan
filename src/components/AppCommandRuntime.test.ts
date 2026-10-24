import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { computed, nextTick, reactive, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { useRoute, useRouter } from 'vue-router';
import type { Chat, Settings } from '@/01-models/types';
import { toChatId } from '@/01-models/ids';
import type { AppEntryMode } from '@/composables/useAppEntry';
import type { AppInteraction } from '@/composables/useAppPresentation';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import AppCommandRuntime from './AppCommandRuntime.vue';
import { useLayout } from '@/composables/useLayout';
import { useSettings } from '@/composables/useSettings';
import { creatingChat as mockCreatingChat } from '@/composables/chat/global/chat-core-singletons';

enableAutoUnmount(afterEach);

function routeFullPath({ route }: { route: { path: string, query: Record<string, string> } }): string {
  const query = new URLSearchParams(route.query).toString();
  return route.path + (query ? `?${query}` : '');
}

function createChat({ rawId }: { rawId: string }): Chat {
  return { id: toChatId({ raw: rawId }), groupId: undefined, title: null, root: { items: [] }, debugEnabled: false, createdAt: 1, updatedAt: 1 };
}

const mockEntryMode = ref<AppEntryMode>('ordinary');
const mockEntryOwner = ref(Symbol('test-entry'));
const mockEntryInteraction = ref<'ready' | 'blocked'>('ready');
const mockStorageCurrent = ref(true);
const mockDiscovery = ref<unknown>();
vi.mock('@/composables/chat/global/chat-core-singletons', async () => {
  const { ref } = await import('vue');
  return { creatingChat: ref(false) };
});
const mockSettings = ref<Pick<Settings, 'endpoint' | 'defaultModelId'>>({ endpoint: { type: 'openai', url: 'http://localhost:11434/v1' }, defaultModelId: 'configured-model' });

vi.mock('@/composables/useAppEntry', () => ({
  useAppEntry: () => {
    const intent = computed(() => {
      const route = useRouter().currentRoute.value;
      return { kind: mockEntryMode.value, owner: mockEntryOwner.value, routePath: route.path, fullPath: route.fullPath, homeOriginId: undefined, input: undefined };
    });
    return {
      intent,
      interaction: mockEntryInteraction,
      discovery: mockDiscovery,
      captureModelLaunchContext: () => {
        const current = intent.value;
        return {
          ...current,
          mode: current.kind,
          isCurrent: () => mockStorageCurrent.value && intent.value.owner === current.owner && intent.value.fullPath === current.fullPath,
        };
      },
    };
  },
}));

const mockAddToast = vi.fn();
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ addToast: mockAddToast }) }));

// Model-launch orchestration is covered with a real router in its composable
// tests. These command tests isolate ownership of the ordinary startup path.
vi.mock('@/features/llama-cpp-browser/composables/useModelLaunchCoordinator', () => ({ useModelLaunchCoordinator: vi.fn() }));

const mockCreateNewChat = vi.fn();
const mockCreateChatForEmptyHistory = vi.fn();
const mockCreateChatGroup = vi.fn();
const mockCurrentChat = ref<Chat | null>(null);
const mockChats = ref<Chat[]>([]);
const mockChatGroups = ref<Array<{ id: string; name: string }>>([]);

vi.mock('@/composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: () => ({
    currentChat: computed(() => mockCurrentChat.value),
    currentChatGroup: computed(() => null),
    currentChatId: computed(() => mockCurrentChat.value?.id),
    activeMessages: computed(() => []),
    allMessages: computed(() => []),
    resolvedSettings: computed(() => null),
    inheritedSettings: computed(() => null),
    chatGroups: computed(() => mockChatGroups.value),
    sidebarItems: computed(() => [
      ...mockChats.value.map(chat => ({ type: 'chat', chat })),
      ...mockChatGroups.value.map(chatGroup => ({ type: 'chat_group', chatGroup })),
    ]),
    TEST_ONLY: {},
  }),
}));

vi.mock('@/composables/chat/ui/useChatListData', () => ({
  useChatListData: () => ({
    chats: mockChats,
  }),
}));

vi.mock('@/composables/chat/ui/useChatLifecycle', () => ({
  useChatLifecycle: () => ({
    createNewChat: mockCreateNewChat,
    createChatForEmptyHistory: mockCreateChatForEmptyHistory,
    deleteChat: vi.fn(),
    deleteAllChats: vi.fn(),
    TEST_ONLY: {},
  }),
}));

vi.mock('@/composables/chat/ui/useChatOrganization', () => ({
  useChatOrganization: () => ({
    createChatGroup: mockCreateChatGroup,
    deleteChatGroup: vi.fn(),
    duplicateChatGroup: vi.fn(),
    renameChatGroup: vi.fn(),
    updateChatGroupMetadata: vi.fn(),
    moveChatToGroup: vi.fn(),
    reorderSidebarChatAfterSend: vi.fn(),
    TEST_ONLY: {},
  }),
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: vi.fn(),
}));

const mockAppInteraction = ref<AppInteraction>('enabled');

vi.mock('@/composables/useAppPresentation', () => ({
  isAppInteractionEnabled: ({ interaction }: { interaction: string }) => interaction === 'enabled',
  useAppPresentation: () => ({
    appInteraction: mockAppInteraction,
  }),
}));

const mockAddRecentChat = vi.fn();
const mockToggleRecent = vi.fn();

vi.mock('@/composables/useRecentChats', () => ({
  useRecentChats: () => ({
    addRecentChat: mockAddRecentChat,
    toggleRecent: mockToggleRecent,
  }),
}));

vi.mock('@/features/global-search/composables/useGlobalSearch', () => ({
  useGlobalSearch: () => ({
    toggleSearch: vi.fn(),
  }),
}));

vi.mock('@/composables/useLayout', () => ({
  useLayout: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRouter: vi.fn(),
  useRoute: vi.fn(),
}));

describe('AppCommandRuntime', () => {
  const currentRoute = reactive<{ path: string; query: Record<string, string> }>({
    path: '/',
    query: {},
  });
  const mockRouterPush = vi.fn<(location: unknown) => unknown>((location) => {
    if (typeof location === 'string') {
      currentRoute.path = location;
      return;
    }
    if (
      typeof location === 'object'
      && location !== null
      && 'path' in location
      && typeof location.path === 'string'
    ) {
      currentRoute.path = location.path;
    }
  });

  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    mockCreateNewChat.mockReset();
    mockCreateNewChat.mockImplementation(async () => {
      const chat = createChat({ rawId: 'default-chat-id' });
      mockCurrentChat.value = chat;
      return chat;
    });
    mockCreateChatGroup.mockReset();
    mockCreateChatForEmptyHistory.mockReset().mockImplementation(async () => {
      const chat = createChat({ rawId: 'automatic-chat-id' });
      mockChats.value = [chat];
      return chat;
    });
    mockCreatingChat.value = false;
    mockDiscovery.value = undefined;
    mockAddRecentChat.mockReset();
    mockToggleRecent.mockReset();
    mockCurrentChat.value = null;
    mockChats.value = [{ id: 'existing' } as unknown as Chat];
    mockChatGroups.value = [];
    currentRoute.path = '/';
    currentRoute.query = {};
    mockAppInteraction.value = 'enabled';
    mockEntryMode.value = 'ordinary';
    mockEntryOwner.value = Symbol('test-entry');
    mockEntryInteraction.value = 'ready';
    mockStorageCurrent.value = true;
    mockSettings.value = { endpoint: { type: 'openai', url: 'http://localhost:11434/v1' }, defaultModelId: 'configured-model' };

    (useSettings as unknown as Mock).mockReturnValue({
      initialized: ref(true),
      isOnboardingDismissed: ref(true),
      settings: mockSettings,
    });

    (useLayout as unknown as Mock).mockReturnValue({
      setActiveFocusArea: vi.fn(),
    });

    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: computed(() => ({ ...currentRoute, fullPath: routeFullPath({ route: currentRoute }) })),
    });
    (useRoute as unknown as Mock).mockReturnValue(currentRoute);
  });

  const mountRuntime = () => mount(AppCommandRuntime);

  it('leaves model-link startup to its coordinator instead of creating or auto-sending an ordinary chat', async () => {
    mockChats.value = [];
    currentRoute.query = { 'llama-cpp-browser-model': 'hf.co/owner/repo:Q4_K_M', q: 'do not auto-send' };
    mountRuntime();
    await flushPromises();
    await nextTick();
    expect(mockCreateNewChat).not.toHaveBeenCalled();
    expect(mockCreateChatGroup).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('creates one real chat from an empty home without selecting it before navigation', async () => {
    mockEntryMode.value = 'home';
    mockChats.value = [];

    mountRuntime();

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).not.toHaveBeenCalled();
    expect(mockCreateChatForEmptyHistory).toHaveBeenCalledOnce();
    expect(mockCurrentChat.value).toBeNull();
    expect(mockRouterPush).toHaveBeenCalledExactlyOnceWith('/chat/automatic-chat-id');
  });

  it('creates one real chat when all chat and chat-group history is cleared', async () => {
    mockEntryMode.value = 'home';
    mockChats.value = [{ id: 'existing-chat' } as unknown as Chat];

    mountRuntime();

    await flushPromises();
    expect(mockCreateNewChat).not.toHaveBeenCalled();

    // Simulate clearing history
    mockChats.value = [];

    await nextTick();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).not.toHaveBeenCalled();
    expect(mockCreateChatForEmptyHistory).toHaveBeenCalledOnce();
    expect(mockRouterPush).toHaveBeenCalledWith('/chat/automatic-chat-id');
  });

  it('creates one real chat when returning to an empty root', async () => {
    mockEntryMode.value = 'home';
    mockChats.value = [];
    const currentRoute = reactive<{ path: string; query: Record<string, string> }>({
      path: '/settings',
      query: {},
    });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: computed(() => ({ ...currentRoute, fullPath: routeFullPath({ route: currentRoute }) })),
    });
    (useRoute as Mock).mockReturnValue(currentRoute);

    mountRuntime();

    await flushPromises();
    // Clear calls from immediate watch execution on mount
    mockCreateNewChat.mockClear();

    // Navigate to root
    currentRoute.path = '/';

    await nextTick();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).not.toHaveBeenCalled();
    expect(mockCreateChatForEmptyHistory).toHaveBeenCalledOnce();
    expect(mockRouterPush).toHaveBeenCalledWith('/chat/automatic-chat-id');
  });

  it('does not seed an empty chat group or seed while the dialog is open or closing', async () => {
    mockEntryMode.value = 'home';
    mockChats.value = [];
    mockChatGroups.value = [{ id: 'empty-chat-group', name: 'Empty' }];
    mountRuntime();
    await flushPromises();
    expect(mockCreateChatForEmptyHistory).not.toHaveBeenCalled();
    mockAppInteraction.value = 'blocked-by-model-selection';
    mockChatGroups.value = [];
    await flushPromises();
    expect(mockCreateChatForEmptyHistory).not.toHaveBeenCalled();
    mockAppInteraction.value = 'enabled';
    await flushPromises();
    expect(mockCreateChatForEmptyHistory).toHaveBeenCalledOnce();
  });

  it('waits for another creator and for the model browser before seeding', async () => {
    mockEntryMode.value = 'home';
    mockChats.value = [];
    mockCreatingChat.value = true;
    mountRuntime();
    await flushPromises();
    expect(mockCreateChatForEmptyHistory).not.toHaveBeenCalled();
    mockDiscovery.value = { tab: 'candidates' };
    mockCreatingChat.value = false;
    await flushPromises();
    expect(mockCreateChatForEmptyHistory).not.toHaveBeenCalled();
    mockDiscovery.value = undefined;
    await flushPromises();
    expect(mockCreateChatForEmptyHistory).toHaveBeenCalledOnce();
  });

  it('keeps a saved automatic chat when its originating page is left during creation', async () => {
    mockEntryMode.value = 'home';
    mockChats.value = [];
    const pending = Promise.withResolvers<Chat>();
    mockCreateChatForEmptyHistory.mockReturnValue(pending.promise);
    mountRuntime();
    await nextTick();
    currentRoute.path = '/chat/newer';
    mockEntryMode.value = 'ordinary';
    const newer = createChat({ rawId: 'newer' });
    mockCurrentChat.value = newer;
    pending.resolve(createChat({ rawId: 'saved-automatic' }));
    await flushPromises();
    expect(mockCurrentChat.value?.id).toBe(newer.id);
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('does not loop after automatic creation fails and retries through the existing action', async () => {
    mockEntryMode.value = 'home';
    mockChats.value = [];
    mockCreateChatForEmptyHistory.mockRejectedValueOnce(new Error('Storage unavailable'));
    using _console = vi.spyOn(console, 'error').mockImplementation(() => {});
    mountRuntime();
    await flushPromises();
    expect(mockCreateChatForEmptyHistory).toHaveBeenCalledOnce();
    expect(mockAddToast).toHaveBeenCalledOnce();
    await mockAddToast.mock.calls[0]![0].onAction();
    await flushPromises();
    expect(mockCreateChatForEmptyHistory).toHaveBeenCalledTimes(2);
    expect(mockRouterPush).toHaveBeenCalledWith('/chat/automatic-chat-id');
  });

  it('automatically creates a new chat and preserves query param when q is present on root path', async () => {
    mockChats.value = [{ id: 'existing' } as unknown as Chat];
    const currentRoute = reactive({ path: '/', query: { q: 'hello' } });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: computed(() => ({ ...currentRoute, fullPath: routeFullPath({ route: currentRoute }) })),
    });
    (useRoute as Mock).mockReturnValue(currentRoute);
    mockCreateNewChat.mockImplementation(async () => {
      mockCurrentChat.value = { id: 'q-chat-id' } as unknown as Chat;
      return mockCurrentChat.value;
    });

    mountRuntime();

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalled();
    expect(mockRouterPush).toHaveBeenCalledWith({
      path: '/chat/q-chat-id',
      query: { q: 'hello' },
    });
  });

  it('automatically creates a new chat in a group when both q and chat-group are present', async () => {
    mockChats.value = [{ id: 'existing' } as unknown as Chat];
    mockChatGroups.value = [{ id: 'group-123', name: 'Existing Group' }];
    const currentRoute = reactive({ path: '/', query: { q: 'hello', 'chat-group': 'group-123' } });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: computed(() => ({ ...currentRoute, fullPath: routeFullPath({ route: currentRoute }) })),
    });
    (useRoute as Mock).mockReturnValue(currentRoute);
    mockCreateNewChat.mockImplementation(async (options) => {
      mockCurrentChat.value = { id: 'grouped-chat-id', groupId: options.groupId } as unknown as Chat;
      return mockCurrentChat.value;
    });

    mountRuntime();

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalledWith({
      groupId: 'group-123',
      modelId: undefined,
      systemPrompt: undefined,
    });
    expect(mockRouterPush).toHaveBeenCalledWith({
      path: '/chat/grouped-chat-id',
      query: { q: 'hello' },
    });
  });

  it('automatically creates a new chat in a group by name when chat-group matches a group name', async () => {
    mockChats.value = [{ id: 'existing' } as unknown as Chat];
    mockChatGroups.value = [{ id: 'group-uuid-123', name: 'Query Group' }];
    const currentRoute = reactive({ path: '/', query: { q: 'hello', 'chat-group': 'Query Group' } });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: computed(() => ({ ...currentRoute, fullPath: routeFullPath({ route: currentRoute }) })),
    });
    (useRoute as Mock).mockReturnValue(currentRoute);
    mockCreateNewChat.mockImplementation(async (options) => {
      mockCurrentChat.value = { id: 'grouped-chat-id', groupId: options.groupId } as unknown as Chat;
      return mockCurrentChat.value;
    });

    mountRuntime();

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalledWith({
      groupId: 'group-uuid-123',
      modelId: undefined,
      systemPrompt: undefined,
    });
  });

  it('automatically creates a new group if chat-group name does not exist', async () => {
    mockChats.value = [{ id: 'existing' } as unknown as Chat];
    mockChatGroups.value = [];
    const currentRoute = reactive({ path: '/', query: { q: 'hello', 'chat-group': 'New Group Name' } });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: computed(() => ({ ...currentRoute, fullPath: routeFullPath({ route: currentRoute }) })),
    });
    (useRoute as Mock).mockReturnValue(currentRoute);
    mockCreateChatGroup.mockResolvedValue('new-group-uuid');
    mockCreateNewChat.mockImplementation(async (options) => {
      mockCurrentChat.value = { id: 'grouped-chat-id', groupId: options.groupId } as unknown as Chat;
      return mockCurrentChat.value;
    });

    mountRuntime();

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockCreateChatGroup).toHaveBeenCalledWith({ name: 'New Group Name', options: undefined });
    expect(mockCreateNewChat).toHaveBeenCalledWith({
      groupId: 'new-group-uuid',
      modelId: undefined,
      systemPrompt: undefined,
    });
  });

  it('automatically creates a new chat with model override when q and model are present', async () => {
    mockChats.value = [{ id: 'existing' } as unknown as Chat];
    const currentRoute = reactive({ path: '/', query: { q: 'hello', model: 'special-model' } });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: computed(() => ({ ...currentRoute, fullPath: routeFullPath({ route: currentRoute }) })),
    });
    (useRoute as Mock).mockReturnValue(currentRoute);
    mockCreateNewChat.mockImplementation(async (options) => {
      mockCurrentChat.value = { id: 'model-chat-id', groupId: options.groupId, modelId: options.modelId } as unknown as Chat;
      return mockCurrentChat.value;
    });

    mountRuntime();

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalledWith({
      groupId: undefined,
      modelId: 'special-model',
      systemPrompt: undefined,
    });
    expect(mockRouterPush).toHaveBeenCalledWith({
      path: '/chat/model-chat-id',
      query: { q: 'hello' },
    });
  });

  it('automatically creates a new chat with system prompt override when system-prompt query is present', async () => {
    mockChats.value = [{ id: 'existing' } as unknown as Chat];
    const currentRoute = reactive({ path: '/', query: { q: 'hello', 'system-prompt': 'You are a helpful assistant' } });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: computed(() => ({ ...currentRoute, fullPath: routeFullPath({ route: currentRoute }) })),
    });
    (useRoute as Mock).mockReturnValue(currentRoute);
    mockCreateNewChat.mockImplementation(async (options) => {
      mockCurrentChat.value = { id: 'sp-chat-id', systemPrompt: options.systemPrompt } as unknown as Chat;
      return mockCurrentChat.value;
    });

    mountRuntime();

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalledWith({
      groupId: undefined,
      modelId: undefined,
      systemPrompt: { behavior: 'override', content: 'You are a helpful assistant' },
    });
    expect(mockRouterPush).toHaveBeenCalledWith({
      path: '/chat/sp-chat-id',
      query: { q: 'hello' },
    });
  });

  it('does NOT create a new chat when system-prompt is present but q is missing', async () => {
    mockChats.value = [{ id: 'existing' } as unknown as Chat];
    const currentRoute = reactive({ path: '/', query: { 'system-prompt': 'You are a cat' } });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: computed(() => ({ ...currentRoute, fullPath: routeFullPath({ route: currentRoute }) })),
    });
    (useRoute as unknown as Mock).mockReturnValue(currentRoute);

    mountRuntime();
    await flushPromises();

    expect(mockCreateNewChat).not.toHaveBeenCalled();
  });

  it('keeps the root without a chat when system-prompt is specified without q', async () => {
    mockChats.value = [];
    const currentRoute = reactive({ path: '/', query: { 'system-prompt': 'You are a cat' } });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: computed(() => ({ ...currentRoute, fullPath: routeFullPath({ route: currentRoute }) })),
    });
    (useRoute as unknown as Mock).mockReturnValue(currentRoute);

    mountRuntime();
    await flushPromises();

    expect(mockCreateNewChat).not.toHaveBeenCalled();
  });

  it('automatically creates a new chat with system prompt override when sp query is present', async () => {
    mockChats.value = [{ id: 'existing' } as unknown as Chat];
    const currentRoute = reactive({ path: '/', query: { q: 'hello', sp: 'Be concise' } });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: computed(() => ({ ...currentRoute, fullPath: routeFullPath({ route: currentRoute }) })),
    });
    (useRoute as Mock).mockReturnValue(currentRoute);
    mockCreateNewChat.mockImplementation(async (options) => {
      mockCurrentChat.value = { id: 'sp-alias-id', systemPrompt: options.systemPrompt } as unknown as Chat;
      return mockCurrentChat.value;
    });

    mountRuntime();

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalledWith({
      groupId: undefined,
      modelId: undefined,
      systemPrompt: { behavior: 'override', content: 'Be concise' },
    });
  });

  it('triggers createNewChat and navigates on Ctrl+Shift+O', async () => {
    mockCreateNewChat.mockImplementation(async () => {
      mockCurrentChat.value = { id: 'new-chat-id' } as unknown as Chat;
      return mockCurrentChat.value;
    });

    mountRuntime();
    await flushPromises();

    // Simulate Ctrl+Shift+O
    const event = new KeyboardEvent('keydown', {
      key: 'o',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
    });
    window.dispatchEvent(event);

    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalledWith({
      groupId: undefined,
      modelId: undefined,
      systemPrompt: undefined,
    });
    expect(mockRouterPush).toHaveBeenCalledWith('/chat/new-chat-id');
  });

  it('triggers createNewChat and navigates on Meta+Shift+O (Mac)', async () => {
    mockCreateNewChat.mockImplementation(async () => {
      mockCurrentChat.value = { id: 'mac-chat-id' } as unknown as Chat;
      return mockCurrentChat.value;
    });

    mountRuntime();
    await flushPromises();

    // Simulate Meta+Shift+O (Cmd on Mac)
    const event = new KeyboardEvent('keydown', {
      key: 'o',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
    });
    window.dispatchEvent(event);

    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalledWith({
      groupId: undefined,
      modelId: undefined,
      systemPrompt: undefined,
    });
    expect(mockRouterPush).toHaveBeenCalledWith('/chat/mac-chat-id');
  });

  it('triggers toggleRecent on Ctrl+P', async () => {
    // Reset the mock before use
    mockToggleRecent.mockReset();

    // Re-mount the runtime after resetting the mock
    mountRuntime();
    await flushPromises();

    // Simulate Ctrl+P
    const event = new KeyboardEvent('keydown', {
      key: 'p',
      ctrlKey: true,
      bubbles: true,
    });
    window.dispatchEvent(event);

    await nextTick();
    expect(mockToggleRecent).toHaveBeenCalled();
  });

  it.each(['home', 'model-preview'] as const)('keeps %s free from ordinary query and chat creation even after settings change', async (mode) => {
    mockEntryMode.value = mode;
    mockChats.value = [];
    currentRoute.query = { q: 'hello', 'chat-group': 'do not create', model: 'override', sp: 'do not apply' };
    mountRuntime();
    await flushPromises();
    mockSettings.value = { endpoint: { type: 'llama_cpp_browser' }, defaultModelId: 'newly-configured-model' };
    await flushPromises();
    expect(mockCreateNewChat).not.toHaveBeenCalled();
    expect(mockCreateChatGroup).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it.each(['/', '/home', '/chat/saved', '/image-generation'])('gives a present model-entry key priority over ordinary queries at %s', async (path) => {
    currentRoute.path = path;
    currentRoute.query = { 'llama-cpp-browser-model': '', q: 'do not send', 'chat-group': 'do not create', model: 'override', sp: 'do not apply' };
    mockChats.value = [];
    mountRuntime();
    await flushPromises();
    expect(mockCreateNewChat).not.toHaveBeenCalled();
    expect(mockCreateChatGroup).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('does not create a root chat from configured settings or the legacy dismissed flag', async () => {
    mockChats.value = [];
    (useSettings as unknown as Mock).mockReturnValue({ initialized: ref(true), settings: mockSettings, isOnboardingDismissed: ref(false) });
    mountRuntime();
    await flushPromises();
    expect(mockCreateNewChat).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('preserves existing history on an ordinary root visit', async () => {
    mountRuntime();
    await flushPromises();
    expect(mockCreateNewChat).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('does not create a chat as a side effect of configuring a global model', async () => {
    mockChats.value = [];
    mockSettings.value = { endpoint: { type: 'openai', url: '' }, defaultModelId: undefined };
    mountRuntime();
    await flushPromises();
    expect(mockCreateNewChat).not.toHaveBeenCalled();
    mockSettings.value = { endpoint: { type: 'openai', url: 'http://localhost:11434/v1' }, defaultModelId: 'selected' };
    await flushPromises();
    expect(mockCreateNewChat).not.toHaveBeenCalled();
  });

  it('keeps a q-only visit on the ordinary draft and auto-send route without requiring global selection', async () => {
    mockSettings.value = { endpoint: { type: 'openai', url: '' }, defaultModelId: undefined };
    currentRoute.query = { q: 'preserve this draft' };
    mountRuntime();
    await flushPromises();
    expect(mockCreateNewChat).toHaveBeenCalledWith({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    expect(mockRouterPush).toHaveBeenCalledWith({ path: '/chat/default-chat-id', query: { q: 'preserve this draft' } });
  });

  it('waits for entry readiness before starting the ordinary command', async () => {
    currentRoute.query = { q: 'draft' };
    mockChats.value = [];
    mockEntryInteraction.value = 'blocked';
    mountRuntime();
    await flushPromises();
    expect(mockCreateNewChat).not.toHaveBeenCalled();
    mockEntryInteraction.value = 'ready';
    await flushPromises();
    expect(mockCreateNewChat).toHaveBeenCalledTimes(1);
  });

  it('keeps creation single-flight when history and settings change during a pending command', async () => {
    const creating = Promise.withResolvers<Chat>();
    const chat = createChat({ rawId: 'single-flight' });
    using _cleanup = {
      [Symbol.dispose]() {
        creating.resolve(chat);
      },
    };
    currentRoute.query = { q: 'draft' };
    mockChats.value = [];
    mockCreateNewChat.mockReturnValueOnce(creating.promise);
    mountRuntime();
    await flushPromises();
    mockChats.value = [createChat({ rawId: 'restored' })];
    await nextTick();
    mockChats.value = [];
    mockSettings.value = { ...mockSettings.value, defaultModelId: 'changed-model' };
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, shiftKey: true }));
    await flushPromises();
    expect(mockCreateNewChat).toHaveBeenCalledTimes(1);
    mockCurrentChat.value = chat;
    creating.resolve(chat);
    await flushPromises();
    expect(mockCreateNewChat).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith({ path: '/chat/single-flight', query: { q: 'draft' } });
  });

  it('does not continue a delayed group command after leaving its route', async () => {
    const creating = Promise.withResolvers<string>();
    using _cleanup = {
      [Symbol.dispose]() {
        creating.resolve('late-group');
      },
    };
    currentRoute.query = { q: 'hello', 'chat-group': 'New Group' };
    mockCreateChatGroup.mockReturnValueOnce(creating.promise);
    mountRuntime();
    await flushPromises();
    currentRoute.path = '/settings';
    creating.resolve('late-group');
    await flushPromises();
    expect(mockCreateNewChat).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('does not navigate after an automatic chat finishes on an abandoned route', async () => {
    const creating = Promise.withResolvers<Chat>();
    const chat = createChat({ rawId: 'late-automatic' });
    using _cleanup = {
      [Symbol.dispose]() {
        creating.resolve(chat);
      },
    };
    currentRoute.query = { q: 'draft' };
    mockChats.value = [];
    mockCreateNewChat.mockReturnValueOnce(creating.promise);
    mountRuntime();
    await flushPromises();
    currentRoute.path = '/settings';
    mockCurrentChat.value = chat;
    creating.resolve(chat);
    await flushPromises();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('retries navigation with the created chat without creating it again after navigation fails', async () => {
    using _consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    currentRoute.query = { q: 'draft' };
    mockChats.value = [];
    mockRouterPush.mockImplementationOnce(() => Promise.resolve({ type: 4 }));
    mountRuntime();
    await flushPromises();
    expect(mockCreateNewChat).toHaveBeenCalledTimes(1);
    expect(mockAddToast).toHaveBeenCalledTimes(1);
    expect(mockAddToast.mock.calls[0]?.[0]).toMatchObject({ message: 'Could not create the chat.', actionLabel: 'Retry' });
    mockChats.value = [createChat({ rawId: 'default-chat-id' })];
    await nextTick();
    mockChats.value = [];
    await flushPromises();
    expect(mockCreateNewChat).toHaveBeenCalledTimes(1);
    await mockAddToast.mock.calls[0]?.[0].onAction();
    await flushPromises();
    expect(mockCreateNewChat).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledTimes(2);
    expect(mockRouterPush).toHaveBeenLastCalledWith({ path: '/chat/default-chat-id', query: { q: 'draft' } });
  });

  it('retries an automatic saved chat navigation without rechecking empty history or creating another chat', async () => {
    using _consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockEntryMode.value = 'home';
    mockChats.value = [];
    mockRouterPush.mockImplementationOnce(() => Promise.resolve({ type: 4 }));
    mountRuntime();
    await flushPromises();
    expect(mockCreateChatForEmptyHistory).toHaveBeenCalledOnce();
    expect(mockChats.value).toHaveLength(1);
    expect(mockCurrentChat.value).toBeNull();
    expect(currentRoute.path).toBe('/');
    expect(mockAddToast).toHaveBeenCalledOnce();
    await mockAddToast.mock.calls[0]?.[0].onAction();
    await flushPromises();
    expect(mockCreateChatForEmptyHistory).toHaveBeenCalledOnce();
    expect(mockCreateNewChat).not.toHaveBeenCalled();
    expect(mockRouterPush).toHaveBeenCalledTimes(2);
    expect(mockRouterPush).toHaveBeenLastCalledWith('/chat/automatic-chat-id');
    expect(mockChats.value).toHaveLength(1);
  });

  it('does not loop after creation fails and allows an explicit retry of the same operation', async () => {
    using _consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    currentRoute.query = { q: 'draft' };
    mockChats.value = [];
    mockCreateNewChat.mockRejectedValueOnce(new Error('Storage unavailable'));
    mountRuntime();
    await flushPromises();
    mockSettings.value = { ...mockSettings.value, defaultModelId: 'still-configured' };
    await flushPromises();
    expect(mockCreateNewChat).toHaveBeenCalledTimes(1);
    expect(mockAddToast).toHaveBeenCalledTimes(1);
    await mockAddToast.mock.calls[0]?.[0].onAction();
    await flushPromises();
    expect(mockCreateNewChat).toHaveBeenCalledTimes(2);
    expect(mockRouterPush).toHaveBeenCalledWith({ path: '/chat/default-chat-id', query: { q: 'draft' } });
  });

  it.each(['owner', 'route', 'storage'] as const)('does not renew an old retry after its %s changes', async (changed) => {
    using _consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    currentRoute.query = { q: 'draft' };
    mockChats.value = [];
    mockCreateNewChat.mockRejectedValueOnce(new Error('Storage unavailable'));
    mountRuntime();
    await flushPromises();
    const retry = mockAddToast.mock.calls[0]?.[0].onAction;
    mockEntryMode.value = 'home';
    switch (changed) {
    case 'owner': mockEntryOwner.value = Symbol('new-owner');
      break;
    case 'route': currentRoute.path = '/settings';
      break;
    case 'storage': mockStorageCurrent.value = false;
      break;
    default: {
      const exhaustive: never = changed;
      throw new Error(String(exhaustive));
    }
    }
    await retry();
    await flushPromises();
    expect(mockCreateNewChat).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('does not resume a failed command after a newer explicit command has replaced it', async () => {
    using _consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    currentRoute.query = { q: 'draft' };
    mockChats.value = [];
    mockCreateNewChat.mockRejectedValueOnce(new Error('First failure')).mockRejectedValueOnce(new Error('Second failure'));
    mountRuntime();
    await flushPromises();
    const oldRetry = mockAddToast.mock.calls[0]?.[0].onAction;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, shiftKey: true }));
    await flushPromises();
    expect(mockCreateNewChat).toHaveBeenCalledTimes(2);
    await oldRetry();
    await flushPromises();
    expect(mockCreateNewChat).toHaveBeenCalledTimes(2);
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('uses the returned chat and does not navigate to a different global current chat after explicit New', async () => {
    const created = createChat({ rawId: 'created' });
    mockCreateNewChat.mockImplementationOnce(async () => {
      mockCurrentChat.value = createChat({ rawId: 'selected-by-someone-else' });
      return created;
    });
    mountRuntime();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, shiftKey: true }));
    await flushPromises();
    expect(mockCreateNewChat).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it.each(['owner', 'route', 'storage'] as const)('does not let a delayed explicit New take over after its %s changes', async (changed) => {
    const creating = Promise.withResolvers<Chat>();
    const chat = createChat({ rawId: 'late-manual' });
    using _cleanup = {
      [Symbol.dispose]() {
        creating.resolve(chat);
      },
    };
    mockCreateNewChat.mockReturnValueOnce(creating.promise);
    mountRuntime();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, shiftKey: true }));
    await flushPromises();
    switch (changed) {
    case 'owner': mockEntryOwner.value = Symbol('new-owner');
      break;
    case 'route': currentRoute.path = '/settings';
      break;
    case 'storage': mockStorageCurrent.value = false;
      break;
    default: {
      const exhaustive: never = changed;
      throw new Error(String(exhaustive));
    }
    }
    mockCurrentChat.value = chat;
    creating.resolve(chat);
    await flushPromises();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('does not navigate after the command runtime unmounts during explicit New', async () => {
    const creating = Promise.withResolvers<Chat>();
    const chat = createChat({ rawId: 'unmounted' });
    using _cleanup = {
      [Symbol.dispose]() {
        creating.resolve(chat);
      },
    };
    mockCreateNewChat.mockReturnValueOnce(creating.promise);
    const wrapper = mountRuntime();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, shiftKey: true }));
    await flushPromises();
    wrapper.unmount();
    mockCurrentChat.value = chat;
    creating.resolve(chat);
    await flushPromises();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });
});
