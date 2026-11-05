import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MainAppSurface from './MainAppSurface.vue';
import { registerTranslationNavigation } from '@/features/translation/navigation';

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

vi.mock('@/features/translation/components/TranslationSidebar.vue', () => ({
  __esModule: true,
  default: {
    props: ['navigation'],
    template: '<div data-testid="translation-sidebar" />',
  },
}));

describe('MainAppSurface', () => {
  beforeEach(() => {
    isSidebarOpen.value = true;
    isDebugOpen.value = false;
  });

  function mountSurface({ postStartupFeatures }: {
    postStartupFeatures: 'inactive' | 'active',
  }) {
    return mount(MainAppSurface, {
      props: { postStartupFeatures },
      global: {
        stubs: {
          'router-view': true,
          transition: false,
        },
      },
    });
  }

  it('shows the translation sidebar only while a translation workspace owns navigation', async () => {
    const unregister = registerTranslationNavigation({ navigation: { openWorkspace: vi.fn(), openModels: vi.fn() } });
    using _cleanup = {
      [Symbol.dispose]() {
        unregister();
      },
    };
    const wrapper = mountSurface({ postStartupFeatures: 'inactive' });
    using _rendered = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    expect(wrapper.find('[data-testid="translation-sidebar"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(false);
    unregister();
    await flushPromises();
    expect(wrapper.find('[data-testid="translation-sidebar"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(true);
  });

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
});
