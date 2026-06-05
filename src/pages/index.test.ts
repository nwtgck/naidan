import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import IndexPage from './index.vue';
import CurrentChatPane from '@/components/CurrentChatPane.vue';

// Mock CurrentChatPane as it has many dependencies
vi.mock('../components/CurrentChatPane.vue', () => ({
  default: {
    name: 'CurrentChatPane',
    template: '<div data-testid="current-chat-pane"></div>',
  },
}));

describe('IndexPage', () => {
  it('renders CurrentChatPane', () => {
    const wrapper = mount(IndexPage);
    expect(wrapper.findComponent(CurrentChatPane).exists()).toBe(true);
  });
});
