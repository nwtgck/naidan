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
      modelLabel: 'gpt-test',
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

function mockHeaderMeasurements({ width: initialWidth }: { width: number }) {
  let width = initialWidth;
  let readMoreBounds: (() => DOMRect) | undefined;
  const originalBounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'chat-pane-header') {
      return new DOMRect(0, 0, width, 56);
    }
    return this.dataset.testid === 'more-actions-button' && readMoreBounds ? readMoreBounds() : originalBounds.call(this);
  });
  const observers: { notify: ResizeObserverCallback, observer: ResizeObserver, observe: ReturnType<typeof vi.fn<ResizeObserver['observe']>> }[] = [];
  vi.stubGlobal('ResizeObserver', vi.fn(function (notify: ResizeObserverCallback) {
    const observe = vi.fn<ResizeObserver['observe']>();
    const observer: ResizeObserver = { observe, unobserve: vi.fn(), disconnect: vi.fn() };
    observers.push({ notify, observer, observe });
    return observer;
  }));
  return {
    setMoreBounds({ read }: { read: () => DOMRect }) {
      readMoreBounds = read;
    },
    async resize({ width: nextWidth }: { width: number }) {
      width = nextWidth;
      for (const { notify, observer, observe } of observers) {
        if (observe.mock.calls.some(([target]) => target instanceof HTMLElement && target.dataset.testid === 'chat-pane-header')) {
          notify([], observer);
        }
      }
      await nextTick();
      await nextTick();
    },
  };
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
    expect(wrapper.find('[data-testid="model-trigger"]').text()).toContain('gpt-test');

    await wrapper.find('[data-testid="model-trigger"]').trigger('click');

    expect(wrapper.emitted('update:show-chat-settings')).toEqual([[true]]);
  });

  it.each([
    ['plain-model', 'plain-model'],
    ['provider/model:variant', 'model:variant'],
    ['provider/', 'provider/'],
  ])('keeps the full %s model available while displaying its name', async (modelLabel, visibleName) => {
    const wrapper = mountHeader({ renderMode: 'inline', chat: makeChat(), groups: [] });
    await wrapper.setProps({ modelLabel });
    expect(wrapper.get('[data-testid="chat-model-name"]').text()).toBe(visibleName);
    expect(wrapper.get('[data-testid="chat-model-name"]').attributes('title')).toBe(modelLabel);
    expect(wrapper.get('[data-testid="model-trigger"]').attributes('aria-description')).toBe(modelLabel);
    expect(wrapper.find('[data-testid="chat-model-source"]').exists()).toBe(false);
  });

  it('keeps the original actions and active states in the grouped menu', async () => {
    const wrapper = mountHeader({ renderMode: 'inline', chat: makeChat(), groups: [] });
    await wrapper.get('[data-testid="more-actions-button"]').trigger('click');
    const menu = wrapper.get('[data-testid="chat-header-more-menu"]');
    expect(menu.findAll('button').map(button => button.attributes('data-testid'))).toEqual([
      'open-chat-settings-button',
      'search-in-chat-button', 'toggle-media-gallery-button',
      'super-edit-button', 'compact-context-button',
      'print-chat-button', 'export-markdown-button', 'export-url-button',
      'open-chat-file-explorer-button', 'open-chat-wesh-terminal-button',
      'toggle-debug-button', 'open-chat-inspector-button', 'delete-chat-button',
    ]);
    expect(menu.get('[data-testid="toggle-media-gallery-button"]').attributes('aria-pressed')).toBe('false');
    expect(menu.get('[data-testid="open-chat-wesh-terminal-button"]').attributes('aria-pressed')).toBe('false');
    await wrapper.setProps({ mediaShelfVisibility: 'visible', isChatWeshTerminalOpen: true });
    expect(menu.get('[data-testid="toggle-media-gallery-button"]').attributes('aria-pressed')).toBe('true');
    expect(menu.get('[data-testid="open-chat-wesh-terminal-button"]').attributes('aria-pressed')).toBe('true');
  });

  it.each([
    ['search-in-chat-button', 'search-chat'],
    ['toggle-media-gallery-button', 'toggle-media-shelf'],
    ['super-edit-button', 'open-history'],
    ['export-markdown-button', 'export-chat'],
    ['export-url-button', 'share-url'],
    ['open-chat-wesh-terminal-button', 'toggle-wesh-terminal'],
  ] as const)('retains the %s action and closes its menu', async (testId, eventName) => {
    const wrapper = mountHeader({ renderMode: 'inline', chat: makeChat(), groups: [] });
    await wrapper.get('[data-testid="more-actions-button"]').trigger('click');
    await wrapper.get(`[data-testid="${testId}"]`).trigger('click');
    expect(wrapper.emitted(eventName)).toEqual([[]]);
    expect(wrapper.get('[data-testid="more-actions-button"]').attributes('aria-expanded')).toBe('false');
  });

  it('keeps identity controls out of the unselected header', () => {
    const wrapper = mountHeader({ renderMode: 'inline', chat: null, groups: [] });
    expect(wrapper.find('[data-testid="chat-header-title"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-trigger"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="more-actions-button"]').exists()).toBe(false);
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
        modelLabel: 'gpt-test',
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
    expect(panel.style.width).toBe('272px');
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
    const group = makeGroup({ name: '画像生成用の非常に長い日本語のチャットグループ名' });
    const wrapper = mountHeader({ renderMode: 'inline', chat: makeChat(), groups: [group] });
    using _cleanupResource = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await wrapper.setProps({ modelLabel: 'hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M', modelSource: { label: 'Chat group', description: 'Follows changes to Chat group' } });
    const trigger = wrapper.get('[data-testid="model-trigger"]');
    expect(trigger.get('[data-testid="chat-model-name"]').text()).toBe('LFM2.5-2.6B-GGUF:Q4_K_M');
    expect(trigger.get('[data-testid="chat-model-source"]').text()).toBe('Chat group');
    expect(trigger.attributes('aria-description')).toBe('Chat group, hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M');
    expect(wrapper.get('[data-testid="chat-group-badge"]').text()).toBe(group.name);
    expect(trigger.attributes('aria-label')).toBeTruthy();
    expect(wrapper.get('[data-testid="chat-model-name"]').classes()).toContain('whitespace-nowrap');
    await trigger.trigger('click');
    expect(wrapper.emitted('update:show-chat-settings')).toEqual([[true]]);
  });
});

