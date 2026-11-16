import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { toChatId } from '@/01-models/ids';
import type { RecentChatWithAccess } from '@/composables/useRecentChats';
import type { LiveConversationNavigation, LiveConversationPanel } from '@/features/live-conversation/navigation';
import LiveConversationSidebar from './LiveConversationSidebar.vue';

const expanded = ref(true);
const mostRecentChat = ref<RecentChatWithAccess>();
vi.mock('@/composables/useLayout', () => ({ useLayout: () => ({ isSidebarOpen: expanded, toggleSidebar: vi.fn() }) }));
vi.mock('@/composables/useRecentChats', () => ({ useRecentChats: () => ({ mostRecentChat }) }));

beforeEach(async () => {
  expanded.value = true;
  mostRecentChat.value = undefined;
  await ensureAllStringsForTest({ locale: 'en' });
});

async function fixture() {
  const busy = ref(false), panel = ref<LiveConversationPanel>('conversation');
  const navigation: LiveConversationNavigation = {
    panel,
    modelName: ref('Haru'),
    fileName: ref(undefined),
    busy,
    canReset: ref(true),
    openConversation: vi.fn(),
    openDiagnostics: vi.fn(),
    newConversation: vi.fn(async () => {}),
    openSettings: vi.fn(),
  };
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] });
  await router.push('/live-conversation');
  const wrapper = mount(LiveConversationSidebar, { props: { navigation }, global: { plugins: [router], stubs: { SidebarHeader: true, SidebarDebugControls: true, LauncherButton: true } } });
  return {
    wrapper,
    navigation,
    busy,
    panel,
    router,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('Live Conversation owns its sidebar', () => {
  it('offers conversation, investigation tools, settings and a return to chats', async () => {
    using f = await fixture();
    await f.wrapper.get('[data-testid="live-sidebar-diagnostics"]').trigger('click');
    expect(f.navigation.openDiagnostics).toHaveBeenCalledOnce();
    await f.wrapper.get('[data-testid="live-sidebar-settings"]').trigger('click');
    expect(f.navigation.openSettings).toHaveBeenCalledOnce();
    expect(f.wrapper.get('[data-testid="live-sidebar-back"]').attributes('href')).toBe('/');
  });

  it('places investigation tools below conversation settings', async () => {
    using f = await fixture();
    const settings = f.wrapper.get('[data-testid="live-sidebar-settings"]').element;
    const tools = f.wrapper.get('[data-testid="live-sidebar-diagnostics"]').element;
    expect(settings.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(f.wrapper.find('[data-testid="live-sidebar-file"]').exists()).toBe(false);
  });

  it('prevents changing input sources during inference and remains usable when collapsed', async () => {
    using f = await fixture();
    expanded.value = false;
    f.busy.value = true;
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-sidebar-diagnostics"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-sidebar-microphone"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-sidebar-diagnostics"]').attributes('title')).toBe('Diagnostics');
    expect(f.wrapper.find('[data-testid="live-sidebar-settings"]').exists()).toBe(true);
  });

  it.each([true, false])('returns to the latest chat through the actual router when expanded is %s', async isExpanded => {
    expanded.value = isExpanded;
    mostRecentChat.value = { id: toChatId({ raw: 'previous-chat' }), title: 'Previous chat', updatedAt: 10, accessedAt: 20 };
    using f = await fixture();
    const back = f.wrapper.get('[data-testid="live-sidebar-back"]');
    expect(back.attributes('href')).toBe('/chat/previous-chat');
    mostRecentChat.value = { id: toChatId({ raw: 'next-chat' }), title: 'Next chat', updatedAt: 30, accessedAt: 40 };
    await flushPromises();
    expect(back.attributes('href')).toBe('/chat/next-chat');
    await back.trigger('click');
    await flushPromises();
    expect(f.router.currentRoute.value.path).toBe('/chat/next-chat');
    expect(f.navigation.newConversation).not.toHaveBeenCalled();
  });

  it('returns Home when the last recent chat is removed', async () => {
    mostRecentChat.value = { id: toChatId({ raw: 'deleted-chat' }), title: 'Deleted chat', updatedAt: 10, accessedAt: 20 };
    using f = await fixture();
    mostRecentChat.value = undefined;
    await flushPromises();
    const back = f.wrapper.get('[data-testid="live-sidebar-back"]');
    expect(back.attributes('href')).toBe('/');
    await back.trigger('click');
    await flushPromises();
    expect(f.router.currentRoute.value.path).toBe('/');
    expect(f.navigation.newConversation).not.toHaveBeenCalled();
  });
});
