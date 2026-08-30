import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { mount } from '@vue/test-utils';
import OnboardingModal from './OnboardingModal.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

// Mocking dependencies
vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: { value: {} },
    save: vi.fn(),
    initialized: { value: true },
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
          XIcon: true,
          PlayIcon: true,
          ArrowLeftIcon: true,
          ActivityIcon: true,
          SettingsIcon: true,
        },
      },
    });

    const githubLink = wrapper.find('a[href*="github.com"]');
    expect(githubLink.exists()).toBe(false);
  });
});
