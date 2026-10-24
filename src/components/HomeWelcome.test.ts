import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, ref, shallowRef } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Chat, type ChatGroup, type ChatSummary, type Settings } from '@/01-models/types';
import { toChatGroupId, toChatId } from '@/01-models/ids';
import type { ModelLaunchAppContext } from '@/composables/useAppEntry';
import { provideAppPresentation } from '@/composables/useAppPresentation';
import type { StartupState } from '@/logic/startup/types';
import { setLocale } from '@/strings';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import HomeWelcome from './HomeWelcome.vue';

enableAutoUnmount(afterEach);
const create = vi.fn<() => Promise<Chat | null>>();
const selectingCreate = vi.fn();
const selectModel = vi.fn();
const finishIntroduction = vi.fn();
const setFocus = vi.fn();
const chats = ref<ChatSummary[]>([]);
const chatGroups = ref<ChatGroup[]>([]);
const settings = ref<Settings>({ ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: '' } });
const interaction = ref<'ready' | 'blocked'>('ready');
const modelVisible = ref(false);
const storageRevision = ref(0);
const owner = shallowRef(Symbol('home'));
let router: Router;

vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings }) }));
vi.mock('@/composables/chat/ui/useChatListData', () => ({ useChatListData: () => ({ chats }) }));
vi.mock('@/composables/chat/ui/useCurrentChatState', () => ({ useCurrentChatState: () => ({ chatGroups }) }));
vi.mock('@/composables/chat/ui/useChatLifecycle', () => ({ useChatLifecycle: () => ({ createChatWithoutSelecting: create, createNewChat: selectingCreate }) }));
vi.mock('@/composables/useDocumentMetadata', () => ({ useDocumentMetadata: () => ({ finishHomeIntroduction: finishIntroduction }) }));
vi.mock('@/composables/useLayout', () => ({ useLayout: () => ({ setActiveFocusArea: setFocus }) }));
vi.mock('@/composables/useAppEntry', () => ({
  useAppEntry: () => ({
    interaction,
    homeSelection: ref({ suggestionId: 'gemma-4-e2b', quantizationId: 'qat-q4_0' }),
    openModelSelection: selectModel,
    captureModelLaunchContext(): ModelLaunchAppContext {
      const capturedOwner = owner.value;
      const revision = storageRevision.value;
      const currentRouter = router;
      const fullPath = currentRouter.currentRoute.value.fullPath;
      return {
        owner: capturedOwner,
        homeOriginId: 'home',
        mode: 'home',
        fullPath,
        routePath: '/',
        isCurrent: () => owner.value === capturedOwner && storageRevision.value === revision && currentRouter.currentRoute.value.fullPath === fullPath,
      };
    },
  }),
}));

function savedChat(): Chat {
  return { id: toChatId({ raw: 'saved' }), title: null, root: { items: [] }, createdAt: 1, updatedAt: 1, debugEnabled: false };
}

function summary({ id, updatedAt, groupId, title }: { id: string, updatedAt: number, groupId: ChatSummary['groupId'], title: string | null }): ChatSummary {
  return { id: toChatId({ raw: id }), updatedAt, groupId, title };
}

function chatGroup({ id, updatedAt }: { id: string, updatedAt: number }): ChatGroup {
  return { id: toChatGroupId({ raw: id }), name: id, updatedAt, isCollapsed: false, items: [] };
}

