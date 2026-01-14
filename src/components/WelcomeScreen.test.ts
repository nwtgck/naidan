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
});
