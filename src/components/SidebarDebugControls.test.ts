import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ONLY as PERSISTENCE_RUNTIME_TEST_ONLY } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import SidebarDebugControls from './SidebarDebugControls.vue';

const mocks = vi.hoisted(() => ({
  inspectOpfsEncryption: vi.fn(),
  openHizoFSWorkbench: vi.fn(),
  openOpfsEncryptionInspector: vi.fn(),
  openFileExplorer: vi.fn(),
  openRecent: vi.fn(),
  toggleDebug: vi.fn(),
  toggleWeshTerminal: vi.fn(),
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

vi.mock('@/features/debug-hizofs/composables/useDebugHizoFSWorkbench', () => ({
  useDebugHizoFSWorkbench: () => ({
    openDebugHizoFSWorkbench: mocks.openHizoFSWorkbench,
  }),
}));

vi.mock('@/features/debug-opfs-encryption/composables/usePersistenceControlInspector', () => ({
  usePersistenceControlInspector: () => ({
    openPersistenceControlInspector: mocks.openOpfsEncryptionInspector,
  }),
}));

let wrapper: VueWrapper | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.inspectOpfsEncryption.mockResolvedValue({ type: 'plain' });
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

async function mountControls() {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/audio-generation', component: { template: '<div />' } },
    { path: '/image-generation-lab', component: { template: '<div />' } },
  ] });
  await router.push('/');
  await router.isReady();
  wrapper = mount(SidebarDebugControls, {
    props: { isSidebarOpen: true },
    global: {
      plugins: [router],
      stubs: {
        MessageActionsMenu: {
          template: '<div><slot /></div>',
        },
      },
    },
  });
  return { wrapper, router };
}

describe('SidebarDebugControls encrypted storage quick access', () => {
  it('keeps the Naidan control inspector disabled but exposes the Workbench for plaintext storage', async () => {
    mocks.inspectOpfsEncryption.mockResolvedValue({ type: 'plain' });
    const { wrapper } = await mountControls();

    await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
    await flushPromises();

    const controlInspectorButton = wrapper.get('[data-testid="sidebar-opfs-encryption-inspector-button"]');
    const hizoFSWorkbenchButton = wrapper.get('[data-testid="sidebar-hizofs-workbench-button"]');
    expect(controlInspectorButton.attributes('disabled')).toBeDefined();
    expect(hizoFSWorkbenchButton.attributes('disabled')).toBeUndefined();
    await controlInspectorButton.trigger('click');
    await hizoFSWorkbenchButton.trigger('click');
    expect(mocks.openOpfsEncryptionInspector).not.toHaveBeenCalled();
    expect(mocks.openHizoFSWorkbench).toHaveBeenCalledOnce();
  });

  it('exposes the low-level Naidan inspector while storage is credential-required', async () => {
    mocks.inspectOpfsEncryption.mockResolvedValue(
      PERSISTENCE_RUNTIME_TEST_ONLY.createCredentialRequiredInspection({
        firstSequence: 2,
        secondSequence: 1,
      }),
    );
    const { wrapper } = await mountControls();

    await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
    await flushPromises();

    const controlInspectorButton = wrapper.get('[data-testid="sidebar-opfs-encryption-inspector-button"]');
    expect(controlInspectorButton.attributes('disabled')).toBeUndefined();
    await controlInspectorButton.trigger('click');
    expect(mocks.openOpfsEncryptionInspector).toHaveBeenCalledOnce();
  });

  it('opens the Naidan inspector and the independent HizoFS Workbench for encrypted storage', async () => {
    mocks.inspectOpfsEncryption.mockResolvedValue({
      type: 'encrypted',
      state: {},
    });
    const { wrapper } = await mountControls();

    await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
    await flushPromises();

    const controlInspectorButton = wrapper.get('[data-testid="sidebar-opfs-encryption-inspector-button"]');
    const hizoFSWorkbenchButton = wrapper.get('[data-testid="sidebar-hizofs-workbench-button"]');
    expect(controlInspectorButton.attributes('disabled')).toBeUndefined();
    expect(hizoFSWorkbenchButton.attributes('disabled')).toBeUndefined();

    await controlInspectorButton.trigger('click');
    expect(mocks.openOpfsEncryptionInspector).toHaveBeenCalledOnce();

    await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="sidebar-hizofs-workbench-button"]').trigger('click');
    expect(mocks.openHizoFSWorkbench).toHaveBeenCalledOnce();
  });
});

it('opens the independent audio workspace from Quick Access and closes the menu', async () => {
  const { wrapper, router } = await mountControls();
  await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
  const link = wrapper.get('[data-testid="sidebar-audio-generation-link"]'); expect(link.attributes('href')).toBe('/audio-generation');
  await link.trigger('click'); await flushPromises(); expect(router.currentRoute.value.path).toBe('/audio-generation');
  expect(wrapper.find('[data-testid="sidebar-audio-generation-link"]').exists()).toBe(false);
});

it('opens the independent image workspace from Quick Access and closes the menu', async () => {
  const { wrapper, router } = await mountControls();
  await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
  const link = wrapper.get('[data-testid="sidebar-image-generation-link"]'); expect(link.attributes('href')).toBe('/image-generation-lab');
  await link.trigger('click'); await flushPromises(); expect(router.currentRoute.value.path).toBe('/image-generation-lab');
  expect(wrapper.find('[data-testid="sidebar-image-generation-link"]').exists()).toBe(false);
});