async function renderHome() {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/chat/:id', name: 'chat', component: { template: '<div />' } },
      { path: '/chat-group/:id', component: { template: '<div />' } },
    ],
  });
  await router.push('/');
  const host = defineComponent({
    setup() {
      provideAppPresentation({ startupState: shallowRef<StartupState>({ kind: 'ready', mainApp: HomeWelcome }), modelSelectionVisible: modelVisible });
      return () => h(HomeWelcome);
    },
  });
  const view = mount(host, { attachTo: document.body, global: { plugins: [router], stubs: { LanguageSelector: true } } });
  await flushPromises();
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('__BUILD_MODE_IS_HOSTED__', true);
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date(2026, 9, 24, 12));
  create.mockReset().mockResolvedValue(savedChat());
  chats.value = [];
  chatGroups.value = [];
  settings.value = { ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: '' } };
  interaction.value = 'ready';
  modelVisible.value = false;
  storageRevision.value = 0;
  owner.value = Symbol('home');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('home welcome', () => {
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
  });

  it('shows the newest three real summaries, including chat-group members, without starting work', async () => {
    using fetch = vi.spyOn(globalThis, 'fetch');
    chatGroups.value = [chatGroup({ id: 'Research', updatedAt: 1 })];
    chats.value = [
      summary({ id: 'old', title: 'Old', updatedAt: 1, groupId: undefined }),
      summary({ id: 'newest', title: 'Newest', updatedAt: Date.now(), groupId: chatGroups.value[0]!.id }),
      summary({ id: 'third', title: null, updatedAt: 3, groupId: undefined }),
      summary({ id: 'second', title: 'Second', updatedAt: 4, groupId: undefined }),
    ];
    const view = await renderHome();
    const rows = view.findAll('[data-testid="home-recent-chat"]');
    expect(rows.map(row => row.attributes('href'))).toEqual(['/chat/newest', '/chat/second', '/chat/third']);
    expect(rows[0]!.text()).toContain('Research');
    expect(rows[2]!.text()).toContain('New Chat');
    expect(chats.value.map(chat => chat.id)).toEqual(['old', 'newest', 'third', 'second']);
    expect(view.find('[data-testid="home-chat-group"]').exists()).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(selectingCreate).not.toHaveBeenCalled();
    expect(selectModel).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('offers existing chat groups when there are no chats, without creating a chat', async () => {
    chatGroups.value = [1, 4, 2, 3].map(updatedAt => chatGroup({ id: String(updatedAt), updatedAt }));
    const view = await renderHome();
    expect(view.findAll('[data-testid="home-chat-group"]').map(row => row.attributes('href'))).toEqual(['/chat-group/4', '/chat-group/3', '/chat-group/2']);
    expect(create).not.toHaveBeenCalled();
  });

  it('leaves empty-history creation to the existing application owner', async () => {
    const view = await renderHome();
    expect(view.find('[data-testid="home-recent-chat"]').exists()).toBe(false);
    expect(view.find('[data-testid="home-chat-group"]').exists()).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('saves one root chat without selecting it early, then opens its saved URL', async () => {
    const pending = Promise.withResolvers<Chat | null>();
    create.mockReturnValueOnce(pending.promise);
    const view = await renderHome();
    await view.get('[data-testid="home-new-chat"]').trigger('click');
    await flushPromises();
    await view.get('[data-testid="home-new-chat"]').trigger('click');
    expect(create).toHaveBeenCalledExactlyOnceWith({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    expect(selectingCreate).not.toHaveBeenCalled();
    expect(router.currentRoute.value.path).toBe('/');
    expect(setFocus).not.toHaveBeenCalled();
    expect(view.get('[data-testid="home-welcome"]').attributes('inert')).toBeUndefined();
    pending.resolve(savedChat());
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/chat/saved');
    expect(setFocus).toHaveBeenCalledExactlyOnceWith({ area: 'chat' });
  });

  it('reports a busy creator and allows a later explicit retry', async () => {
    using _log = vi.spyOn(console, 'error').mockImplementation(() => {});
    create.mockResolvedValueOnce(null);
    const view = await renderHome();
    await view.get('[data-testid="home-new-chat"]').trigger('click');
    await flushPromises();
    expect(view.get('[data-testid="home-creation-error"]').text()).toContain('Could not create');
    expect(view.get('[data-testid="home-new-chat"]').attributes('disabled')).toBeUndefined();
    await view.get('[data-testid="home-new-chat"]').trigger('click');
    await flushPromises();
    expect(create).toHaveBeenCalledTimes(2);
    expect(router.currentRoute.value.path).toBe('/chat/saved');
  });

  it('opens the saved chat after its page finishes loading in the same storage context', async () => {
    const view = await renderHome();
    const page = Promise.withResolvers<{ template: string }>();
    const loadPage = vi.fn(() => page.promise);
    router.addRoute({ path: '/chat/:id', name: 'chat', component: loadPage });
    await view.get('[data-testid="home-new-chat"]').trigger('click');
    await flushPromises();
    expect(loadPage).toHaveBeenCalledOnce();
    expect(router.currentRoute.value.path).toBe('/');
    expect(setFocus).not.toHaveBeenCalled();
    page.resolve({ template: '<div />' });
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/chat/saved');
    expect(finishIntroduction).toHaveBeenCalledOnce();
    expect(setFocus).toHaveBeenCalledExactlyOnceWith({ area: 'chat' });
  });

  it('cancels navigation if storage changes while the saved chat page is loading', async () => {
    const view = await renderHome();
    const page = Promise.withResolvers<{ template: string }>();
    const loadPage = vi.fn(() => page.promise);
    router.addRoute({ path: '/chat/:id', name: 'chat', component: loadPage });
    await view.get('[data-testid="home-new-chat"]').trigger('click');
    await flushPromises();
    expect(loadPage).toHaveBeenCalledOnce();
    expect(router.currentRoute.value.path).toBe('/');
    storageRevision.value++;
    page.resolve({ template: '<div />' });
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/');
    expect(finishIntroduction).not.toHaveBeenCalled();
    expect(setFocus).not.toHaveBeenCalled();
    expect(view.find('[data-testid="home-creation-error"]').exists()).toBe(false);
    // A later explicit navigation remains independent of the completed operation.
    await router.push('/chat/saved');
    expect(router.currentRoute.value.path).toBe('/chat/saved');
  });

  it('allows a newer explicit navigation to the same ID while the saved chat page is loading', async () => {
    const view = await renderHome();
    const page = Promise.withResolvers<{ template: string }>();
    const loadPage = vi.fn(() => page.promise);
    router.addRoute({ path: '/chat/:id', name: 'chat', component: loadPage });
    await view.get('[data-testid="home-new-chat"]').trigger('click');
    await flushPromises();
    expect(loadPage).toHaveBeenCalledOnce();
    storageRevision.value++;
    const navigation = router.push('/chat/saved');
    await flushPromises();
    page.resolve({ template: '<div />' });
    expect(await navigation).toBeUndefined();
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/chat/saved');
    expect(finishIntroduction).not.toHaveBeenCalled();
    expect(setFocus).not.toHaveBeenCalled();
  });

  it('retries the saved chat after navigation fails instead of creating another', async () => {
    using _log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = await renderHome();
    let preventNavigation = true;
    router.beforeEach(to => to.path === '/chat/saved' && preventNavigation ? false : undefined);
    await view.get('[data-testid="home-new-chat"]').trigger('click');
    await flushPromises();
    expect(view.get('[data-testid="home-creation-error"]').text()).toContain('Could not open');
    preventNavigation = false;
    await view.get('[data-testid="home-new-chat"]').trigger('click');
    await flushPromises();
    expect(create).toHaveBeenCalledOnce();
    expect(router.currentRoute.value.path).toBe('/chat/saved');
  });

  it('does not reuse a saved ID after changing storage', async () => {
    using _log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = await renderHome();
    router.beforeEach(to => to.path === '/chat/saved' ? false : undefined);
    await view.get('[data-testid="home-new-chat"]').trigger('click');
    await flushPromises();
    storageRevision.value++;
    create.mockResolvedValueOnce({ ...savedChat(), id: toChatId({ raw: 'new-storage' }) });
    await view.get('[data-testid="home-new-chat"]').trigger('click');
    await flushPromises();
    expect(create).toHaveBeenCalledTimes(2);
    expect(router.currentRoute.value.path).toBe('/chat/new-storage');
  });

  it('does not navigate back after another chat is opened during a save', async () => {
    const pending = Promise.withResolvers<Chat | null>();
    create.mockReturnValueOnce(pending.promise);
    const view = await renderHome();
    await view.get('[data-testid="home-new-chat"]').trigger('click');
    await flushPromises();
    await router.push('/chat/other');
    pending.resolve(savedChat());
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/chat/other');
    expect(setFocus).not.toHaveBeenCalled();
  });

  it('does not navigate after unmounting while a save is pending', async () => {
    const pending = Promise.withResolvers<Chat | null>();
    create.mockReturnValueOnce(pending.promise);
    const view = await renderHome();
    await view.get('[data-testid="home-new-chat"]').trigger('click');
    await flushPromises();
    view.unmount();
    pending.resolve(savedChat());
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/');
    expect(setFocus).not.toHaveBeenCalled();
  });

  it('does not navigate with a save completed in an old storage context', async () => {
    const pending = Promise.withResolvers<Chat | null>();
    create.mockReturnValueOnce(pending.promise);
    const view = await renderHome();
    await view.get('[data-testid="home-new-chat"]').trigger('click');
    await flushPromises();
    storageRevision.value++;
    pending.resolve(savedChat());
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/');
    expect(setFocus).not.toHaveBeenCalled();
  });

  it('keeps startup and modal interaction gates, and explicitly opens home model selection', async () => {
    const view = await renderHome();
    interaction.value = 'blocked';
    await flushPromises();
    expect(view.get('[data-testid="home-welcome"]').attributes('inert')).toBeDefined();
    await view.get('[data-testid="home-new-chat"]').trigger('click');
    expect(create).not.toHaveBeenCalled();
    interaction.value = 'ready';
    modelVisible.value = true;
    await flushPromises();
    expect(view.get('[data-testid="open-model-welcome"]').attributes('disabled')).toBeDefined();
    modelVisible.value = false;
    await flushPromises();
    await view.get('[data-testid="open-model-welcome"]').trigger('click');
    expect(selectModel).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'home' } }));
  });

  it('distinguishes memory storage and opens portable instructions only on request', async () => {
    settings.value.storageType = 'memory';
    const view = await renderHome();
    expect(view.text()).toContain('cleared when you reload this page');
    const info = view.get('[data-testid="portable-html-info"]');
    const details = () => view.get('#' + info.attributes('aria-controls'));
    expect(info.attributes('aria-expanded')).toBe('false');
    expect(details().attributes('aria-hidden')).toBe('true');
    await info.trigger('click');
    expect(info.attributes('aria-expanded')).toBe('true');
    expect(details().findAll('li')).toHaveLength(2);
    expect(details().text()).toContain('file://');
    expect(details().text()).toContain('HTTP server');
    await info.trigger('click');
    expect(details().attributes('inert')).toBeDefined();
  });

  it('updates today at the next local midnight and disposes its calendar timer', async () => {
    chats.value = [summary({ id: 'today', title: 'Current', updatedAt: Date.now(), groupId: undefined })];
    const view = await renderHome();
    expect(view.get('time').text()).toBe('today');
    const nextMidnight = new Date(2026, 9, 25).getTime();
    await vi.advanceTimersByTimeAsync(nextMidnight - Date.now());
    expect(view.get('time').text()).toBe('yesterday');
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes the calendar after a hidden page returns without polling in the background', async () => {
    using visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    chats.value = [summary({ id: 'today', title: 'Current', updatedAt: Date.now(), groupId: undefined })];
    const view = await renderHome();
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(new Date(2026, 9, 25, 12));
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(view.get('time').text()).toBe('yesterday');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('does not offer a hosted ZIP download inside the portable edition', async () => {
    vi.stubGlobal('__BUILD_MODE_IS_HOSTED__', false);
    const view = await renderHome();
    expect(view.find('[data-testid="portable-html-download"]').exists()).toBe(false);
    expect(view.find('[data-testid="portable-html-info"]').exists()).toBe(false);
  });
});

describe('home language changes', () => {
  it('updates the actual string boundary, stored error state, and date formatter together', async () => {
    using _log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await setLocale({ locale: 'en' });
    chats.value = [summary({ id: 'today', title: 'Current', updatedAt: Date.now(), groupId: undefined })];
    create.mockRejectedValueOnce(new Error('storage unavailable'));
    const view = await renderHome();
    await view.get('[data-testid="home-new-chat"]').trigger('click');
    await flushPromises();
    expect(view.get('[data-testid="home-creation-error"]').text()).toContain('Could not create');
    expect(view.get('time').text()).toBe('today');
    await setLocale({ locale: 'ja' });
    await flushPromises();
    expect(view.get('[data-testid="home-new-chat"]').text()).toBe('新しいチャットを始める');
    expect(view.get('[data-testid="home-creation-error"]').text()).toContain('チャットを作成できませんでした');
    expect(view.get('time').text()).toBe('今日');
    expect(view.get('[data-testid="portable-html-download"]').text()).toContain('ポータブルHTML版');
  });
});
