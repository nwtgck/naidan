import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import IndexPage from './index.vue';
import ChatArea from '../components/ChatArea.vue';

// Mock ChatArea as it has many dependencies
vi.mock('../components/ChatArea.vue', () => ({
  default: {
    name: 'ChatArea',
    template: '<div data-testid="chat-area"></div>'
  }
}));

describe('IndexPage', () => {
  it('renders ChatArea', () => {
    const wrapper = mount(IndexPage);
    expect(wrapper.findComponent(ChatArea).exists()).toBe(true);
  });
});