describe('container-sized header actions', () => {
  it('moves actions into More in priority order and restores them when the pane widens', async () => {
    vi.stubGlobal('innerWidth', 1400);
    const measurements = mockHeaderMeasurements({ width: 700 });
    const wrapper = mountHeader({ renderMode: 'inline', chat: makeChat(), groups: [makeGroup()] });
    await nextTick();
    for (const { width, rename, fork, move, outline, model } of [
      { width: 640, rename: true, fork: true, move: true, outline: true, model: true },
      { width: 639, rename: false, fork: false, move: true, outline: true, model: true },
      { width: 480, rename: false, fork: false, move: true, outline: true, model: true },
      { width: 479, rename: false, fork: false, move: false, outline: true, model: false },
      { width: 360, rename: false, fork: false, move: false, outline: true, model: false },
      { width: 359, rename: false, fork: false, move: false, outline: false, model: false },
      { width: 700, rename: true, fork: true, move: true, outline: true, model: true },
    ]) {
      await measurements.resize({ width });
      expect(wrapper.find('[data-testid="edit-title-button"]').exists()).toBe(rename);
      expect(wrapper.find('[data-testid="fork-chat-button"]').exists()).toBe(fork);
      expect(wrapper.find('[data-testid="move-to-group-button"]').exists()).toBe(move);
      expect(wrapper.find('[data-testid="conversation-outline-button"]').exists()).toBe(outline);
      expect(wrapper.find('[data-testid="chat-header-model-row"]').exists()).toBe(model);
      expect(wrapper.find('[data-testid="model-trigger"]').exists()).toBe(model);
      await wrapper.get('[data-testid="more-actions-button"]').trigger('click');
      const menu = wrapper.get('[data-testid="chat-header-more-menu"]');
      expect(menu.findAll('button')[0]?.attributes('data-testid')).toBe('open-chat-settings-button');
      expect(menu.find('[data-testid="overflow-edit-title-button"]').exists()).toBe(!rename);
      expect(menu.find('[data-testid="overflow-fork-chat-button"]').exists()).toBe(!fork);
      expect(menu.find('[data-testid="overflow-move-to-group-button"]').exists()).toBe(!move);
      expect(menu.find('[data-testid="overflow-conversation-outline-button"]').exists()).toBe(!outline);
      await wrapper.get('[data-testid="more-actions-button"]').trigger('click');
    }
  });

  it.each([320, 380, 700])('keeps chat settings available at width %s without messages and always opens the panel', async width => {
    mockHeaderMeasurements({ width });
    const wrapper = mountHeader({ renderMode: 'inline', chat: makeChat(), groups: [], activeMessageCount: 0 });
    await nextTick();
    await wrapper.setProps({ showChatSettings: true });
    expect(wrapper.find('[data-testid="fork-chat-button"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="conversation-outline-button"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="move-to-group-button"]').exists()).toBe(width >= 360);
    await wrapper.get('[data-testid="more-actions-button"]').trigger('click');
    expect(wrapper.find('[data-testid="overflow-fork-chat-button"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="overflow-conversation-outline-button"]').exists()).toBe(false);
    await wrapper.get('[data-testid="open-chat-settings-button"]').trigger('click');
    expect(wrapper.emitted('update:show-chat-settings')).toEqual([[true]]);
    expect(wrapper.get('[data-testid="more-actions-button"]').attributes('aria-expanded')).toBe('false');
  });

  it.each([
    ['overflow-edit-title-button', 'edit-title'],
    ['overflow-fork-chat-button', 'fork-last-message'],
    ['overflow-conversation-outline-button', 'toggle-outline'],
  ] as const)('keeps %s connected to the original action', async (testId, eventName) => {
    mockHeaderMeasurements({ width: 320 });
    const wrapper = mountHeader({ renderMode: 'inline', chat: makeChat(), groups: [] });
    await nextTick();
    await wrapper.setProps({ outlineVisibility: 'visible' });
    await wrapper.get('[data-testid="more-actions-button"]').trigger('click');
    expect(wrapper.get('[data-testid="overflow-conversation-outline-button"]').attributes('aria-pressed')).toBe('true');
    await wrapper.get(`[data-testid="${testId}"]`).trigger('click');
    expect(wrapper.emitted(eventName)).toEqual([[]]);
    expect(wrapper.get('[data-testid="more-actions-button"]').attributes('aria-expanded')).toBe('false');
  });

  it('opens group choices from More with a visible anchor and connected keyboard focus', async () => {
    const measurements = mockHeaderMeasurements({ width: 320 });
    const wrapper = mountHeader({ renderMode: 'floating', chat: makeChat(), groups: [makeGroup()] });
    await nextTick();
    const more = wrapper.get('[data-testid="more-actions-button"]');
    measurements.setMoreBounds({ read: () => new DOMRect(260, 20, 40, 40) });
    window.dispatchEvent(new Event('resize'));
    await clickElement({ element: more.element });
    const overflowMove = document.querySelector<HTMLElement>('[data-testid="overflow-move-to-group-button"]');
    if (!overflowMove) {
      throw new Error('Missing overflow move action');
    }
    overflowMove.focus();
    await clickElement({ element: overflowMove });
    const panel = getFloatingPanel({ kind: 'move' });
    expect(wrapper.element.contains(panel)).toBe(false);
    expect(panel.style.position).toBe('fixed');
    expect(panel.style.top).toBe('64px');
    expect(document.querySelector('[data-testid="chat-header-more-menu"]')).toBeNull();
    expect(more.attributes('aria-expanded')).toBe('true');
    const first = panel.querySelector<HTMLButtonElement>('button');
    expect(document.activeElement).toBe(first);
    first?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(more.element);
    const enter = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    more.element.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    const destination = panel.querySelector<HTMLElement>('[data-testid="move-to-group-option"]');
    if (!destination) {
      throw new Error('Missing group choice');
    }
    await clickElement({ element: destination });
    expect(wrapper.emitted('move-to-group')).toEqual([['group-1']]);
    expect(document.activeElement).toBe(more.element);
    expect(more.attributes('aria-expanded')).toBe('false');
  });

  it.each(['outside', 'owner', 'trigger'] as const)('dismisses overflow group choices on %s changes', async dismissal => {
    mockHeaderMeasurements({ width: 320 });
    const wrapper = mountHeader({ renderMode: 'floating', chat: makeChat(), groups: [makeGroup()] });
    await nextTick();
    await clickElement({ element: wrapper.get('[data-testid="more-actions-button"]').element });
    const action = document.querySelector('[data-testid="overflow-move-to-group-button"]');
    if (!action) {
      throw new Error('Missing overflow move action');
    }
    await clickElement({ element: action });
    expect(document.querySelector('[data-testid="chat-header-move-menu"]')).not.toBeNull();
    if (dismissal === 'outside') {
      await clickElement({ element: document.body });
    } else if (dismissal === 'owner') {
      await wrapper.setProps({ chat: makeChat({ id: toChatId({ raw: 'chat-2' }) }) });
    } else {
      await clickElement({ element: wrapper.get('[data-testid="more-actions-button"]').element });
    }
    expect(document.querySelector('[data-testid="chat-header-move-menu"]')).toBeNull();
    expect(wrapper.get('[data-testid="more-actions-button"]').attributes('aria-expanded')).toBe('false');
  });

  it.each([
    ['edit-title-button', 700, 600],
    ['fork-chat-button', 700, 600],
    ['move-to-group-button', 600, 440],
    ['conversation-outline-button', 440, 320],
    ['model-trigger', 520, 440],
  ] as const)('returns focus from a disappearing %s to More', async (testId, startWidth, endWidth) => {
    const measurements = mockHeaderMeasurements({ width: startWidth });
    const wrapper = mountHeader({ renderMode: 'floating', chat: makeChat(), groups: [makeGroup()] });
    await nextTick();
    const control = wrapper.get(`[data-testid="${testId}"]`).element as HTMLButtonElement;
    control.focus();
    expect(document.activeElement).toBe(control);
    await measurements.resize({ width: endWidth });
    expect(document.activeElement).toBe(wrapper.get('[data-testid="more-actions-button"]').element);
    expect(wrapper.find(`[data-testid="${testId}"]`).exists()).toBe(false);
  });

  it.each(['fork-chat-button', 'conversation-outline-button'])('returns focus when %s becomes unavailable without moving outside focus', async testId => {
    mockHeaderMeasurements({ width: 700 });
    const wrapper = mountHeader({ renderMode: 'floating', chat: makeChat(), groups: [] });
    await nextTick();
    const control = wrapper.get(`[data-testid="${testId}"]`).element as HTMLButtonElement;
    control.focus();
    await wrapper.setProps({ activeMessageCount: 0 });
    await nextTick();
    expect(document.activeElement).toBe(wrapper.get('[data-testid="more-actions-button"]').element);
  });

  it.each(['overflow-fork-chat-button', 'overflow-conversation-outline-button'])('returns focus when the narrow %s disappears with the last message', async testId => {
    mockHeaderMeasurements({ width: 320 });
    const wrapper = mountHeader({ renderMode: 'floating', chat: makeChat(), groups: [] });
    await nextTick();
    await clickElement({ element: wrapper.get('[data-testid="more-actions-button"]').element });
    const action = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (!action) {
      throw new Error('Missing focused overflow action');
    }
    action.focus();
    await wrapper.setProps({ activeMessageCount: 0 });
    await nextTick();
    expect(document.querySelector('[data-testid="chat-header-more-menu"]')).toBeNull();
    expect(document.activeElement).toBe(wrapper.get('[data-testid="more-actions-button"]').element);
  });

  it('leaves outside focus alone when the pane shrinks', async () => {
    const measurements = mockHeaderMeasurements({ width: 700 });
    const wrapper = mountHeader({ renderMode: 'floating', chat: makeChat(), groups: [] });
    await nextTick();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    await measurements.resize({ width: 320 });
    expect(document.activeElement).toBe(input);
    expect(wrapper.find('[data-testid="model-trigger"]').exists()).toBe(false);
  });

  it.each([
    { startWidth: 320, endWidth: 700, destination: 'move-to-group-button' },
    { startWidth: 700, endWidth: 320, destination: 'more-actions-button' },
  ])('closes group choices and restores the visible anchor from $startWidth to $endWidth', async ({ startWidth, endWidth, destination }) => {
    const measurements = mockHeaderMeasurements({ width: startWidth });
    const wrapper = mountHeader({ renderMode: 'floating', chat: makeChat(), groups: [makeGroup()] });
    await nextTick();
    if (startWidth < 480) {
      await clickElement({ element: wrapper.get('[data-testid="more-actions-button"]').element });
      const overflowMove = document.querySelector('[data-testid="overflow-move-to-group-button"]');
      if (!overflowMove) {
        throw new Error('Missing overflow move action');
      }
      await clickElement({ element: overflowMove });
    } else {
      await clickElement({ element: wrapper.get('[data-testid="move-to-group-button"]').element });
    }
    const first = getFloatingPanel({ kind: 'move' }).querySelector<HTMLButtonElement>('button');
    first?.focus();
    await measurements.resize({ width: endWidth });
    expect(document.querySelector('[data-testid="chat-header-move-menu"]')).toBeNull();
    expect(document.querySelector('[data-testid="chat-header-more-menu"]')).toBeNull();
    expect(document.activeElement).toBe(wrapper.get(`[data-testid="${destination}"]`).element);
    expect(wrapper.get('[data-testid="more-actions-button"]').attributes('aria-expanded')).toBe('false');
  });

  it('closes a resized menu and uses fresh anchor bounds when reopened in the same width category', async () => {
    vi.stubGlobal('innerWidth', 1000);
    const measurements = mockHeaderMeasurements({ width: 780 });
    const wrapper = mountHeader({ renderMode: 'floating', chat: makeChat(), groups: [] });
    await nextTick();
    const more = wrapper.get('[data-testid="more-actions-button"]');
    let left = 700;
    measurements.setMoreBounds({ read: () => new DOMRect(left, 20, 40, 40) });
    window.dispatchEvent(new Event('resize'));
    await clickElement({ element: more.element });
    expect(getFloatingPanel({ kind: 'more' }).style.left).toBe('468px');
    const action = document.querySelector<HTMLElement>('[data-testid="search-in-chat-button"]');
    action?.focus();
    left = 660;
    await measurements.resize({ width: 740 });
    expect(document.querySelector('[data-testid="chat-header-more-menu"]')).toBeNull();
    expect(document.activeElement).toBe(more.element);
    await clickElement({ element: more.element });
    expect(getFloatingPanel({ kind: 'more' }).style.left).toBe('428px');
  });
});
