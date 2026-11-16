import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import { createMemoryHistory, createRouter, useRoute } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MainAppSurface from './MainAppSurface.vue';
import { registerTranslationNavigation } from '@/features/translation/navigation';

vi.mock('@/composables/useAppEntry', () => ({ useAppEntry: () => ({ intent: ref({ kind: 'ordinary' }) }) }));
vi.mock('@/components/HomeWelcome.vue', () => ({ default: { template: '<div />' } }));

const isSidebarOpen = ref(true);
const isDebugOpen = ref(false);

vi.mock('@/composables/useLayout', () => ({
  useLayout: () => ({
    isSidebarOpen,
    isDebugOpen,
  }),
}));

vi.mock('@/components/AppSidebar.vue', () => ({
  default: {
    name: 'AppSidebar',
    props: ['postStartupFeatures'],
    emits: ['openModelSupportInvestigation'],
    template: '<div data-testid="app-sidebar" :data-activation="postStartupFeatures" />',
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
    isSidebarOpen.value = true;
    isDebugOpen.value = false;
  });

  async function mountSurface({ postStartupFeatures, path }: {
    postStartupFeatures: 'inactive' | 'active',
    path: string,
  }) {
    const page = defineComponent({
      setup() {
        const route = useRoute();
        return () => h('div', { 'data-testid': 'route-page', 'data-path': route.path });
      },
    });
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: page }] });
    await router.push(path);
    const wrapper = mount(MainAppSurface, {
      props: { postStartupFeatures },
      global: {
        plugins: [router],
        stubs: {
          transition: false,
        },
      },
    });
    wrappers.push(wrapper);
    return { wrapper, router };
  }

  it('keeps the common sidebar mounted when a workspace registers or releases navigation', async () => {
    const { wrapper } = await mountSurface({ postStartupFeatures: 'inactive', path: '/' });
    const sidebar = wrapper.get('[data-testid="app-sidebar"]').element;
    const unregister = registerTranslationNavigation({ navigation: { openWorkspace: vi.fn(), openModels: vi.fn() } });
    using _cleanup = {
      [Symbol.dispose]() {
        unregister();
      },
    };
    await flushPromises();
    expect(wrapper.get('[data-testid="app-sidebar"]').element).toBe(sidebar);
    expect(wrapper.get('[data-testid="route-page"]').attributes('data-path')).toBe('/');
    unregister();
    await flushPromises();
    expect(wrapper.get('[data-testid="app-sidebar"]').element).toBe(sidebar);
  });

  it('renders the common sidebar before feature activation and forwards activation without remounting it', async () => {
    const { wrapper } = await mountSurface({ postStartupFeatures: 'inactive', path: '/' });
    const sidebar = wrapper.get('[data-testid="app-sidebar"]').element;

    expect(wrapper.get('[data-testid="app-sidebar"]').attributes('data-activation')).toBe('inactive');
    await wrapper.setProps({ postStartupFeatures: 'active' });
    expect(wrapper.get('[data-testid="app-sidebar"]').element).toBe(sidebar);
    expect(wrapper.get('[data-testid="app-sidebar"]').attributes('data-activation')).toBe('active');
  });

  it('renders the debug panel only when post-startup features are active and debug is open', async () => {
    isDebugOpen.value = true;
    const { wrapper: inactiveWrapper } = await mountSurface({ postStartupFeatures: 'inactive', path: '/' });
    await flushPromises();
    expect(inactiveWrapper.find('[data-testid="debug-panel"]').exists()).toBe(false);
    inactiveWrapper.unmount();

    const { wrapper: activeWrapper } = await mountSurface({ postStartupFeatures: 'active', path: '/' });
    await flushPromises();
    expect(activeWrapper.find('[data-testid="debug-panel"]').exists()).toBe(true);
  });

  it.each(['/workflows', '/workflows/workflow-one', '/workflows/runs', '/workflows/runs/run-one'])('keeps the common sidebar while route content moves from %s to Home', async (path) => {
    const { wrapper, router } = await mountSurface({ postStartupFeatures: 'active', path });
    const sidebar = wrapper.get('[data-testid="app-sidebar"]').element;
    await flushPromises();
    expect(wrapper.get('[data-testid="route-page"]').attributes('data-path')).toBe(path);
    await router.push('/');
    await flushPromises();
    expect(wrapper.get('[data-testid="route-page"]').attributes('data-path')).toBe('/');
    expect(wrapper.get('[data-testid="app-sidebar"]').element).toBe(sidebar);
  });

  it.each(['provided', 'missing'] as const)('relays model support requests with the %s opener unchanged', async kind => {
    const { wrapper } = await mountSurface({ postStartupFeatures: 'active', path: '/' });
    const opener = kind === 'provided' ? document.createElement('button') : undefined;
    wrapper.getComponent({ name: 'AppSidebar' }).vm.$emit('openModelSupportInvestigation', opener);

    expect(wrapper.emitted('openModelSupportInvestigation')).toEqual([[opener]]);
  });
});
