import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount } from '@vue/test-utils';
import OnboardingModal from './OnboardingModal.vue';
import { useSettings } from '../composables/useSettings';
import { useToast } from '../composables/useToast';

vi.mock('../services/llm');
vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(),
}));
vi.mock('../composables/useToast', () => ({
  useToast: vi.fn(),
}));

describe('OnboardingModal Design Specifications', () => {
  beforeEach(() => {
    (useSettings as unknown as Mock).mockReturnValue({
      settings: { value: {} },
      save: vi.fn(),
      initialized: { value: true },
      isOnboardingDismissed: { value: false },
    });
    (useToast as unknown as Mock).mockReturnValue({ addToast: vi.fn() });
  });

  it('uses modern soft-black (gray-800) for the main title instead of harsh black', () => {
    const wrapper = mount(OnboardingModal);
    const title = wrapper.find('h2');
    expect(title.classes()).toContain('text-gray-800');
    expect(title.classes()).not.toContain('text-gray-900');
  });

  it('applies the signature interactive hover effect to the setup guide', () => {
    const wrapper = mount(OnboardingModal);
    // Escape the colon in Tailwind hover:opacity-100
    const guideWrapper = wrapper.find('.opacity-70.hover\\:opacity-100');
    expect(guideWrapper.exists()).toBe(true);
    expect(guideWrapper.classes()).toContain('transition-opacity');
  });

  it('uses distinct layered backgrounds for the help column', () => {
    const wrapper = mount(OnboardingModal);
    // Find the right column by its structural class (using a safer substring match or escaped selector)
    const helpColumn = wrapper.find('div.lg\\:w-\\[38\\%\\]');
    expect(helpColumn.exists()).toBe(true);
    expect(helpColumn.classes()).toContain('bg-gray-50/30');
    expect(helpColumn.classes()).toContain('border-gray-100');
  });

  it('uses high-end rounded corners (2xl) for the main container', () => {
    const wrapper = mount(OnboardingModal);
    const container = wrapper.find('.max-w-4xl');
    expect(container.classes()).toContain('rounded-2xl');
  });

  it('uses the brand blue (blue-600) for primary actions', () => {
    const wrapper = mount(OnboardingModal);
    const primaryBtn = wrapper.find('button.bg-blue-600');
    expect(primaryBtn.exists()).toBe(true);
    // Ensure we are not using indigo anymore
    expect(primaryBtn.classes()).not.toContain('bg-indigo-600');
  });
});
