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

vi.mock('@/features/transformers-js/download-verification', () => ({
  isDownloadVerificationAvailable: true,
  loadDownloadVerificationModal: async () => ({
    name: 'DownloadVerificationModal',
    emits: ['close'],
    template: '<div data-testid="download-verification-modal-stub"><button data-testid="download-verification-close-stub" @click="$emit(\'close\')">close</button></div>',
  }),
}));

vi.mock('@/components/SettingsModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: {
    name: 'SettingsModal',
    props: ['isOpen'],
    emits: ['close', 'openDownloadVerification'],
    template: '<div v-if="isOpen" data-testid="settings-modal"><button data-testid="settings-open-download-verification-stub" @click="$emit(\'openDownloadVerification\')">open</button></div>',
  },
}));
vi.mock('@/features/wesh-terminal/components/DebugWeshTerminalModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div />' },
}));
vi.mock('@/features/global-search/components/GlobalSearchModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div />' },
}));
vi.mock('@/components/RecentChatsModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div />' },
}));
vi.mock('@/features/file-explorer/components/FileExplorerModal.vue', () => ({
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

describe('AppAuxiliaryUi', () => {
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
    const wrapper = mount(AppAuxiliaryUi);
    await flushPromises();

    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(false);
  });

  it('opens settings after post-startup UI is activated', async () => {
    route.query = { settings: '1' };
    const wrapper = mount(AppAuxiliaryUi);
    await flushPromises();

    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(true);
  });

  it('hands download verification off to the app-level host without destroying settings state', async () => {
    route.query = { settings: 'developer' };
    route.fullPath = '/?settings=developer';
    const wrapper = mount(AppAuxiliaryUi, { attachTo: document.body });
    await flushPromises();

    const settingsHost = wrapper.get('[data-testid="settings-modal-host"]');
    expect(settingsHost.element.getAttribute('style') ?? '').not.toContain('display: none');

    const opener = wrapper.get('[data-testid="settings-open-download-verification-stub"]').element as HTMLElement;
    opener.focus();
    expect(document.activeElement).toBe(opener);
    await wrapper.get('[data-testid="settings-open-download-verification-stub"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="settings-modal-host"]').element.getAttribute('style')).toContain('display: none');
    expect(wrapper.find('[data-testid="download-verification-modal-stub"]').exists()).toBe(true);
    expect(route.query).toEqual({ settings: 'developer' });

    document.body.tabIndex = -1;
    document.body.focus();
    expect(document.activeElement).toBe(document.body);
    await wrapper.get('[data-testid="download-verification-close-stub"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="settings-modal-host"]').element.getAttribute('style') ?? '').not.toContain('display: none');
    expect(wrapper.find('[data-testid="download-verification-modal-stub"]').exists()).toBe(false);
    expect(route.query).toEqual({ settings: 'developer' });
    expect(document.activeElement).toBe(opener);
    wrapper.unmount();
    document.body.removeAttribute('tabindex');
  });


  it('preserves the complete initial non-settings location for path-based settings close', () => {
    route.path = '/chat/chat-1';
    route.fullPath = '/chat/chat-1?leaf=message-1';
    const wrapper = mount(AppAuxiliaryUi);

    (wrapper.vm as unknown as { TEST_ONLY: { closeSettings(): void } }).TEST_ONLY.closeSettings();

    expect(push).toHaveBeenCalledWith('/chat/chat-1?leaf=message-1');
  });
});
