import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import WelcomeScreen from './WelcomeScreen.vue';

describe('WelcomeScreen.vue', () => {
  it('renders the main security message', () => {
    const wrapper = mount(WelcomeScreen);
    expect(wrapper.text()).toContain('All conversations are stored locally.');
    expect(wrapper.text()).toContain('Your data stays on your device.');
  });

  it('renders suggestions', () => {
    const wrapper = mount(WelcomeScreen);
    const buttons = wrapper.findAll('button');
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons[0]!.text()).toBe('Write a story');
  });

  it('emits select-suggestion when a suggestion is clicked', async () => {
    const wrapper = mount(WelcomeScreen);
    const buttons = wrapper.findAll('button');
    await buttons[0]!.trigger('click');
    
    expect(wrapper.emitted('select-suggestion')).toBeTruthy();
    expect(wrapper.emitted('select-suggestion')![0]![0]).toContain('Write a short story');
  });

  it('behaves like a wallpaper (absolute positioning and centered)', () => {
    const wrapper = mount(WelcomeScreen);
    const container = wrapper.find('div'); // Root div
    expect(container.classes()).toContain('absolute');
    expect(container.classes()).toContain('inset-0');
    expect(container.classes()).toContain('items-center');
    expect(container.classes()).toContain('justify-center');
    expect(container.classes()).toContain('pointer-events-none');
  });

  it('hides suggestions when hasInput is true', () => {
    const wrapper = mount(WelcomeScreen, {
      props: {
        hasInput: true
      }
    });

    const suggestionsContainer = wrapper.find('[data-testid="suggestions-container"]');
    expect(suggestionsContainer.classes()).toContain('opacity-0');
    expect(suggestionsContainer.classes()).toContain('pointer-events-none');
    expect(suggestionsContainer.classes()).not.toContain('opacity-40');
  });

  it('shows suggestions when hasInput is false', () => {
    const wrapper = mount(WelcomeScreen, {
      props: {
        hasInput: false
      }
    });

    const suggestionsContainer = wrapper.find('[data-testid="suggestions-container"]');
    expect(suggestionsContainer.classes()).toContain('opacity-40');
    expect(suggestionsContainer.classes()).not.toContain('opacity-0');
    expect(suggestionsContainer.classes()).not.toContain('pointer-events-none');
  });

  it('is responsive (has small screen utility classes)', () => {
    const wrapper = mount(WelcomeScreen);
    const contentBox = wrapper.find('.w-full.max-w-4xl');
    
    // Check for responsive translate-y
    expect(contentBox.classes()).toContain('translate-y-[-25%]');
    expect(contentBox.classes()).toContain('sm:translate-y-[-30%]');
    
    // Check for responsive spacing
    expect(contentBox.classes()).toContain('space-y-8');
    expect(contentBox.classes()).toContain('sm:space-y-12');
  });
});
