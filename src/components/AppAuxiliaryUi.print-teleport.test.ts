import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { PrintMode } from '@/composables/usePrint';
import AppAuxiliaryUi from './AppAuxiliaryUi.vue';

const activePrintMode = ref<PrintMode>(undefined);

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
  useFileExplorerModal: () => ({ isFileExplorerOpen: ref(false) }),
}));

vi.mock('@/features/global-search/composables/useGlobalSearch', () => ({
  useGlobalSearch: () => ({ isSearchOpen: ref(false) }),
}));

vi.mock('@/composables/useRecentChats', () => ({
  useRecentChats: () => ({ isRecentOpen: ref(false) }),
}));

vi.mock('@/composables/usePrint', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/composables/usePrint')>();
  return {
    ...original,
    usePrint: () => ({
      activePrintMode,
    }),
  };
});

vi.mock('@/components/ChatPrintContent.vue', () => ({
  __esModule: true,
  default: {
    template: '<div data-testid="chat-print-content" />',
  },
}));

vi.mock('@/components/SettingsModal.vue', () => ({
  __esModule: true,
  default: { template: '<div />' },
}));
vi.mock('@/features/wesh-terminal/components/DebugWeshTerminalModal.vue', () => ({
  __esModule: true,
  default: { template: '<div />' },
}));
vi.mock('@/features/global-search/components/GlobalSearchModal.vue', () => ({
  __esModule: true,
  default: { template: '<div />' },
}));
vi.mock('@/components/RecentChatsModal.vue', () => ({
  __esModule: true,
  default: { template: '<div />' },
}));
vi.mock('@/features/file-explorer/components/FileExplorerModal.vue', () => ({
  __esModule: true,
  default: { template: '<div />' },
}));
vi.mock('@/components/PWAManager.vue', () => ({
  __esModule: true,
  default: { template: '<div />' },
}));

describe('AppAuxiliaryUi print teleport integration', () => {
  const route = reactive({
    path: '/',
    fullPath: '/',
    query: {} as Record<string, string>,
  });

  beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.classList.remove('dark');
    activePrintMode.value = undefined;
    vi.mocked(useRoute).mockReturnValue(route as ReturnType<typeof useRoute>);
    vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  });

  afterEach(() => {
    activePrintMode.value = undefined;
    document.documentElement.classList.remove('dark');
    document.body.innerHTML = '';
  });

  async function mountAuxiliaryUi() {
    const appHost = document.createElement('div');
    appHost.id = 'app';
    document.body.append(appHost);
    const wrapper = mount(AppAuxiliaryUi, { attachTo: appHost });
    await flushPromises();
    return { appHost, wrapper };
  }

  it('keeps print ownership in auxiliary UI while rendering the real PrintView under body', async () => {
    activePrintMode.value = 'chat';
    const { appHost, wrapper } = await mountAuxiliaryUi();

    try {
      await vi.waitFor(() => {
        expect(document.body.querySelector(':scope > .naidan-print-view-layer')).not.toBeNull();
      });
      const printLayer = document.body.querySelector<HTMLElement>(':scope > .naidan-print-view-layer');
      expect(printLayer?.parentElement).toBe(document.body);
      expect(appHost.contains(printLayer)).toBe(false);
      expect(printLayer?.querySelector('[data-testid="chat-print-content"]')).not.toBeNull();
      expect(printLayer?.style.display).toBe('none');
    } finally {
      wrapper.unmount();
      appHost.remove();
    }
  });

  it('preserves document-level dark ancestry for the real teleported PrintView', async () => {
    document.documentElement.classList.add('dark');
    activePrintMode.value = 'chat';
    const { appHost, wrapper } = await mountAuxiliaryUi();

    try {
      await vi.waitFor(() => {
        expect(document.body.querySelector(':scope > .naidan-print-view-layer')).not.toBeNull();
      });
      const printLayer = document.body.querySelector<HTMLElement>(':scope > .naidan-print-view-layer');
      expect(printLayer?.closest('.dark')).toBe(document.documentElement);
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    } finally {
      wrapper.unmount();
      appHost.remove();
    }
  });

  it('removes the body-level print layer when print mode returns to inactive', async () => {
    activePrintMode.value = 'chat';
    const { appHost, wrapper } = await mountAuxiliaryUi();

    try {
      await vi.waitFor(() => {
        expect(document.body.querySelector(':scope > .naidan-print-view-layer')).not.toBeNull();
      });
      activePrintMode.value = undefined;
      await flushPromises();
      await vi.waitFor(() => {
        expect(document.body.querySelector(':scope > .naidan-print-view-layer')).toBeNull();
      });
    } finally {
      wrapper.unmount();
      appHost.remove();
    }
  });
});
