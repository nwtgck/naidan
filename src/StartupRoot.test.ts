import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, onMounted, ref, shallowRef } from 'vue';
import type {
  ApplicationInteraction,
  OnboardingPresentation,
} from '@/composables/useApplicationPresentation';
import type { StartupState } from '@/models/startup';
import StartupRoot from './StartupRoot.vue';

const onboardingPresentation = ref<OnboardingPresentation>('visible');
const applicationInteraction = ref<ApplicationInteraction>('blocked-by-onboarding');

vi.mock('@/composables/useApplicationPresentation', () => ({
  provideApplicationPresentation: () => ({
    onboardingPresentation,
    applicationInteraction,
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

describe('StartupRoot', () => {
  beforeEach(() => {
    onboardingPresentation.value = 'visible';
    applicationInteraction.value = 'blocked-by-onboarding';
  });

  function mountStartupRoot({ state }: {
    state: StartupState,
  }) {
    const startupState = shallowRef<StartupState>(state);
    return {
      startupState,
      wrapper: mount(StartupRoot, {
        props: { startupState },
        global: {
          stubs: {
            transition: false,
          },
        },
      }),
    };
  }

  it('shows onboarding over the startup background while the main application starts', () => {
    const { wrapper } = mountStartupRoot({
      state: {
        kind: 'starting-main',
      },
    });

    expect(wrapper.find('[data-testid="startup-background"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="main-application-host"]').attributes('inert')).toBeDefined();
  });

  it('renders the real main application behind onboarding before dismissal', () => {
    const MainApplication = defineComponent({
      template: '<div data-testid="main-application" />',
    });
    const { wrapper } = mountStartupRoot({
      state: {
        kind: 'rendering-main',
        mainApplication: MainApplication,
      },
    });

    expect(wrapper.find('[data-testid="main-application"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="main-application-host"]').attributes('aria-hidden')).toBe('true');
  });

  it('removes only the onboarding presentation and interaction barrier on dismissal', async () => {
    const mounted = vi.fn();
    const MainApplication = defineComponent({
      setup() {
        onMounted(mounted);
        return {};
      },
      template: '<div data-testid="main-application" />',
    });
    const { wrapper } = mountStartupRoot({
      state: {
        kind: 'ready',
        mainApplication: MainApplication,
      },
    });

    expect(mounted).toHaveBeenCalledOnce();

    onboardingPresentation.value = 'hidden';
    applicationInteraction.value = 'enabled';
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="main-application"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="main-application-host"]').attributes('inert')).toBeUndefined();
    expect(mounted).toHaveBeenCalledOnce();
  });

  it('supports runtime onboarding without remounting the ready application', async () => {
    const mounted = vi.fn();
    const MainApplication = defineComponent({
      setup() {
        onMounted(mounted);
        return {};
      },
      template: '<div data-testid="main-application" />',
    });
    onboardingPresentation.value = 'hidden';
    applicationInteraction.value = 'enabled';
    const { wrapper } = mountStartupRoot({
      state: {
        kind: 'ready',
        mainApplication: MainApplication,
      },
    });

    onboardingPresentation.value = 'visible';
    applicationInteraction.value = 'blocked-by-onboarding';
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="main-application"]').exists()).toBe(true);
    expect(mounted).toHaveBeenCalledOnce();
  });

  it('keeps onboarding usable over a main startup error', () => {
    const { wrapper } = mountStartupRoot({
      state: {
        kind: 'main-failed',
        error: new Error('failed'),
      },
    });

    expect(wrapper.find('[data-testid="startup-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);
  });
});
