import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { LiveConversationNavigation, LiveConversationPanel } from '@/features/live-conversation/navigation';
import LiveConversationSidebar from './LiveConversationSidebar.vue';

const expanded = ref(true);
vi.mock('@/composables/useLayout', () => ({ useLayout: () => ({ isSidebarOpen: expanded, toggleSidebar: vi.fn() }) }));

beforeEach(async () => {
  expanded.value = true;
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
  const wrapper = mount(LiveConversationSidebar, { props: { navigation }, global: { plugins: [router], stubs: { SidebarHeader: true, SidebarDebugControls: true } } });
  return {
    wrapper,
    navigation,
    busy,
    panel,
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
});
