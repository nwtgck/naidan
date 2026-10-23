import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppInteraction } from '@/composables/useAppPresentation';
import MainApp from './MainApp.vue';

const entryInteraction = ref<'blocked' | 'ready'>('ready');
const modelSelection = ref<unknown>();
vi.mock('@/composables/useAppEntry', () => ({ useAppEntry: () => ({ interaction: entryInteraction, modelSelection }) }));
const appInteraction = ref<AppInteraction>('enabled');

vi.mock('./composables/useAppPresentation', () => ({
  useAppPresentation: () => ({
    appInteraction,
    homeIntroduction: ref({ kind: 'inactive' }),
    finishHomeIntroduction: vi.fn(),
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
    props: ['pwaActivation'],
    template: '<div data-testid="app-auxiliary-ui" :data-pwa-activation="pwaActivation" />',
  },
}));

describe('MainApp', () => {
  beforeEach(() => {
    appInteraction.value = 'enabled';
    entryInteraction.value = 'ready';
    modelSelection.value = undefined;
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

  it('allows explicit model actions while deferring PWA activation through dialog dismissal', async () => {
    modelSelection.value = { phase: 'open' };
    appInteraction.value = 'blocked-by-model-selection';
    const wrapper = mountMainApp();
    await flushPromises();
    expect(wrapper.find('[data-testid="app-command-runtime"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="app-auxiliary-ui"]').attributes('data-pwa-activation')).toBe('deferred');
    modelSelection.value = { phase: 'closing' };
    await flushPromises();
    expect(wrapper.get('[data-testid="app-auxiliary-ui"]').attributes('data-pwa-activation')).toBe('deferred');
    modelSelection.value = undefined;
    await flushPromises();
    expect(wrapper.get('[data-testid="app-auxiliary-ui"]').attributes('data-pwa-activation')).toBe('active');
  });

  it('keeps the main app surface rendered while startup blocks post-startup features', async () => {
    appInteraction.value = 'blocked-by-startup';
    entryInteraction.value = 'blocked';
    const wrapper = mountMainApp();
    await flushPromises();

    expect(wrapper.get('[data-testid="main-app-surface"]').attributes('data-post-startup-features')).toBe('inactive');
    expect(wrapper.find('[data-testid="app-command-runtime"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="app-auxiliary-ui"]').exists()).toBe(false);
  });
});
