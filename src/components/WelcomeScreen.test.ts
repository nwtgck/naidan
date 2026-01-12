import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import WelcomeScreen from './WelcomeScreen.vue';

describe('WelcomeScreen.vue', () => {
  it('renders correctly with logo and heading', () => {
    const wrapper = mount(WelcomeScreen, {
      global: {
        stubs: { Logo: true, Sparkles: true, PenTool: true, Code: true, Lightbulb: true, Zap: true },
      },
    });
    
    expect(wrapper.text()).toContain("What's on your mind?");
    expect(wrapper.text()).toContain("Start a conversation or try one of these suggestions:");
    expect(wrapper.text()).toContain("Your privacy matters");
  });

  it('emits select-suggestion event when a suggestion is clicked', async () => {
    const wrapper = mount(WelcomeScreen, {
      global: {
        stubs: { Logo: true, Sparkles: true, PenTool: true, Code: true, Lightbulb: true, Zap: true },
      },
    });
    
    const suggestionBtn = wrapper.findAll('button').find(b => b.text().includes('Write a story'));
    expect(suggestionBtn).toBeDefined();
    
    await suggestionBtn!.trigger('click');
    
    expect(wrapper.emitted('select-suggestion')).toBeTruthy();
    expect(wrapper.emitted('select-suggestion')![0]).toEqual(['Write a short story about a time-traveling detective in a cyberpunk city.']);
  });
});
