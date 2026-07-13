import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SidebarDebugControls from './SidebarDebugControls.vue';

const mocks = vi.hoisted(() => ({
  inspectOpfsEncryption: vi.fn(),
  openEncryptedOpfsInspector: vi.fn(),
  openOpfsEncryptionInspector: vi.fn(),
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

vi.mock('@/features/debug-encrypted-opfs/composables/useDebugEncryptedOpfsInspector', () => ({
  useDebugEncryptedOpfsInspector: () => ({
    openDebugEncryptedOpfsInspector: mocks.openEncryptedOpfsInspector,
  }),
}));

vi.mock('@/features/debug-opfs-encryption/composables/useDebugOpfsEncryptionInspector', () => ({
  useDebugOpfsEncryptionInspector: () => ({
    openDebugOpfsEncryptionInspector: mocks.openOpfsEncryptionInspector,
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

    const controlInspectorButton = wrapper.get('[data-testid="sidebar-opfs-encryption-inspector-button"]');
    const encryptedOpfsInspectorButton = wrapper.get('[data-testid="sidebar-encrypted-opfs-inspector-button"]');
    expect(controlInspectorButton.attributes('disabled')).toBeDefined();
    expect(encryptedOpfsInspectorButton.attributes('disabled')).toBeDefined();
    await controlInspectorButton.trigger('click');
    await encryptedOpfsInspectorButton.trigger('click');
    expect(mocks.openOpfsEncryptionInspector).not.toHaveBeenCalled();
    expect(mocks.openEncryptedOpfsInspector).not.toHaveBeenCalled();
  });

  it('opens both inspectors after confirming encrypted OPFS is active', async () => {
    mocks.inspectOpfsEncryption.mockResolvedValue({
      type: 'encrypted',
      state: {},
    });
    const wrapper = mountControls();

    await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
    await flushPromises();

    const controlInspectorButton = wrapper.get('[data-testid="sidebar-opfs-encryption-inspector-button"]');
    const encryptedOpfsInspectorButton = wrapper.get('[data-testid="sidebar-encrypted-opfs-inspector-button"]');
    expect(controlInspectorButton.attributes('disabled')).toBeUndefined();
    expect(encryptedOpfsInspectorButton.attributes('disabled')).toBeUndefined();

    await controlInspectorButton.trigger('click');
    expect(mocks.openOpfsEncryptionInspector).toHaveBeenCalledOnce();

    await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="sidebar-encrypted-opfs-inspector-button"]').trigger('click');
    expect(mocks.openEncryptedOpfsInspector).toHaveBeenCalledOnce();
  });
});
