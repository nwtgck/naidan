import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.vue';

const applicationInteraction = ref<
  | 'blocked-by-startup'
  | 'blocked-by-onboarding'
  | 'enabled'
>('enabled');
const isDebugOpen = ref(false);

vi.mock('./composables/useApplicationPresentation', () => ({
  useApplicationPresentation: () => ({
    applicationInteraction,
  }),
}));

vi.mock('./composables/useLayout', () => ({
  useLayout: () => ({
    isSidebarOpen: ref(true),
    isDebugOpen,
  }),
}));

vi.mock('./components/Sidebar.vue', () => ({
  default: {
    template: '<div data-testid="sidebar" />',
  },
}));

vi.mock('./components/ApplicationCommandRuntime.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: {
    template: '<div data-testid="application-command-runtime" />',
  },
}));

vi.mock('./components/ApplicationAuxiliaryUi.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: {
    template: '<div data-testid="application-auxiliary-ui" />',
  },
}));

vi.mock('./components/DebugPanel.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: {
    template: '<div data-testid="debug-panel" />',
  },
}));

describe('App', () => {
  beforeEach(() => {
    applicationInteraction.value = 'enabled';
    isDebugOpen.value = false;
  });

  function mountApp() {
    return mount(App, {
      global: {
        stubs: {
          'router-view': true,
          transition: false,
        },
      },
    });
  }

  it('renders the real Sidebar while post-startup features remain separate', async () => {
    const wrapper = mountApp();
    await flushPromises();

    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="application-command-runtime"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="application-auxiliary-ui"]').exists()).toBe(true);
  });

  it('does not load command or auxiliary UI while onboarding blocks interaction', async () => {
    applicationInteraction.value = 'blocked-by-onboarding';
    const wrapper = mountApp();
    await flushPromises();

    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="application-command-runtime"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="application-auxiliary-ui"]').exists()).toBe(false);
  });

  it('renders the debug panel only after interaction is enabled and debug is open', async () => {
    isDebugOpen.value = true;
    applicationInteraction.value = 'blocked-by-onboarding';
    const blockedWrapper = mountApp();
    await flushPromises();
    expect(blockedWrapper.find('[data-testid="debug-panel"]').exists()).toBe(false);
    blockedWrapper.unmount();

    applicationInteraction.value = 'enabled';
    const enabledWrapper = mountApp();
    await flushPromises();
    expect(enabledWrapper.find('[data-testid="debug-panel"]').exists()).toBe(true);
  });
});
