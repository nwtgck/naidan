import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ChatSidebarActionsView from './ChatSidebarActionsView.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('the lightweight Chat actions presentation', () => {
  it.each([true, false])('preserves the ready button styling while preparing when expanded is %s', async expanded => {
    const wrapper = mount(ChatSidebarActionsView, { props: { expanded, contentReady: true, interaction: 'ready', groupContext: { name: 'Group A' } } });
    using cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const buttons = wrapper.findAll('button');
    const readyClasses = buttons.map(button => button.classes());
    expect(buttons).toHaveLength(3);
    const create = wrapper.get('[data-testid="new-chat-button"]');
    expect(create.classes()).toContain('bg-blue-600');
    expect(create.classes()).toContain('shadow-lg');
    expect(create.classes()).toContain('font-bold');
    if (expanded) {
      expect(create.classes()).toContain('py-2');
      expect(create.classes()).toContain('px-3');
      expect(wrapper.get('[data-testid="search-button"]').classes()).toContain('p-2');
      expect(wrapper.get('[data-testid="create-chat-group-button"]').classes()).toContain('p-2');
    }
    for (const button of buttons) {
      expect(button.classes()).not.toContain('min-h-9');
      expect(button.classes()).not.toContain('min-w-9');
      if (!expanded) {
        expect(button.classes()).toContain('w-8');
        expect(button.classes()).toContain('h-8');
      }
    }
    await wrapper.setProps({ interaction: 'preparing', contentReady: false });
    expect(wrapper.attributes('inert')).toBeDefined();
    expect(wrapper.attributes('aria-hidden')).toBe('true');
    expect(wrapper.findAll('button').map(button => button.classes())).toEqual(readyClasses);
    for (const button of wrapper.findAll('button')) {
      await button.trigger('click');
    }
    expect(wrapper.emitted('newChat')).toBeUndefined();
    expect(wrapper.emitted('newChatInGroup')).toBeUndefined();
    expect(wrapper.emitted('search')).toBeUndefined();
    expect(wrapper.emitted('createChatGroup')).toBeUndefined();
    await wrapper.setProps({ interaction: 'ready', contentReady: true });
    expect(wrapper.attributes('inert')).toBeUndefined();
    await create.trigger('click');
    expect(wrapper.emitted('newChat')).toEqual([[]]);
    void cleanup;
  });
});
