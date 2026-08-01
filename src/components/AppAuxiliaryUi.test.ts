import { flushPromises, mount } from '@vue/test-utils';
import { reactive, ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRoute, useRouter } from 'vue-router';
import AppAuxiliaryUi from './AppAuxiliaryUi.vue';

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

vi.mock('@/features/file-explorer/composables/useFileExplorerModal', () => ({
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
const isDebugHizoFSWorkbenchOpen = ref(false);
const isPersistenceControlInspectorOpen = ref(false);

vi.mock('@/features/global-search/composables/useGlobalSearch', () => ({
  useGlobalSearch: () => ({
    isSearchOpen,
  }),
}));

vi.mock('@/composables/useRecentChats', () => ({
  useRecentChats: () => ({
    isRecentOpen,
  }),
}));

vi.mock('@/features/debug-hizofs/composables/useDebugHizoFSWorkbench', () => ({
  useDebugHizoFSWorkbench: () => ({
    isDebugHizoFSWorkbenchOpen,
  }),
}));

vi.mock('@/features/debug-opfs-encryption/composables/usePersistenceControlInspector', () => ({
  usePersistenceControlInspector: () => ({
    isPersistenceControlInspectorOpen,
  }),
}));

vi.mock('@/components/SettingsModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: {
    name: 'SettingsModal',
    props: ['isOpen'],
    emits: ['initialContentRendered'],
    template: '<div v-if="isOpen" data-testid="settings-modal"><button data-testid="settings-modal-ready" @click="$emit(\'initialContentRendered\')" /></div>',
  },
}));
vi.mock('@/features/wesh-terminal/components/DebugWeshTerminalModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div data-testid="wesh-modal" />' },
}));
vi.mock('@/features/global-search/components/GlobalSearchModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div data-testid="global-search-modal" />' },
}));
vi.mock('@/components/RecentChatsModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div data-testid="recent-chats-modal" />' },
}));
vi.mock('@/features/file-explorer/components/FileExplorerModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div />' },
}));
vi.mock('@/features/debug-hizofs/components/HizoFSWorkbenchModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div data-testid="hizofs-inspector" />' },
}));
vi.mock('@/features/debug-opfs-encryption/components/PersistenceControlInspectorModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div data-testid="opfs-encryption-inspector" />' },
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

describe('AppAuxiliaryUi', () => {
  const route = reactive({
    path: '/',
    fullPath: '/',
    query: {} as Record<string, string>,
    params: {} as Record<string, string>,
  });
  const push = vi.fn();
  const isReady = vi.fn(async () => {});

  beforeEach(() => {
    route.path = '/';
    route.fullPath = '/';
    route.query = {};
    route.params = {};
    push.mockClear();
    isReady.mockReset();
    isReady.mockResolvedValue(undefined);
    isSearchOpen.value = false;
    isRecentOpen.value = false;
    isDebugHizoFSWorkbenchOpen.value = false;
    isPersistenceControlInspectorOpen.value = false;
    vi.mocked(useRoute).mockReturnValue(route as ReturnType<typeof useRoute>);
    vi.mocked(useRouter).mockReturnValue({ push, isReady } as unknown as ReturnType<typeof useRouter>);
  });

  it('does not mount closed auxiliary overlays', async () => {
    const wrapper = mount(AppAuxiliaryUi);
    await flushPromises();

    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(false);
  });

  it('reports initial presentation after the no-modal frame is rendered', async () => {
    const wrapper = mount(AppAuxiliaryUi);
    await flushPromises();

    expect(wrapper.emitted('initialPresentationRendered')).toHaveLength(1);
  });

  it('waits for route-driven settings content before reporting initial presentation', async () => {
    route.query = { settings: 'storage' };
    const wrapper = mount(AppAuxiliaryUi, {
      props: { mode: 'preparing' },
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(true);
    expect(wrapper.emitted('initialPresentationRendered')).toBeUndefined();

    await wrapper.get('[data-testid="settings-modal-ready"]').trigger('click');
    expect(wrapper.emitted('initialPresentationRendered')).toHaveLength(1);
  });

  it('does not treat START_LOCATION as ready before an initial settings navigation settles', async () => {
    const routerReady = Promise.withResolvers<void>();
    isReady.mockReturnValueOnce(routerReady.promise);
    const wrapper = mount(AppAuxiliaryUi, {
      props: { mode: 'preparing' },
    });
    await flushPromises();

    expect(wrapper.emitted('initialPresentationRendered')).toBeUndefined();

    route.path = '/settings/storage';
    route.fullPath = '/settings/storage';
    route.query = {};
    route.params = { tab: 'storage' };
    routerReady.resolve();
    await flushPromises();
    await vi.dynamicImportSettled();
    await flushPromises();

    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(true);
    expect(wrapper.emitted('initialPresentationRendered')).toBeUndefined();

    await wrapper.get('[data-testid="settings-modal-ready"]').trigger('click');
    expect(wrapper.emitted('initialPresentationRendered')).toHaveLength(1);
  });

  it('keeps route-driven settings mounted in active operation mode', async () => {
    route.query = { settings: '1' };
    const wrapper = mount(AppAuxiliaryUi, {
      props: { mode: 'active' },
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(true);
  });


  it('preserves the complete initial non-settings location for path-based settings close', () => {
    route.path = '/chat/chat-1';
    route.fullPath = '/chat/chat-1?leaf=message-1';
    const wrapper = mount(AppAuxiliaryUi);

    (wrapper.vm as unknown as { TEST_ONLY: { closeSettings(): void } }).TEST_ONLY.closeSettings();

    expect(push).toHaveBeenCalledWith('/chat/chat-1?leaf=message-1');
  });
});
