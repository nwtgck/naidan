import { flushPromises, mount } from '@vue/test-utils';
import { reactive, ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRoute, useRouter } from 'vue-router';
import ApplicationAuxiliaryUi from './ApplicationAuxiliaryUi.vue';

vi.mock('vue-router', () => ({
  useRoute: vi.fn(),
  useRouter: vi.fn(),
}));

vi.mock('@/composables/useLayout', () => ({
  useLayout: () => ({
    isWeshTerminalOpen: ref(false),
    toggleWeshTerminal: vi.fn(),
  }),
}));

vi.mock('@/composables/useFileExplorerModal', () => ({
  useFileExplorerModal: () => ({
    isFileExplorerOpen: ref(false),
  }),
}));

vi.mock('@/composables/usePrint', () => ({
  usePrint: () => ({
    activePrintMode: ref(undefined),
  }),
}));

const isSearchOpen = ref(false);
const isRecentOpen = ref(false);

vi.mock('@/composables/useGlobalSearch', () => ({
  useGlobalSearch: () => ({
    isSearchOpen,
  }),
}));

vi.mock('@/composables/useRecentChats', () => ({
  useRecentChats: () => ({
    isRecentOpen,
  }),
}));

vi.mock('@/components/SettingsModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: {
    name: 'SettingsModal',
    props: ['isOpen'],
    template: '<div v-if="isOpen" data-testid="settings-modal" />',
  },
}));
vi.mock('@/components/DebugWeshTerminalModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div />' },
}));
vi.mock('@/components/GlobalSearchModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div />' },
}));
vi.mock('@/components/RecentChatsModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div />' },
}));
vi.mock('@/components/FileExplorerModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div />' },
}));
vi.mock('@/components/PWAManager.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div />' },
}));
vi.mock('@/components/PrintView.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div><slot /></div>' },
}));
vi.mock('@/components/ChatPrintContent.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div />' },
}));

describe('ApplicationAuxiliaryUi', () => {
  const route = reactive({
    path: '/',
    fullPath: '/',
    query: {} as Record<string, string>,
  });
  const push = vi.fn();

  beforeEach(() => {
    route.path = '/';
    route.fullPath = '/';
    route.query = {};
    push.mockClear();
    isSearchOpen.value = false;
    isRecentOpen.value = false;
    vi.mocked(useRoute).mockReturnValue(route as ReturnType<typeof useRoute>);
    vi.mocked(useRouter).mockReturnValue({ push } as unknown as ReturnType<typeof useRouter>);
  });

  it('does not mount closed auxiliary overlays', async () => {
    const wrapper = mount(ApplicationAuxiliaryUi);
    await flushPromises();

    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(false);
  });

  it('opens settings after post-startup UI is activated', async () => {
    route.query = { settings: '1' };
    const wrapper = mount(ApplicationAuxiliaryUi);
    await flushPromises();

    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(true);
  });


  it('preserves the complete initial non-settings location for path-based settings close', () => {
    route.path = '/chat/chat-1';
    route.fullPath = '/chat/chat-1?leaf=message-1';
    const wrapper = mount(ApplicationAuxiliaryUi);

    (wrapper.vm as unknown as { TEST_ONLY: { closeSettings(): void } }).TEST_ONLY.closeSettings();

    expect(push).toHaveBeenCalledWith('/chat/chat-1?leaf=message-1');
  });
});
