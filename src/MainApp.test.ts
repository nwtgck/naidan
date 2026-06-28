import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MainApp from './MainApp.vue';

const appInteraction = ref<
  | 'blocked-by-startup'
  | 'blocked-by-onboarding'
  | 'enabled'
>('enabled');

vi.mock('./composables/useAppPresentation', () => ({
  useAppPresentation: () => ({
    appInteraction,
  }),
}));

vi.mock('./components/MainAppSurface.vue', () => ({
  default: {
    props: ['postStartupFeatures'],
    template: '<div data-testid="main-app-surface" :data-post-startup-features="postStartupFeatures" />',
  },
}));

vi.mock('./components/AppCommandRuntime.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: {
    template: '<div data-testid="app-command-runtime" />',
  },
}));

vi.mock('./components/AppAuxiliaryUi.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: {
    template: '<div data-testid="app-auxiliary-ui" />',
  },
}));

describe('MainApp', () => {
  beforeEach(() => {
    appInteraction.value = 'enabled';
  });

  function mountMainApp() {
    return mount(MainApp);
  }

  it('renders the main app surface and post-startup features after interaction is enabled', async () => {
    const wrapper = mountMainApp();
    await flushPromises();

    expect(wrapper.get('[data-testid="main-app-surface"]').attributes('data-post-startup-features')).toBe('active');
    expect(wrapper.find('[data-testid="app-command-runtime"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="app-auxiliary-ui"]').exists()).toBe(true);
  });

  it('keeps the main app surface rendered while onboarding blocks post-startup features', async () => {
    appInteraction.value = 'blocked-by-onboarding';
    const wrapper = mountMainApp();
    await flushPromises();

    expect(wrapper.get('[data-testid="main-app-surface"]').attributes('data-post-startup-features')).toBe('inactive');
    expect(wrapper.find('[data-testid="app-command-runtime"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="app-auxiliary-ui"]').exists()).toBe(false);
  });
});
