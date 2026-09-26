import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import SidebarDebugControls from './SidebarDebugControls.vue';
vi.mock('@/composables/useLayout', () => ({ useLayout: () => ({ isDebugOpen: ref(false), toggleDebug: vi.fn(), toggleWeshTerminal: vi.fn() }) }));
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ errorCount: ref(0) }) }));
vi.mock('@/features/file-explorer/composables/useFileExplorerModal', () => ({ useFileExplorerModal: () => ({ openFileExplorer: vi.fn() }) }));
vi.mock('@/composables/useRecentChats', () => ({ useRecentChats: () => ({ openRecent: vi.fn() }) }));
let wrapper: VueWrapper | undefined;
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined;
});
it('opens the independent audio workspace from Quick Access and closes the menu', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/audio-generation', component: { template: '<div />' } },
    { path: '/image-generation-lab', component: { template: '<div />' } },
  ] });
  await router.push('/'); await router.isReady();
  wrapper = mount(SidebarDebugControls, { props: { isSidebarOpen: true }, global: { plugins: [router], stubs: { MessageActionsMenu: { template: '<div><slot /></div>' } } } });
  await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
  const link = wrapper.get('[data-testid="sidebar-audio-generation-link"]'); expect(link.attributes('href')).toBe('/audio-generation');
  await link.trigger('click'); await flushPromises(); expect(router.currentRoute.value.path).toBe('/audio-generation');
  expect(wrapper.find('[data-testid="sidebar-audio-generation-link"]').exists()).toBe(false);
});

it('opens the independent image workspace from Quick Access and closes the menu', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/audio-generation', component: { template: '<div />' } },
    { path: '/image-generation-lab', component: { template: '<div />' } },
  ] });
  await router.push('/'); await router.isReady();
  wrapper = mount(SidebarDebugControls, { props: { isSidebarOpen: true }, global: { plugins: [router], stubs: { MessageActionsMenu: { template: '<div><slot /></div>' } } } });
  await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
  const link = wrapper.get('[data-testid="sidebar-image-generation-link"]'); expect(link.attributes('href')).toBe('/image-generation-lab');
  await link.trigger('click'); await flushPromises(); expect(router.currentRoute.value.path).toBe('/image-generation-lab');
  expect(wrapper.find('[data-testid="sidebar-image-generation-link"]').exists()).toBe(false);
});
