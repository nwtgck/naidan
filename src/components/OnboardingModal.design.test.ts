import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount } from '@vue/test-utils';
import OnboardingModal from './OnboardingModal.vue';
import { useSettings } from '../composables/useSettings';
import { useToast } from '../composables/useToast';
import { useTheme } from '../composables/useTheme';

vi.mock('../services/llm');
vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(),
}));
vi.mock('../composables/useToast', () => ({
  useToast: vi.fn(),
}));
vi.mock('../composables/useTheme', () => ({
  useTheme: vi.fn(),
}));

describe('OnboardingModal Design Specifications', () => {
  beforeEach(() => {
    (useSettings as unknown as Mock).mockReturnValue({
      settings: { value: {} },
      save: vi.fn(),
      initialized: { value: true },
      isOnboardingDismissed: { value: false },
      onboardingDraft: { value: null },
    });
    (useToast as unknown as Mock).mockReturnValue({ addToast: vi.fn() });
    (useTheme as unknown as Mock).mockReturnValue({
      themeMode: { value: 'system' },
      setTheme: vi.fn(),
    });
  });

  it('uses modern soft-black (gray-800) for the main title and avoids harsh black', () => {
    const wrapper = mount(OnboardingModal);
    const title = wrapper.find('h2');
    expect(title.classes()).toContain('text-gray-800');
    expect(title.classes()).not.toContain('text-gray-900');
  });

  it('applies the signature interactive hover effect to the setup guide', () => {
    const wrapper = mount(OnboardingModal);
    const guideWrapper = wrapper.find('div[class*="opacity-70"][class*="hover:opacity-100"]');
    expect(guideWrapper.exists()).toBe(true);
    expect(guideWrapper.classes()).toContain('transition-opacity');
  });

  it('uses distinct layered backgrounds for the help column', () => {
    const wrapper = mount(OnboardingModal);
    const helpColumn = wrapper.find('div[class*="lg:w-[38%]"]');
    expect(helpColumn.exists()).toBe(true);
    expect(helpColumn.classes()).toContain('bg-gray-50/30');
    expect(helpColumn.classes()).toContain('border-gray-100');
  });

  it('uses high-end rounded corners (2xl) for the main container', () => {
    const wrapper = mount(OnboardingModal);
    const container = wrapper.find('.max-w-4xl');
    expect(container.classes()).toContain('rounded-2xl');
  });

  it('uses the brand blue (blue-600) for primary actions and avoids legacy indigo', () => {
    const wrapper = mount(OnboardingModal);
    const primaryBtn = wrapper.find('button.bg-blue-600');
    expect(primaryBtn.exists()).toBe(true);
    expect(primaryBtn.classes()).not.toContain('bg-indigo-600');
  });

  it('complies with the project-wide close button design pattern', () => {
    const wrapper = mount(OnboardingModal);
    const closeBtn = wrapper.find('[data-testid="onboarding-close-x"]');

    expect(closeBtn.classes()).toContain('rounded-xl');
    expect(closeBtn.classes()).toContain('hover:bg-gray-50');
    expect(closeBtn.classes()).toContain('transition-colors');
    expect(closeBtn.classes()).not.toContain('shadow-sm'); // Should not have shadow as per latest adjustment
  });

  it('implements the subtle backdrop blur for visual depth', () => {
    const wrapper = mount(OnboardingModal);
    const overlay = wrapper.find('div.fixed.inset-0');
    expect(overlay.classes()).toContain('backdrop-blur-[2px]');
  });
});
