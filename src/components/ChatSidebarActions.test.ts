import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { toChatGroupId, toChatId, type ChatGroupId, type ChatId } from '@/01-models/ids';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ChatSidebarActions from './ChatSidebarActions.vue';

const currentChat = ref<{ id: ChatId, groupId?: ChatGroupId }>();
const currentChatGroup = ref<{ id: ChatGroupId, name: string }>();
const mocks = vi.hoisted(() => ({ createNewChat: vi.fn(), openSearch: vi.fn(), finishHome: vi.fn(), setFocus: vi.fn() }));
vi.mock('@/composables/chat/ui/useCurrentChatState', () => ({ useCurrentChatState: () => ({ currentChat, currentChatGroup }) }));
vi.mock('@/composables/chat/ui/useChatLifecycle', () => ({ useChatLifecycle: () => ({ createNewChat: mocks.createNewChat }) }));
vi.mock('@/composables/useDocumentMetadata', () => ({ useDocumentMetadata: () => ({ finishHomeIntroduction: mocks.finishHome }) }));
vi.mock('@/composables/useLayout', () => ({ useLayout: () => ({ setActiveFocusArea: mocks.setFocus }) }));
vi.mock('@/features/global-search/composables/useGlobalSearch', () => ({ useGlobalSearch: () => ({ openSearch: mocks.openSearch }) }));

beforeEach(async () => {
  vi.clearAllMocks();
  currentChat.value = undefined;
  currentChatGroup.value = undefined;
  mocks.createNewChat.mockImplementation(async ({ groupId }: { groupId: ChatGroupId | undefined }) => {
    currentChat.value = { id: toChatId({ raw: 'created-chat' }), groupId };
    return currentChat.value;
  });
  await ensureAllStringsForTest({ locale: 'en' });
});

async function fixture({ expanded, contentReady }: { expanded: boolean, contentReady: boolean }) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] });
  await router.push('/');
  await router.isReady();
  const wrapper = mount(ChatSidebarActions, { props: { expanded, contentReady }, global: { plugins: [router] } });
  return {
    wrapper,
    router,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('Chat sidebar primary actions', () => {
  it('creates and selects a new chat and opens search before the body is ready', async () => {
    using f = await fixture({ expanded: true, contentReady: false });
    const create = f.wrapper.get('[data-testid="new-chat-button"]');
    expect(create.attributes('aria-label')).toMatch(/New Chat.*(?:Ctrl\+Shift\+O|⌘⇧O)/);
    await create.trigger('click');
    await flushPromises();
    expect(mocks.createNewChat).toHaveBeenCalledExactlyOnceWith({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    expect(mocks.finishHome).toHaveBeenCalledOnce();
    expect(mocks.setFocus).toHaveBeenCalledExactlyOnceWith({ area: 'chat' });
    expect(f.router.currentRoute.value.path).toBe('/chat/created-chat');
    const search = f.wrapper.get('[data-testid="search-button"]');
    expect(search.attributes('aria-label')).toBeTruthy();
    await search.trigger('click');
    expect(mocks.openSearch).toHaveBeenCalledExactlyOnceWith({});
  });

  it('enables the chat group form request only after the body is ready', async () => {
    using f = await fixture({ expanded: true, contentReady: false });
    const create = f.wrapper.get('[data-testid="create-chat-group-button"]');
    expect(create.attributes('disabled')).toBeDefined();
    await create.trigger('click');
    expect(f.wrapper.emitted('createChatGroup')).toBeUndefined();
    await f.wrapper.setProps({ contentReady: true });
    expect(create.attributes('disabled')).toBeUndefined();
    await create.trigger('click');
    expect(f.wrapper.emitted('createChatGroup')).toEqual([[]]);
    expect(mocks.createNewChat).not.toHaveBeenCalled();
  });

  it.each(['chat', 'chat-group'] as const)('creates in the current %s context when collapsed', async context => {
    const groupId = toChatGroupId({ raw: 'group-a' });
    switch (context) {
    case 'chat': currentChat.value = { id: toChatId({ raw: 'previous-chat' }), groupId };
      break;
    case 'chat-group': currentChatGroup.value = { id: groupId, name: 'Group A' };
      break;
    default: {
      const exhaustive: never = context;
      throw new Error(String(exhaustive));
    }
    }
    using f = await fixture({ expanded: false, contentReady: true });
    const create = f.wrapper.get('[data-testid="new-chat-in-group-button"]');
    expect(create.attributes('aria-label')).toBeTruthy();
    expect(create.text()).toBe('');
    await create.trigger('click');
    await flushPromises();
    expect(mocks.createNewChat).toHaveBeenCalledExactlyOnceWith({ groupId, modelId: undefined, systemPrompt: undefined });
    expect(f.router.currentRoute.value.path).toBe('/chat/created-chat');
  });

  it('keeps ungrouped creation available without exposing a group action outside a group', async () => {
    using f = await fixture({ expanded: false, contentReady: true });
    expect(f.wrapper.find('[data-testid="new-chat-in-group-button"]').exists()).toBe(false);
    expect(f.wrapper.find('[data-testid="create-chat-group-button"]').exists()).toBe(false);
    await f.wrapper.get('[data-testid="new-chat-button"]').trigger('click');
    await flushPromises();
    expect(mocks.createNewChat).toHaveBeenCalledExactlyOnceWith({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
  });
});
