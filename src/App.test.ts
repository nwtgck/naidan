import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, onMounted, ref, shallowRef } from 'vue';
import type {
  AppInteraction,
  OnboardingPresentation,
} from '@/composables/useAppPresentation';
import type { StartupState } from '@/logic/startup/types';
import type { OpfsEncryptionStartupGate } from '@/logic/startup/opfs-encryption-startup-gate';
import App from './App.vue';

const onboardingPresentation = ref<OnboardingPresentation>('visible');
const appInteraction = ref<AppInteraction>('blocked-by-onboarding');

vi.mock('@/composables/useAppPresentation', () => ({
  provideAppPresentation: () => ({
    onboardingPresentation,
    appInteraction,
  }),
}));

vi.mock('@/components/OnboardingModal.vue', () => ({
  default: {
    template: '<div data-testid="onboarding-modal" />',
  },
}));

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

function createStartupGate(): OpfsEncryptionStartupGate {
  return {
    inspection: shallowRef({
      type: 'recovery_required',
      error: new Error('test gate'),
    }),
    phase: shallowRef('preparing_application'),
    applicationError: shallowRef(undefined),
    progress: shallowRef(undefined),
    unlockWithPassphrase: vi.fn(async () => {}),
    returnInterruptedEncryptionToPlain: vi.fn(async () => {}),
    retryInspection: vi.fn(async () => {}),
    reportApplicationFailure: vi.fn(),
    reportUnlockPresentationReady: vi.fn(),
    wait: vi.fn(async () => {}),
    waitForUnlockPresentation: vi.fn(async () => {}),
  };
}

describe('App', () => {
  beforeEach(() => {
    onboardingPresentation.value = 'visible';
    appInteraction.value = 'blocked-by-onboarding';
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
            OpfsEncryptionUnlockView: defineComponent({
              name: 'OpfsEncryptionUnlockViewStub',
              props: ['gate'],
              template: '<div data-testid="opfs-encryption-unlock-view" />',
            }),
          },
        },
      }),
    };
  }

  it('shows onboarding over the startup background while the main app starts', () => {
    const { wrapper } = mountApp({
      state: {
        kind: 'starting-main',
      },
    });

    expect(wrapper.find('[data-testid="startup-background"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="app-content-host"]').attributes('inert')).toBeDefined();
  });

  it('renders the real main app behind onboarding before dismissal', () => {
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
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="app-content-host"]').attributes('aria-hidden')).toBe('true');
  });

  it('keeps the unlock view in front until the real app reports its initial shell render', async () => {
    const MainApp = defineComponent({
      emits: ['initialShellRendered'],
      template: '<button data-testid="main-app" @click="$emit(\'initialShellRendered\')" />',
    });
    onboardingPresentation.value = 'hidden';
    appInteraction.value = 'blocked-by-startup';
    const gate = createStartupGate();
    const reportInitialRender = vi.fn();
    const { wrapper } = mountApp({
      state: {
        kind: 'rendering-main-after-opfs-unlock',
        gate,
        mainApp: MainApp,
        renderGate: {
          reportInitialRender,
          reportInitialRenderFailure: vi.fn(),
          waitForInitialRender: vi.fn(async () => {}),
        },
      },
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="main-app"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="opfs-encryption-unlock-view"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="app-content-host"]').attributes('inert')).toBeDefined();

    await wrapper.get('[data-testid="main-app"]').trigger('click');
    expect(reportInitialRender).toHaveBeenCalledOnce();
  });

  it('reports initial route preparation failures to the encrypted render gate', async () => {
    const error = new Error('chat could not open');
    const MainApp = defineComponent({
      emits: ['initialShellRenderFailed'],
      setup(_, { emit }) {
        onMounted(() => {
          emit('initialShellRenderFailed', { error });
        });
        return {};
      },
      template: '<div data-testid="main-app" />',
    });
    onboardingPresentation.value = 'hidden';
    appInteraction.value = 'blocked-by-startup';
    const reportInitialRenderFailure = vi.fn();
    mountApp({
      state: {
        kind: 'rendering-main-after-opfs-unlock',
        gate: createStartupGate(),
        mainApp: MainApp,
        renderGate: {
          reportInitialRender: vi.fn(),
          reportInitialRenderFailure,
          waitForInitialRender: vi.fn(async () => {}),
        },
      },
    });
    await flushPromises();

    expect(reportInitialRenderFailure).toHaveBeenCalledWith({ error });
  });

  it('removes only the onboarding presentation and interaction barrier on dismissal', async () => {
    const mounted = vi.fn();
    const MainApp = defineComponent({
      setup() {
        onMounted(mounted);
        return {};
      },
      template: '<div data-testid="main-app" />',
    });
    const { wrapper } = mountApp({
      state: {
        kind: 'ready',
        mainApp: MainApp,
      },
    });

    expect(mounted).toHaveBeenCalledOnce();

    onboardingPresentation.value = 'hidden';
    appInteraction.value = 'enabled';
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="main-app"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="app-content-host"]').attributes('inert')).toBeUndefined();
    expect(mounted).toHaveBeenCalledOnce();
  });

  it('keeps the ready app mounted and inert while a generic operation blocks interaction', async () => {
    const mounted = vi.fn();
    const MainApp = defineComponent({
      setup() {
        onMounted(mounted);
        return {};
      },
      template: '<div data-testid="main-app" />',
    });
    onboardingPresentation.value = 'hidden';
    appInteraction.value = 'enabled';
    const { wrapper } = mountApp({
      state: {
        kind: 'ready',
        mainApp: MainApp,
      },
    });

    appInteraction.value = 'blocked-by-operation';
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="main-app"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="app-content-host"]').attributes('inert')).toBeDefined();
    expect(wrapper.find('[data-testid="app-content-host"]').attributes('aria-hidden')).toBe('true');
    expect(mounted).toHaveBeenCalledOnce();
  });

  it('supports runtime onboarding without remounting the ready app', async () => {
    const mounted = vi.fn();
    const MainApp = defineComponent({
      setup() {
        onMounted(mounted);
        return {};
      },
      template: '<div data-testid="main-app" />',
    });
    onboardingPresentation.value = 'hidden';
    appInteraction.value = 'enabled';
    const { wrapper } = mountApp({
      state: {
        kind: 'ready',
        mainApp: MainApp,
      },
    });

    onboardingPresentation.value = 'visible';
    appInteraction.value = 'blocked-by-onboarding';
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="main-app"]').exists()).toBe(true);
    expect(mounted).toHaveBeenCalledOnce();
  });

  it('keeps onboarding usable over a main startup error', () => {
    const { wrapper } = mountApp({
      state: {
        kind: 'main-failed',
        error: new Error('failed'),
      },
    });

    expect(wrapper.find('[data-testid="startup-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);
  });
});
