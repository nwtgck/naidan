import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MainApp from './MainApp.vue';

const appInteraction = ref<
  | 'blocked-by-startup'
  | 'blocked-by-onboarding'
  | 'blocked-by-operation'
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
    emits: ['initialShellRendered', 'initialShellRenderFailed'],
    setup() {
      return {
        reportFailure: () => ({ error: new Error('route failed') }),
      };
    },
    template: '<div><button data-testid="main-app-surface" :data-post-startup-features="postStartupFeatures" @click="$emit(\'initialShellRendered\')" /><button data-testid="main-app-surface-failure" @click="$emit(\'initialShellRenderFailed\', reportFailure())" /></div>',
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
    props: ['mode'],
    emits: ['initialPresentationRendered', 'initialPresentationRenderFailed'],
    setup() {
      return {
        reportFailure: () => ({ error: new Error('auxiliary failed') }),
      };
    },
    template: '<div data-testid="app-auxiliary-ui" :data-mode="mode"><button data-testid="app-auxiliary-ui-ready" @click="$emit(\'initialPresentationRendered\')" /><button data-testid="app-auxiliary-ui-failure" @click="$emit(\'initialPresentationRenderFailed\', reportFailure())" /></div>',
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

  it('reports the initial application shell only after the surface and auxiliary presentation are both ready', async () => {
    const wrapper = mountMainApp();
    await flushPromises();

    await wrapper.get('[data-testid="main-app-surface"]').trigger('click');
    expect(wrapper.emitted('initialShellRendered')).toBeUndefined();

    await wrapper.get('[data-testid="app-auxiliary-ui-ready"]').trigger('click');
    expect(wrapper.emitted('initialShellRendered')).toHaveLength(1);
  });

  it('forwards an initial application shell render failure', async () => {
    const wrapper = mountMainApp();

    await wrapper.get('[data-testid="main-app-surface-failure"]').trigger('click');

    expect(wrapper.emitted('initialShellRenderFailed')).toHaveLength(1);
    expect(wrapper.emitted('initialShellRenderFailed')?.[0]?.[0]).toEqual({
      error: new Error('route failed'),
    });
  });


  it('forwards an auxiliary presentation failure while the initial shell is pending', async () => {
    const wrapper = mountMainApp();
    await flushPromises();

    await wrapper.get('[data-testid="app-auxiliary-ui-failure"]').trigger('click');

    expect(wrapper.emitted('initialShellRenderFailed')).toHaveLength(1);
    expect(wrapper.emitted('initialShellRenderFailed')?.[0]?.[0]).toEqual({
      error: new Error('auxiliary failed'),
    });
  });

  it('prepares route-driven auxiliary presentation behind the encrypted startup lock', async () => {
    appInteraction.value = 'blocked-by-startup';
    const wrapper = mountMainApp();
    await flushPromises();

    expect(wrapper.get('[data-testid="main-app-surface"]').attributes('data-post-startup-features')).toBe('inactive');
    expect(wrapper.find('[data-testid="app-command-runtime"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="app-auxiliary-ui"]').attributes('data-mode')).toBe('preparing');
  });

  it('does not remount auxiliary UI when a local operation blocks the ready app', async () => {
    const wrapper = mountMainApp();
    await flushPromises();
    const auxiliaryElement = wrapper.get('[data-testid="app-auxiliary-ui"]').element;

    appInteraction.value = 'blocked-by-operation';
    await flushPromises();

    const blockedAuxiliary = wrapper.get('[data-testid="app-auxiliary-ui"]');
    expect(blockedAuxiliary.element).toBe(auxiliaryElement);
    expect(blockedAuxiliary.attributes('data-mode')).toBe('active');
  });

  it('keeps the operation-owned auxiliary UI mounted while commands remain inactive', async () => {
    appInteraction.value = 'blocked-by-operation';
    const wrapper = mountMainApp();
    await flushPromises();

    expect(wrapper.get('[data-testid="main-app-surface"]').attributes('data-post-startup-features')).toBe('inactive');
    expect(wrapper.find('[data-testid="app-command-runtime"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="app-auxiliary-ui"]').attributes('data-mode')).toBe('active');
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
