import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SidebarDebugControls from './SidebarDebugControls.vue';

const mocks = vi.hoisted(() => ({
  inspectOpfsEncryption: vi.fn(),
  openInspector: vi.fn(),
  openFileExplorer: vi.fn(),
  openRecent: vi.fn(),
  toggleDebug: vi.fn(),
  toggleWeshTerminal: vi.fn(),
}));

vi.mock('@/strings', () => ({
  lazyStrings: {
    SidebarDebugControls__debug_events: () => 'Debug events',
    SidebarDebugControls__more_actions: () => 'More actions',
    SidebarDebugControls__quick_access: () => 'Quick Access',
    SidebarDebugControls__recent_chats: () => 'Recent chats',
    SidebarDebugControls__file_explorer: () => 'File Explorer',
    SidebarDebugControls__wesh_terminal: () => 'Wesh Terminal',
  },
}));

vi.mock('@/00-storage/service', () => ({
  storageService: {
    inspectOpfsEncryption: mocks.inspectOpfsEncryption,
  },
}));

vi.mock('@/composables/useLayout', () => ({
  useLayout: () => ({
    isDebugOpen: ref(false),
    toggleDebug: mocks.toggleDebug,
    toggleWeshTerminal: mocks.toggleWeshTerminal,
  }),
}));

vi.mock('@/composables/useGlobalEvents', () => ({
  useGlobalEvents: () => ({ errorCount: ref(0) }),
}));

vi.mock('@/features/file-explorer/composables/useFileExplorerModal', () => ({
  useFileExplorerModal: () => ({ openFileExplorer: mocks.openFileExplorer }),
}));

vi.mock('@/composables/useRecentChats', () => ({
  useRecentChats: () => ({ openRecent: mocks.openRecent }),
}));

vi.mock('@/features/debug-encrypted-storage/composables/useDebugEncryptedStorageInspector', () => ({
  useDebugEncryptedStorageInspector: () => ({
    openDebugEncryptedStorageInspector: mocks.openInspector,
  }),
}));

function mountControls() {
  return mount(SidebarDebugControls, {
    props: { isSidebarOpen: true },
    global: {
      stubs: {
        MessageActionsMenu: {
          template: '<div><slot /></div>',
        },
      },
    },
  });
}

describe('SidebarDebugControls encrypted storage quick access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the Inspector disabled for plaintext storage', async () => {
    mocks.inspectOpfsEncryption.mockResolvedValue({ type: 'plain' });
    const wrapper = mountControls();

    await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
    await flushPromises();

    const inspectorButton = wrapper.get('[data-testid="sidebar-encrypted-storage-inspector-button"]');
    expect(inspectorButton.attributes('disabled')).toBeDefined();
    await inspectorButton.trigger('click');
    expect(mocks.openInspector).not.toHaveBeenCalled();
  });

  it('opens the Inspector after confirming encrypted OPFS is active', async () => {
    mocks.inspectOpfsEncryption.mockResolvedValue({
      type: 'encrypted',
      state: {},
    });
    const wrapper = mountControls();

    await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
    await flushPromises();

    const inspectorButton = wrapper.get('[data-testid="sidebar-encrypted-storage-inspector-button"]');
    expect(inspectorButton.attributes('disabled')).toBeUndefined();
    await inspectorButton.trigger('click');
    expect(mocks.openInspector).toHaveBeenCalledOnce();
  });
});
