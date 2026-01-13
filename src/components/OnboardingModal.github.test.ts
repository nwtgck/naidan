import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import OnboardingModal from './OnboardingModal.vue';

// Mocking dependencies
vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: { value: {} },
    save: vi.fn(),
    isOnboardingDismissed: { value: false },
    onboardingDraft: { value: null },
  }),
}));

vi.mock('../composables/useToast', () => ({
  useToast: () => ({
    addToast: vi.fn(),
  }),
}));

describe('OnboardingModal GitHub Link', () => {
  it('should NOT contain GitHub repository link per local-first design', async () => {
    const wrapper = mount(OnboardingModal, {
      global: {
        stubs: {
          Logo: true,
          ThemeToggle: true,
          ServerSetupGuide: true,
          X: true,
          Play: true,
          ArrowLeft: true,
          Activity: true,
          Settings: true,
        }
      }
    });

    const githubLink = wrapper.find('a[href*="github.com"]');
    expect(githubLink.exists()).toBe(false);
  });
});
