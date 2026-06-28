import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { toChatId } from '@/01-models/ids';
import ChatChoicesPanel from './ChatChoicesPanel.vue';

function mountPanel() {
  return mount(ChatChoicesPanel, {
    props: {
      request: {
        requestId: 'choice-request',
        chatId: toChatId({ raw: 'chat-a' }),
        prompt: 'Choose the next topic',
        choices: ['Implementation', 'Testing', 'Alternatives'],
      },
    },
  });
}

describe('ChatChoicesPanel', () => {
  it('renders the prompt and all choices', () => {
    const wrapper = mountPanel();

    expect(wrapper.text()).toContain('Choose the next topic');
    expect(wrapper.get('[data-testid="chat-choice-0"]').text()).toBe('Implementation');
    expect(wrapper.get('[data-testid="chat-choice-1"]').text()).toBe('Testing');
    expect(wrapper.get('[data-testid="chat-choice-2"]').text()).toBe('Alternatives');
  });

  it('emits the selected zero-based index and immediately disables all choices', async () => {
    const wrapper = mountPanel();

    await wrapper.get('[data-testid="chat-choice-1"]').trigger('click');

    expect(wrapper.emitted('select')).toEqual([[1]]);
    expect(wrapper.findAll('button').every((button) => button.attributes('disabled') !== undefined)).toBe(true);
  });
});
