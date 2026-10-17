import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { mount, enableAutoUnmount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ChatPaneHeader from './ChatPaneHeader.vue';
import type { Chat, ChatGroup } from '@/01-models/types';
import { toChatGroupId, toChatId } from '@/01-models/ids';

enableAutoUnmount(afterEach);

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

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
  renderMode,
  activeMessageCount,
}: {
  chat: Chat | null,
  groups: readonly ChatGroup[],
  renderMode: 'inline' | 'floating',
  activeMessageCount?: number,
}) {
  const currentGroup = chat?.groupId
    ? groups.find(group => group.id === chat.groupId)
    : undefined;

  return mount(ChatPaneHeader, {
    attachTo: renderMode === 'floating' ? document.body : undefined,
    props: {
      chat,
      chatGroups: groups,
      chatGroupBadge: currentGroup,
      activeMessageCount: activeMessageCount ?? 2,
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
        Teleport: renderMode === 'inline',
      },
    },
  });
}

async function clickElement({ element }: { element: Element }) {
  element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  // Separate pointer interactions, as the shared outside-click listener does.
  await new Promise(resolve => setTimeout(resolve, 0));
  await nextTick();
}

function getFloatingPanel({ kind }: { kind: 'more' | 'move' }) {
  const content = document.querySelector<HTMLElement>(`[data-testid="chat-header-${kind}-menu"]`);
  if (!content?.parentElement) {
    throw new Error(`Missing floating ${kind} menu`);
  }
  return content.parentElement;
}

describe('ChatPaneHeader', () => {
  it('separates the debug toggle from the inspector and shows debug state beside the unchanged title', async () => {
    const wrapper = mountHeader({ renderMode: 'inline', chat: makeChat(), groups: [] });
    expect(wrapper.find('[data-testid="chat-debug-enabled"]').exists()).toBe(false);
    await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
    expect(wrapper.find('[data-testid="toggle-debug-button"]').attributes('role')).toBe('switch');
    expect(wrapper.find('[data-testid="toggle-debug-button"]').attributes('aria-checked')).toBe('false');
    expect(wrapper.find('[data-testid="debug-toggle-thumb"]').classes()).toContain('translate-x-[3px]');
    await wrapper.find('[data-testid="toggle-debug-button"]').trigger('click');
    expect(wrapper.emitted('toggle-debug')).toEqual([[]]);
    expect(wrapper.emitted('open-chat-inspector')).toBeUndefined();
    expect(wrapper.find('[data-testid="more-actions-button"]').attributes('aria-expanded')).toBe('true');
    await wrapper.setProps({ chat: makeChat({ debugEnabled: true }) });
    expect(wrapper.find('[data-testid="chat-debug-enabled"]').text()).toBe('Debug Mode');
    expect(wrapper.find('[data-testid="chat-header-title"]').text()).toBe('Header Chat');
    expect(wrapper.find('[data-testid="toggle-debug-button"]').attributes('aria-checked')).toBe('true');
    expect(wrapper.find('[data-testid="debug-toggle-thumb"]').classes()).toContain('translate-x-[18px]');
    await wrapper.find('[data-testid="toggle-debug-button"]').trigger('click');
    expect(wrapper.emitted('toggle-debug')).toEqual([[], []]);
    await wrapper.setProps({ chat: makeChat({ debugEnabled: false }) });
    expect(wrapper.find('[data-testid="chat-debug-enabled"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="toggle-debug-button"]').attributes('aria-checked')).toBe('false');
    expect(wrapper.find('[data-testid="debug-toggle-thumb"]').classes()).toContain('translate-x-[3px]');
    expect(wrapper.find('[data-testid="more-actions-button"]').attributes('aria-expanded')).toBe('true');
    expect(wrapper.find('[data-testid="open-chat-inspector-button"]').text()).toBe('Chat Inspector');
    await wrapper.find('[data-testid="open-chat-inspector-button"]').trigger('click');
    expect(wrapper.emitted('open-chat-inspector')).toEqual([[]]);
    expect(wrapper.emitted('toggle-debug')).toHaveLength(2);
    expect(wrapper.find('[data-testid="more-actions-button"]').attributes('aria-expanded')).toBe('false');
  });

  it('renders chat identity badges and emits settings updates', async () => {
    const wrapper = mountHeader({
      renderMode: 'inline',
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
      renderMode: 'inline',
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
      renderMode: 'inline',
      chat: makeChat(),
      groups: [makeGroup(), makeGroup({ id: toChatGroupId({ raw: 'group-2' }), name: 'Archive' })],
    });

    await wrapper.find('[data-testid="move-to-group-button"]').trigger('click');
    const archiveButton = wrapper.findAll('button').find(button => button.text().includes('Archive'));
    if (!archiveButton) {
      throw new Error('Archive group button was not rendered');
    }
    await archiveButton.trigger('click');

    expect(wrapper.emitted('move-to-group')).toEqual([['group-2']]);
  });

  it('emits more menu actions', async () => {
    const wrapper = mountHeader({
      renderMode: 'inline',
      chat: makeChat(),
      groups: [makeGroup()],
    });

    await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
    expect(wrapper.find('[data-testid="print-chat-button"]').exists()).toBe(true);

    await wrapper.find('[data-testid="print-chat-button"]').trigger('click');

    expect(wrapper.emitted('print')).toEqual([[]]);
  });

  it('emits delete-chat and closes the more actions menu', async () => {
    const wrapper = mountHeader({
      renderMode: 'inline',
      chat: makeChat(),
      groups: [makeGroup()],
    });

    await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
    const deleteButton = wrapper.find('[data-testid="delete-chat-button"]');
    expect(deleteButton.exists()).toBe(true);

    await deleteButton.trigger('click');

    expect(wrapper.emitted('delete-chat')).toEqual([[]]);
    expect(wrapper.find('[data-testid="delete-chat-button"]').exists()).toBe(false);
  });

  it('emits open-file-explorer from the more actions menu', async () => {
    const wrapper = mountHeader({
      renderMode: 'inline',
      chat: makeChat(),
      groups: [makeGroup()],
    });

    await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
    await wrapper.find('[data-testid="open-chat-file-explorer-button"]').trigger('click');

    expect(wrapper.emitted('open-file-explorer')).toEqual([[]]);
  });

  it('emits compact-context from the more actions menu', async () => {
    const wrapper = mountHeader({
      renderMode: 'inline',
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
      renderMode: 'inline',
      chat: makeChat(),
      groups: [makeGroup()],
    });

    await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
    expect(wrapper.find('[data-testid="open-chat-wesh-terminal-button"]').exists()).toBe(true);

    await wrapper.find('[data-testid="open-chat-wesh-terminal-button"]').trigger('mouseleave');
    expect(wrapper.find('[data-testid="open-chat-wesh-terminal-button"]').exists()).toBe(true);

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();

    expect(wrapper.find('[data-testid="open-chat-wesh-terminal-button"]').exists()).toBe(false);
  });
});

