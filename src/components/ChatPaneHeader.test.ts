import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ChatPaneHeader from './ChatPaneHeader.vue';
import type { Chat, ChatGroup } from '@/models/types';
import { toChatGroupId, toChatId } from '@/models/ids';

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: toChatId({ raw: 'chat-1' }),
    title: 'Header Chat',
    root: { items: [] },
    currentLeafId: undefined,
    debugEnabled: false,
    groupId: toChatGroupId({ raw: 'group-1' }),
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<ChatGroup> = {}): ChatGroup {
  return {
    id: toChatGroupId({ raw: 'group-1' }),
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
  activeMessageCount = 2,
}: {
  chat: Chat | null;
  groups: readonly ChatGroup[];
  activeMessageCount?: number;
}) {
  const currentGroup = chat?.groupId
    ? groups.find(group => group.id === chat.groupId)
    : undefined;

  return mount(ChatPaneHeader, {
    props: {
      chat,
      chatGroups: groups,
      chatGroupBadge: currentGroup,
      activeMessageCount,
      modelLabel: 'gpt-test (Group)',
      hasOverrides: true,
      showChatSettings: false,
      outlineVisibility: 'hidden',
      generatingTitle: false,
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

describe('ChatPaneHeader', () => {
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

  it('emits edit-title from the title edit button', async () => {
    const wrapper = mountHeader({
      chat: makeChat(),
      groups: [makeGroup()],
    });

    await wrapper.find('[data-testid="edit-title-button"]').trigger('click');

    expect(wrapper.emitted('edit-title')).toEqual([[]]);
  });

  it('animates the title text while title generation is running', () => {
    const wrapper = mount(ChatPaneHeader, {
      props: {
        chat: makeChat(),
        chatGroups: [makeGroup()],
        chatGroupBadge: makeGroup(),
        activeMessageCount: 2,
        modelLabel: 'gpt-test (Group)',
        hasOverrides: true,
        showChatSettings: false,
        outlineVisibility: 'hidden',
        generatingTitle: true,
        mediaShelfVisibility: 'hidden',
        isChatWeshTerminalOpen: false,
      },
    });

    expect(wrapper.find('[data-testid="chat-header-title"]').classes()).toContain('title-header-generating');
  });

  it('emits move-to-group from the move menu', async () => {
    const wrapper = mountHeader({
      chat: makeChat(),
      groups: [makeGroup(), makeGroup({ id: toChatGroupId({ raw: 'group-2' }), name: 'Archive' })],
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

  it('emits open-file-explorer from the more actions menu', async () => {
    const wrapper = mountHeader({
      chat: makeChat(),
      groups: [makeGroup()],
    });

    await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
    await wrapper.find('[data-testid="open-chat-file-explorer-button"]').trigger('click');

    expect(wrapper.emitted('open-file-explorer')).toEqual([[]]);
  });

  it('emits compact-context from the more actions menu', async () => {
    const wrapper = mountHeader({
      chat: makeChat(),
      groups: [makeGroup()],
      activeMessageCount: 7,
    });

    await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
    await wrapper.find('[data-testid="compact-context-button"]').trigger('click');

    expect(wrapper.emitted('compact-context')).toEqual([[]]);
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
