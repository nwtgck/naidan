import { flushPromises, mount } from '@vue/test-utils';
import { ref, reactive } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MainAppSurface from './MainAppSurface.vue';

vi.mock('@/composables/useAppEntry', () => ({ useAppEntry: () => ({ intent: ref({ kind: 'ordinary' }) }) }));
vi.mock('@/components/HomeWelcome.vue', () => ({ default: { template: '<div />' } }));

const route = reactive({ path: '/' });
vi.mock('vue-router', () => ({ useRoute: () => route }));
vi.mock('@/features/workflow/components/WorkflowSidebar.vue', () => ({ __esModule: true, __isTeleport: false, default: { template: '<div data-testid="workflow-sidebar" />' } }));

const isSidebarOpen = ref(true);
const isDebugOpen = ref(false);

vi.mock('@/composables/useLayout', () => ({
  useLayout: () => ({
    isSidebarOpen,
    isDebugOpen,
  }),
}));

vi.mock('@/components/Sidebar.vue', () => ({
  default: {
    template: '<div data-testid="sidebar" />',
  },
}));

vi.mock('@/components/DebugPanel.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: {
    template: '<div data-testid="debug-panel" />',
  },
}));

describe('MainAppSurface', () => {
  const wrappers: ReturnType<typeof mount>[] = [];

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) {
      wrapper.unmount();
    }
  });

  beforeEach(() => {
    route.path = '/';
    isSidebarOpen.value = true;
    isDebugOpen.value = false;
  });

  function mountSurface({ postStartupFeatures }: {
    postStartupFeatures: 'inactive' | 'active',
  }) {
    const wrapper = mount(MainAppSurface, {
      props: { postStartupFeatures },
      global: {
        stubs: {
          'router-view': true,
          transition: false,
        },
      },
    });
    wrappers.push(wrapper);
    return wrapper;
  }

  it('renders the real Sidebar independently of post-startup features', () => {
    const wrapper = mountSurface({ postStartupFeatures: 'inactive' });

    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(true);
  });

  it('renders the debug panel only when post-startup features are active and debug is open', async () => {
    isDebugOpen.value = true;
    const inactiveWrapper = mountSurface({ postStartupFeatures: 'inactive' });
    await flushPromises();
    expect(inactiveWrapper.find('[data-testid="debug-panel"]').exists()).toBe(false);
    inactiveWrapper.unmount();

    const activeWrapper = mountSurface({ postStartupFeatures: 'active' });
    await flushPromises();
    expect(activeWrapper.find('[data-testid="debug-panel"]').exists()).toBe(true);
  });

  it.each(['/workflows', '/workflows/workflow-one', '/workflows/runs', '/workflows/runs/run-one'])('replaces the chat sidebar at %s and restores it when leaving', async (path) => {
    route.path = path;
    const wrapper = mountSurface({ postStartupFeatures: 'active' });
    await flushPromises();
    expect(wrapper.find('[data-testid="workflow-sidebar"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(false);
    route.path = '/';
    await flushPromises();
    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="workflow-sidebar"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
