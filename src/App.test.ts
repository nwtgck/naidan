import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, onMounted, ref, shallowRef } from 'vue';
import type { AppInteraction } from '@/composables/useAppPresentation';
import type { StartupState } from '@/logic/startup/types';
import App from './App.vue';

const appInteraction = ref<AppInteraction>('blocked-by-startup');

vi.mock('@/composables/useAppPresentation', () => ({
  provideAppPresentation: () => ({
    appInteraction,
    homeIntroduction: ref({ kind: 'inactive' }),
    continueHomeIntroduction: vi.fn(),
    finishHomeIntroduction: vi.fn(),
  }),
}));

vi.mock('@/composables/useAppEntry', () => ({ provideAppEntry: vi.fn() }));

vi.mock('@/components/GlobalDialogHost.vue', () => ({
  default: {
    template: '<div data-testid="global-dialog-host" />',
  },
}));

vi.mock('@/components/ToastContainer.vue', () => ({
  default: {
    template: '<div data-testid="toast-container" />',
  },
}));

vi.mock('@/components/startup/StartupErrorView.vue', () => ({
  default: {
    props: ['error'],
    template: '<div data-testid="startup-error">{{ String(error) }}</div>',
  },
}));

describe('App', () => {
  beforeEach(() => {
    appInteraction.value = 'blocked-by-startup';
  });

  function mountApp({ state }: {
    state: StartupState,
  }) {
    const startupState = shallowRef<StartupState>(state);
    return {
      startupState,
      wrapper: mount(App, {
        props: { startupState },
        global: {
          stubs: {
            transition: false,
          },
        },
      }),
    };
  }

  it('keeps the startup background inert while the main app starts', () => {
    const { wrapper } = mountApp({
      state: {
        kind: 'starting-main',
      },
    });

    expect(wrapper.find('[data-testid="startup-background"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="app-content-host"]').attributes('inert')).toBeDefined();
  });

  it('renders a prepared lightweight entry before the main application exists', () => {
    const EntrySurface = defineComponent({ template: '<div data-testid="early-entry" />' });
    const { wrapper } = mountApp({ state: { kind: 'starting-main', entrySurface: EntrySurface } });
    expect(wrapper.find('[data-testid="early-entry"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="startup-background"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="app-content-host"]').attributes('inert')).toBeDefined();
  });

  it('renders the real main app before releasing startup interaction', () => {
    const MainApp = defineComponent({
      template: '<div data-testid="main-app" />',
    });
    const { wrapper } = mountApp({
      state: {
        kind: 'rendering-main',
        mainApp: MainApp,
      },
    });

    expect(wrapper.find('[data-testid="main-app"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="app-content-host"]').attributes('aria-hidden')).toBe('true');
  });

  it('releases the startup interaction barrier without remounting the main app', async () => {
    const mounted = vi.fn();
    const MainApp = defineComponent({
      setup() {
        onMounted(mounted);
        return {};
      },
      template: '<div data-testid="main-app" />',
    });
    const { wrapper, startupState } = mountApp({
      state: {
        kind: 'rendering-main',
        mainApp: MainApp,
      },
    });

    expect(mounted).toHaveBeenCalledOnce();

    startupState.value = { kind: 'ready', mainApp: MainApp };
    appInteraction.value = 'enabled';
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="main-app"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="app-content-host"]').attributes('inert')).toBeUndefined();
    expect(mounted).toHaveBeenCalledOnce();
  });

  it('keeps the ready app mounted when startup interaction changes', async () => {
    const mounted = vi.fn();
    const MainApp = defineComponent({
      setup() {
        onMounted(mounted);
        return {};
      },
      template: '<div data-testid="main-app" />',
    });
    appInteraction.value = 'enabled';
    const { wrapper, startupState } = mountApp({
      state: {
        kind: 'ready',
        mainApp: MainApp,
      },
    });

    startupState.value = { kind: 'rendering-main', mainApp: MainApp };
    appInteraction.value = 'blocked-by-startup';
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="main-app"]').exists()).toBe(true);
    expect(mounted).toHaveBeenCalledOnce();
  });

  it('shows a startup error without a setup overlay', () => {
    const { wrapper } = mountApp({
      state: {
        kind: 'main-failed',
        error: new Error('failed'),
      },
    });

    expect(wrapper.find('[data-testid="startup-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(false);
  });
});
