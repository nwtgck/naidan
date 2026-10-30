import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
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
  wrapper?.unmount();
  wrapper = undefined;
});

it('keeps the mock-style download icon before terminal and More, without a sidebar text label', async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  });
  await router.push('/');
  await router.isReady();
  wrapper = mount(SidebarDebugControls, { props: { isSidebarOpen: true }, global: { plugins: [router] } });
  const trigger = wrapper.get('[data-testid="model-downloads-trigger"]');
  expect(trigger.attributes('aria-label')).toBeTruthy();
  expect(trigger.attributes('title')).toBe(trigger.attributes('aria-label'));
  expect(trigger.text()).toBe('');
  const buttons = wrapper.findAll('button');
  expect(buttons[0]?.element).toBe(trigger.element);
  expect(buttons[1]?.attributes('data-testid')).toBe('sidebar-debug-button');
  expect(buttons[2]?.attributes('data-testid')).toBe('sidebar-opfs-menu-button');
  expect(wrapper.text()).not.toContain('Downloads');
});

it('keeps the icon-only download control in the collapsed action stack', async () => {
  wrapper = mount(SidebarDebugControls, { props: { isSidebarOpen: false } });
  const trigger = wrapper.get('[data-testid="model-downloads-trigger"]');
  expect(trigger.text()).toBe('');
  const buttons = wrapper.findAll('button');
  expect(buttons).toHaveLength(2);
  expect(buttons[0]?.element).toBe(trigger.element);
  expect(wrapper.find('[data-testid="sidebar-opfs-menu-button"]').exists()).toBe(false);
});

it('opens the independent audio workspace from Quick Access and closes the menu', async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/audio-generation', component: { template: '<div />' } },
      { path: '/image-generation', component: { template: '<div />' } },
    ],
  });
  await router.push('/');
  await router.isReady();
  wrapper = mount(SidebarDebugControls, { props: { isSidebarOpen: true }, global: { plugins: [router], stubs: { MessageActionsMenu: { template: '<div><slot /></div>' } } } });
  await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
  const link = wrapper.get('[data-testid="sidebar-audio-generation-link"]');
  expect(link.attributes('href')).toBe('/audio-generation');
  await link.trigger('click');
  await flushPromises();
  expect(router.currentRoute.value.path).toBe('/audio-generation');
  expect(wrapper.find('[data-testid="sidebar-audio-generation-link"]').exists()).toBe(false);
});

it('opens the independent image workspace from Quick Access and closes the menu', async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/audio-generation', component: { template: '<div />' } },
      { path: '/image-generation', component: { template: '<div />' } },
    ],
  });
  await router.push('/');
  await router.isReady();
  wrapper = mount(SidebarDebugControls, { props: { isSidebarOpen: true }, global: { plugins: [router], stubs: { MessageActionsMenu: { template: '<div><slot /></div>' } } } });
  await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
  const link = wrapper.get('[data-testid="sidebar-image-generation-link"]');
  expect(link.attributes('href')).toBe('/image-generation');
  await link.trigger('click');
  await flushPromises();
  expect(router.currentRoute.value.path).toBe('/image-generation');
  expect(wrapper.find('[data-testid="sidebar-image-generation-link"]').exists()).toBe(false);
});

it('adds a separate live conversation route without replacing the existing destinations', async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/audio-generation', component: { template: '<div />' } },
      { path: '/image-generation', component: { template: '<div />' } },
      { path: '/live-conversation', component: { template: '<div />' } },
    ],
  });
  await router.push('/');
  await router.isReady();
  wrapper = mount(SidebarDebugControls, { props: { isSidebarOpen: true }, global: { plugins: [router], stubs: { MessageActionsMenu: { template: '<div><slot /></div>' } } } });
  await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
  expect(wrapper.get('[data-testid="sidebar-audio-generation-link"]').attributes('href')).toBe('/audio-generation');
  expect(wrapper.get('[data-testid="sidebar-image-generation-link"]').attributes('href')).toBe('/image-generation');
  const link = wrapper.get('[data-testid="sidebar-live-conversation-link"]');
  expect(link.attributes('href')).toBe('/live-conversation');
  await link.trigger('click');
  await flushPromises();
  expect(router.currentRoute.value.path).toBe('/live-conversation');
  expect(wrapper.find('[data-testid="sidebar-live-conversation-link"]').exists()).toBe(false);
});