describe('floating header menus', () => {
  it('keeps the menu mounted through debug switches and state updates until an outside click', async () => {
    const wrapper = mountHeader({ renderMode: 'floating', chat: makeChat(), groups: [] });
    const trigger = wrapper.get('[data-testid="more-actions-button"]');
    await clickElement({ element: trigger.element });
    const panel = getFloatingPanel({ kind: 'more' });

    for (const debugEnabled of [true, false]) {
      const toggle = panel.querySelector('[data-testid="toggle-debug-button"]');
      if (!toggle) {
        throw new Error('Missing debug toggle');
      }
      await clickElement({ element: toggle });
      expect(getFloatingPanel({ kind: 'more' })).toBe(panel);
      await wrapper.setProps({ chat: makeChat({ debugEnabled }) });
      expect(getFloatingPanel({ kind: 'more' })).toBe(panel);
      expect(toggle.getAttribute('aria-checked')).toBe(String(debugEnabled));
      expect(trigger.attributes('aria-expanded')).toBe('true');
    }

    expect(wrapper.emitted('toggle-debug')).toEqual([[], []]);
    await clickElement({ element: document.body });
    expect(document.body.contains(panel)).toBe(false);
    expect(trigger.attributes('aria-expanded')).toBe('false');
  });

  it('teleports above the pane and preserves inside actions and outside dismissal', async () => {
    const wrapper = mountHeader({ renderMode: 'floating', chat: makeChat(), groups: [makeGroup()] });
    const trigger = wrapper.get('[data-testid="more-actions-button"]');
    await clickElement({ element: trigger.element });

    const panel = getFloatingPanel({ kind: 'more' });
    expect(document.body.contains(panel)).toBe(true);
    expect(wrapper.element.contains(panel)).toBe(false);
    expect(panel.style.position).toBe('fixed');
    expect(panel.style.zIndex).toBe('9999');
    expect(trigger.attributes('aria-expanded')).toBe('true');

    await clickElement({ element: panel });
    panel.dispatchEvent(new MouseEvent('mouseleave'));
    expect(document.body.contains(panel)).toBe(true);
    const print = panel.querySelector('[data-testid="print-chat-button"]');
    if (!print) {
      throw new Error('Missing print action');
    }
    await clickElement({ element: print });
    expect(wrapper.emitted('print')).toEqual([[]]);
    expect(document.body.contains(panel)).toBe(false);

    await clickElement({ element: trigger.element });
    await clickElement({ element: document.body });
    expect(document.querySelector('[data-testid="chat-header-more-menu"]')).toBeNull();
    expect(trigger.attributes('aria-expanded')).toBe('false');
  });

  it('switches between menus without leaving both open and toggles the active trigger', async () => {
    const wrapper = mountHeader({ renderMode: 'floating', chat: makeChat(), groups: [makeGroup()] });
    const more = wrapper.get('[data-testid="more-actions-button"]');
    const move = wrapper.get('[data-testid="move-to-group-button"]');
    await clickElement({ element: more.element });
    await clickElement({ element: move.element });
    expect(document.querySelector('[data-testid="chat-header-more-menu"]')).toBeNull();
    expect(document.querySelector('[data-testid="chat-header-move-menu"]')).not.toBeNull();
    await clickElement({ element: more.element });
    expect(document.querySelector('[data-testid="chat-header-move-menu"]')).toBeNull();
    expect(document.querySelector('[data-testid="chat-header-more-menu"]')).not.toBeNull();
    await clickElement({ element: more.element });
    expect(document.querySelector('[data-testid="chat-header-more-menu"]')).toBeNull();
  });

  it('uses viewport-bounded scrolling while retaining the header menu widths', async () => {
    vi.stubGlobal('innerWidth', 800);
    vi.stubGlobal('innerHeight', 360);
    const wrapper = mountHeader({ renderMode: 'floating', chat: makeChat(), groups: [makeGroup()] });
    const more = wrapper.get('[data-testid="more-actions-button"]');
    const move = wrapper.get('[data-testid="move-to-group-button"]');
    vi.spyOn(more.element, 'getBoundingClientRect').mockReturnValue(new DOMRect(700, 20, 32, 32));
    vi.spyOn(move.element, 'getBoundingClientRect').mockReturnValue(new DOMRect(660, 20, 32, 32));
    await nextTick();
    window.dispatchEvent(new Event('resize'));
    await clickElement({ element: more.element });
    const panel = getFloatingPanel({ kind: 'more' });
    expect(panel.style.width).toBe('224px');
    expect(panel.style.top).toBe('56px');
    expect(panel.style.maxHeight).toBe('296px');
    expect(panel.classList.contains('overflow-y-auto')).toBe(true);

    vi.stubGlobal('innerWidth', 220);
    vi.stubGlobal('innerHeight', 140);
    window.dispatchEvent(new Event('resize'));
    await nextTick();
    expect(panel.style.width).toBe('204px');
    expect(panel.style.maxHeight).toBe('76px');

    vi.stubGlobal('innerWidth', 800);
    window.dispatchEvent(new Event('resize'));
    await clickElement({ element: move.element });
    expect(getFloatingPanel({ kind: 'move' }).style.width).toBe('256px');
  });

  it.each(['more', 'move'] as const)('keeps Tab entry and return beside the %s trigger', async kind => {
    const wrapper = mountHeader({ renderMode: 'floating', chat: makeChat(), groups: [makeGroup()] });
    const trigger = wrapper.get(kind === 'more' ? '[data-testid="more-actions-button"]' : '[data-testid="move-to-group-button"]');
    await clickElement({ element: trigger.element });
    const panel = getFloatingPanel({ kind });
    const buttons = panel.querySelectorAll('button');
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (!first || !last) {
      throw new Error('Missing menu tab stops');
    }
    (trigger.element as HTMLButtonElement).focus();
    const enter = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    trigger.element.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(trigger.element);

    last.focus();
    const leave = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    last.dispatchEvent(leave);
    const closedTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    trigger.element.dispatchEvent(closedTab);
    expect(closedTab.defaultPrevented).toBe(false);
    await nextTick();
    expect(leave.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    expect(document.body.contains(panel)).toBe(false);
  });

  it.each(['more', 'move'] as const)('removes the %s menu when the active chat changes or disappears', async kind => {
    const wrapper = mountHeader({ renderMode: 'floating', chat: makeChat(), groups: [makeGroup()] });
    const selector = kind === 'more' ? '[data-testid="more-actions-button"]' : '[data-testid="move-to-group-button"]';
    await clickElement({ element: wrapper.get(selector).element });
    await wrapper.setProps({ chat: makeChat({ id: toChatId({ raw: 'chat-2' }) }) });
    expect(document.querySelector(`[data-testid="chat-header-${kind}-menu"]`)).toBeNull();
    await clickElement({ element: wrapper.get(selector).element });
    await wrapper.setProps({ chat: null });
    expect(document.querySelector(`[data-testid="chat-header-${kind}-menu"]`)).toBeNull();
    await wrapper.setProps({ chat: makeChat() });
    expect(document.querySelector(`[data-testid="chat-header-${kind}-menu"]`)).toBeNull();
  });
});

describe('compact attached-chat header', () => {
  it('keeps a single nonwrapping model label and a named settings control for long Japanese groups', async () => {
    await ensureAllStringsForTest({ locale: 'ja' });
    const group = makeGroup({ name: '画像生成用の非常に長い日本語のチャットグループ名' });
    const wrapper = mountHeader({ renderMode: 'inline', chat: makeChat(), groups: [group] });
    using _cleanupResource = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await wrapper.setProps({ modelLabel: 'チャットグループ: hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M' });
    const trigger = wrapper.get('[data-testid="model-trigger"]');
    expect(trigger.text()).toBe('チャットグループ: hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M');
    expect(trigger.attributes('aria-label')).toBeTruthy();
    expect(wrapper.get('[data-testid="chat-model-name"]').element.parentElement?.classList.contains('whitespace-nowrap')).toBe(true);
    await trigger.trigger('click');
    expect(wrapper.emitted('update:show-chat-settings')).toEqual([[true]]);
  });
});
