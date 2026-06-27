import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, ref, shallowRef } from 'vue';
import { useSettings } from '@/composables/useSettings';
import type { StartupState } from '@/models/startup';
import StartupRoot from './StartupRoot.vue';

vi.mock('@/composables/useSettings', () => ({
  useSettings: vi.fn(),
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

vi.mock('@/components/startup/MainLayoutPreview.vue', () => ({
  default: {
    template: '<div data-testid="main-layout-preview" />',
  },
}));

vi.mock('@/components/startup/StartupErrorView.vue', () => ({
  default: {
    props: ['error'],
    template: '<div data-testid="startup-error">{{ String(error) }}</div>',
  },
}));

describe('StartupRoot', () => {
  const initialized = ref(true);
  const isOnboardingDismissed = ref(false);

  beforeEach(() => {
    initialized.value = true;
    isOnboardingDismissed.value = false;
    (useSettings as unknown as Mock).mockReturnValue({
      initialized,
      isOnboardingDismissed,
    });
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

  it('shows onboarding without the preview in the first onboarding state', () => {
    const { wrapper } = mountStartupRoot({
      state: {
        kind: 'waiting-for-onboarding',
        mainLayout: 'preview-not-rendered',
      },
    });

    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="main-layout-preview"]').exists()).toBe(false);
  });

  it('adds the preview without changing onboarding visibility', () => {
    const { wrapper } = mountStartupRoot({
      state: {
        kind: 'waiting-for-onboarding',
        mainLayout: 'preview-rendered',
      },
    });

    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="main-layout-preview"]').exists()).toBe(true);
  });

  it('reacts to onboarding dismissal without storing a second visibility state', async () => {
    const { wrapper } = mountStartupRoot({
      state: {
        kind: 'waiting-for-onboarding',
        mainLayout: 'preview-rendered',
      },
    });

    isOnboardingDismissed.value = true;
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(false);
  });

  it('supports runtime onboarding over the already-ready application', () => {
    const MainApplication = defineComponent({
      template: '<div data-testid="main-application" />',
    });
    const { wrapper } = mountStartupRoot({
      state: {
        kind: 'ready',
        mainApplication: MainApplication,
      },
    });

    expect(wrapper.find('[data-testid="main-application"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);
  });

  it('keeps onboarding hidden while the main application is starting', () => {
    const { wrapper } = mountStartupRoot({
      state: {
        kind: 'starting-main',
        mainLayout: 'preview-rendered',
      },
    });

    expect(wrapper.find('[data-testid="main-layout-preview"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(false);
  });
});
