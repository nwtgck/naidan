import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ChatAreaHeader from './ChatAreaHeader.vue';
import type { Chat, ChatGroup } from '@/models/types';

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat-1',
    title: 'Header Chat',
    root: { items: [] },
    currentLeafId: undefined,
    debugEnabled: false,
    groupId: 'group-1',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<ChatGroup> = {}): ChatGroup {
  return {
    id: 'group-1',
    name: 'Research',
    isCollapsed: false,
    items: [],
    updatedAt: 2,
    ...overrides,
  };
}

function mountHeader({
  chat,
  groups,
}: {
  chat: Chat | null;
  groups: readonly ChatGroup[];
}) {
  const currentGroup = chat?.groupId
    ? groups.find(group => group.id === chat.groupId)
    : undefined;

  return mount(ChatAreaHeader, {
    props: {
      currentChat: chat,
      chatGroups: groups,
      currentChatGroupBadge: currentGroup,
      activeMessageCount: 2,
      modelLabel: 'gpt-test (Group)',
      hasOverrides: true,
      showChatSettings: false,
      outlineVisibility: 'hidden',
      generatingTitle: false,
      isCurrentChatStreaming: false,
      mediaShelfVisibility: 'hidden',
      isChatWeshTerminalOpen: false,
    },
    global: {
      stubs: {
        Transition: true,
      },
    },
  });
}

describe('ChatAreaHeader', () => {
  it('renders chat identity badges and emits settings updates', async () => {
    const wrapper = mountHeader({
      chat: makeChat(),
      groups: [makeGroup()],
    });

    expect(wrapper.find('[data-testid="chat-group-badge"]').text()).toContain('Research');
    expect(wrapper.find('[data-testid="model-trigger"]').text()).toContain('gpt-test (Group)');

    await wrapper.find('[data-testid="model-trigger"]').trigger('click');

    expect(wrapper.emitted('update:show-chat-settings')).toEqual([[true]]);
  });

  it('emits move-to-group from the move menu', async () => {
    const wrapper = mountHeader({
      chat: makeChat(),
      groups: [makeGroup(), makeGroup({ id: 'group-2', name: 'Archive' })],
    });

    await wrapper.find('[data-testid="move-to-group-button"]').trigger('click');
    const archiveButton = wrapper.findAll('button').find(button => button.text().includes('Archive'));
    if (!archiveButton) throw new Error('Archive group button was not rendered');
    await archiveButton.trigger('click');

    expect(wrapper.emitted('move-to-group')).toEqual([['group-2']]);
  });

  it('emits more menu actions', async () => {
    const wrapper = mountHeader({
      chat: makeChat(),
      groups: [makeGroup()],
    });

    await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
    expect(wrapper.find('[data-testid="print-chat-button"]').exists()).toBe(true);

    await wrapper.find('[data-testid="print-chat-button"]').trigger('click');

    expect(wrapper.emitted('print')).toEqual([[]]);
  });

  it('keeps the more menu open on mouseleave and closes it on outside click', async () => {
    const wrapper = mountHeader({
      chat: makeChat(),
      groups: [makeGroup()],
    });

    await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
    expect(wrapper.find('[data-testid="open-chat-wesh-terminal-button"]').exists()).toBe(true);

    await wrapper.find('[data-testid="open-chat-wesh-terminal-button"]').trigger('mouseleave');
    expect(wrapper.find('[data-testid="open-chat-wesh-terminal-button"]').exists()).toBe(true);

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await nextTick();

    expect(wrapper.find('[data-testid="open-chat-wesh-terminal-button"]').exists()).toBe(false);
  });
});
