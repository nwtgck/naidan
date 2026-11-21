import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { createMemoryHistory, createRouter, useRouter } from 'vue-router';
import AppSidebar from './AppSidebar.vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';

enableAutoUnmount(afterEach);
const failedImports = vi.hoisted(() => vi.fn());
vi.mock('@/composables/useAppEntry', () => ({ requestAppSettings: vi.fn(), useAppEntry: () => ({ effectiveRoute: useRouter().currentRoute, intent: ref({ kind: 'ordinary' }) }) }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: ref({ storageType: 'local' }) }) }));
vi.mock('@/composables/useLayout', () => ({ useLayout: () => ({ isSidebarOpen: ref(true), toggleSidebar: vi.fn() }) }));
vi.mock('@/composables/useChatReturn', () => ({ useChatReturn: () => ({ chatReturnPath: computed(() => '/') }) }));
vi.mock('@/components/SidebarHeader.vue', () => ({ default: { template: '<div data-testid="brand" />' } }));
vi.mock('@/components/LauncherButton.vue', () => ({ default: { template: '<button data-testid="launcher">launcher</button>' } }));
vi.mock('@/components/SidebarDebugControls.vue', () => ({ default: { template: '<button data-testid="common-controls">controls</button>' } }));
vi.mock('@/components/PWAUpdateNotification.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/features/workflow/components/WorkflowSidebarActions.vue', () => ({ __esModule: true, __isTeleport: false, default: { template: '<button>new workflow</button>' } }));
vi.mock('@/features/workflow/components/WorkflowSidebar.vue', () => {
  failedImports();
  throw new Error('The workflow sidebar chunk is unavailable');
});

it('keeps common controls usable after a chunk fails and retries the same feature after leaving and returning', async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  const page = { template: '<div />' };
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: page }, { path: '/workflows', component: page }, { path: '/audio-generation', component: page }] });
  await router.push('/workflows');
  const wrapper = mount(AppSidebar, { props: { postStartupFeatures: 'active' }, global: { plugins: [router] } });
  const launcher = wrapper.get('[data-testid="launcher"]').element;
  await flushPromises();
  expect(failedImports).toHaveBeenCalledOnce();
  expect(wrapper.get('[data-testid="sidebar-load-error"]').text()).toContain("Couldn't load the sidebar.");
  expect(wrapper.get('[data-testid="common-controls"]').attributes('disabled')).toBeUndefined();
  await router.push('/audio-generation');
  await flushPromises();
  expect(wrapper.attributes('data-sidebar-target')).toBe('audio_generation');
  expect(wrapper.find('[data-testid="sidebar-preparing"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="sidebar-load-error"]').exists()).toBe(false);
  await router.push('/workflows');
  await flushPromises();
  expect(wrapper.find('[data-testid="sidebar-load-error"]').exists()).toBe(true);
  expect(failedImports).toHaveBeenCalledOnce();
  // Simulate the same chunk becoming available; do not recreate the app frame.
  vi.doMock('@/features/workflow/components/WorkflowSidebar.vue', () => ({ __esModule: true, __isTeleport: false, default: { template: '<div data-testid="recovered-content" />' } }));
  using _available = {
    [Symbol.dispose]() {
      vi.doUnmock('@/features/workflow/components/WorkflowSidebar.vue');
    },
  };
  await wrapper.get('[data-testid="sidebar-retry"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-testid="recovered-content"]').exists()).toBe(true);
  expect(wrapper.find('[data-testid="sidebar-load-error"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="launcher"]').element).toBe(launcher);
});
