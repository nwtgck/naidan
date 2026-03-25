import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import AssistantWaitingIndicator from './AssistantWaitingIndicator.vue';

describe('AssistantWaitingIndicator', () => {
  it('renders the label and three breathing orbs', () => {
    const wrapper = mount(AssistantWaitingIndicator);
    expect(wrapper.text()).toContain('Waiting for response...');
    expect(wrapper.find('.wi-orbs').exists()).toBe(true);
    expect(wrapper.findAll('.wi-orb')).toHaveLength(3);
  });

  it('does not render a spinner', () => {
    const wrapper = mount(AssistantWaitingIndicator);
    expect(wrapper.find('.animate-spin').exists()).toBe(false);
  });

  it('has the correct testid', () => {
    const wrapper = mount(AssistantWaitingIndicator);
    expect(wrapper.find('[data-testid="assistant-waiting-indicator"]').exists()).toBe(true);
  });

  it('applies padding by default', () => {
    const wrapper = mount(AssistantWaitingIndicator);
    expect(wrapper.find('[data-testid="assistant-waiting-indicator"]').classes()).toContain('py-2');
  });

  it('removes padding when noPadding is true', () => {
    const wrapper = mount(AssistantWaitingIndicator, {
      props: { noPadding: true }
    });
    expect(wrapper.find('[data-testid="assistant-waiting-indicator"]').classes()).not.toContain('py-2');
  });

  it('applies nested horizontal padding when isNested is true and not noPadding', () => {
    const wrapper = mount(AssistantWaitingIndicator, {
      props: { isNested: true }
    });
    expect(wrapper.find('[data-testid="assistant-waiting-indicator"]').classes()).toContain('px-5');
  });

  it('does NOT apply nested horizontal padding when noPadding is true even if isNested is true', () => {
    const wrapper = mount(AssistantWaitingIndicator, {
      props: { isNested: true, noPadding: true }
    });
    expect(wrapper.find('[data-testid="assistant-waiting-indicator"]').classes()).not.toContain('px-5');
  });
});
