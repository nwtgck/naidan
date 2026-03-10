import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import AssistantWaitingIndicator from './AssistantWaitingIndicator.vue';

describe('AssistantWaitingIndicator', () => {
  it('renders the waiting message and spinner', () => {
    const wrapper = mount(AssistantWaitingIndicator);
    expect(wrapper.text()).toContain('Waiting for response...');
    expect(wrapper.find('.animate-spin').exists()).toBe(true);
  });

  it('applies padding by default', () => {
    const wrapper = mount(AssistantWaitingIndicator);
    expect(wrapper.find('.flex').classes()).toContain('py-2');
  });

  it('removes padding when noPadding is true', () => {
    const wrapper = mount(AssistantWaitingIndicator, {
      props: { noPadding: true }
    });
    expect(wrapper.find('.flex').classes()).not.toContain('py-2');
  });

  it('applies nested horizontal padding when isNested is true and not noPadding', () => {
    const wrapper = mount(AssistantWaitingIndicator, {
      props: { isNested: true }
    });
    expect(wrapper.find('.flex').classes()).toContain('px-5');
  });

  it('does NOT apply nested horizontal padding when noPadding is true even if isNested is true', () => {
    const wrapper = mount(AssistantWaitingIndicator, {
      props: { isNested: true, noPadding: true }
    });
    expect(wrapper.find('.flex').classes()).not.toContain('px-5');
  });
});
