import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import WelcomeScreen from './WelcomeScreen.vue';

describe('WelcomeScreen.vue', () => {
  it('renders correctly with logo and suggestions', () => {
    const wrapper = mount(WelcomeScreen, {
      global: {
        stubs: { Logo: true, ShieldCheck: true },
      },
    });
    
    expect(wrapper.text()).toContain("Write a story");
    expect(wrapper.text()).toContain("All conversations are stored locally");
  });

  it('emits select-suggestion event when a suggestion is clicked', async () => {
    const wrapper = mount(WelcomeScreen, {
      global: {
        stubs: { Logo: true, ShieldCheck: true },
      },
    });
    
    const suggestionBtn = wrapper.findAll('button').find(b => b.text().includes('Write a story'));
    expect(suggestionBtn).toBeDefined();
    
    await suggestionBtn!.trigger('click');
    
    expect(wrapper.emitted('select-suggestion')).toBeTruthy();
    expect(wrapper.emitted('select-suggestion')![0]).toEqual(['Write a short story about a time-traveling detective in a cyberpunk city.']);
  });

  it('hides suggestions with animation classes when hasInput is true', async () => {
    const wrapper = mount(WelcomeScreen, {
      props: { hasInput: true },
      global: {
        stubs: { Logo: true, ShieldCheck: true },
      },
    });

    // The container should still be in the DOM (to avoid layout shift)
    const suggestionsContainer = wrapper.find('.pt-8.flex.flex-wrap');
    expect(suggestionsContainer.exists()).toBe(true);

    // It should have opacity-0 and pointer-events-none
    expect(suggestionsContainer.classes()).toContain('opacity-0');
    expect(suggestionsContainer.classes()).toContain('pointer-events-none');
    expect(suggestionsContainer.classes()).toContain('translate-y-2');
  });

  it('shows suggestions when hasInput is false', async () => {
    const wrapper = mount(WelcomeScreen, {
      props: { hasInput: false },
      global: {
        stubs: { Logo: true, ShieldCheck: true },
      },
    });

    const suggestionsContainer = wrapper.find('.pt-8.flex.flex-wrap');
    expect(suggestionsContainer.classes()).toContain('opacity-40');
    expect(suggestionsContainer.classes()).not.toContain('opacity-0');
    expect(suggestionsContainer.classes()).not.toContain('pointer-events-none');
  });
});
