import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { toChatGroupId, toChatId, idToRaw, type ChatId, type ChatGroupId } from '@/01-models/ids';
import type { SidebarItem } from '@/01-models/types';
import type { FocusArea } from './useLayout';
import { useSidebarItemReveal, type SidebarRevealTarget } from './useSidebarItemReveal';

const chatId = toChatId({ raw: 'chat-a' });
const otherChatId = toChatId({ raw: 'chat-b' });
const chatGroupId = toChatGroupId({ raw: 'chat-group-a' });
const selectedChat: SidebarRevealTarget = { type: 'chat', id: chatId };
const selectedChatGroup: SidebarRevealTarget = { type: 'chat_group', id: chatGroupId };

function chatItems(): SidebarItem[] {
  return [chatId, otherChatId].map(id => ({ id: idToRaw({ id }), type: 'chat', chat: { id, title: idToRaw({ id }), updatedAt: 0 } }));
}

function createHarness({ selection, open, metadata }: { selection: SidebarRevealTarget | undefined, open: boolean, metadata: SidebarItem[] }) {
  const target = ref(selection);
  const isOpen = ref(open);
  const isDragging = ref(false);
  const items = ref(metadata);
  const expandedChatGroupIds = ref(new Set<ChatGroupId>());
  const focusArea = ref<FocusArea>('chat');
  const focusVersion = ref(0);
  const container = ref<HTMLElement | null>(null);
  const rows = new Map<ChatId | ChatGroupId, { top: number, height: number }>([
    [chatId, { top: 1000, height: 40 }],
    [otherChatId, { top: 1800, height: 40 }],
    [chatGroupId, { top: 600, height: 40 }],
  ]);
  let viewportHeight = 480;
  let contentHeight = 4000;
  let clipBottom = 4000;
  let reducedMotion = false;
  let resized = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) {
      resized = callback;
    }

    observe() {}

    unobserve() {}

    disconnect = disconnect;
  });
  vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }));
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(function (this: HTMLElement, options: ScrollToOptions | number) {
    if (typeof options !== 'number' && options.top !== undefined) {
      this.scrollTop = options.top;
    }
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'sidebar-nav' ? viewportHeight : 40;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const navTop = 80;
    if (this.dataset.testid === 'sidebar-nav') {
      return new DOMRect(0, navTop, 250, viewportHeight);
    }
    if (this.hasAttribute('data-sidebar-chat-list') || this.hasAttribute('data-sidebar-chat-group-content')) {
      return new DOMRect(0, navTop - (container.value?.scrollTop ?? 0), 250, clipBottom);
    }
    const id = this.dataset.sidebarChatId ?? this.dataset.sidebarGroupId;
    const row = id === undefined ? undefined : Array.from(rows).find(([rowId]) => idToRaw({ id: rowId }) === id)?.[1];
    return new DOMRect(0, navTop + (row?.top ?? 0) - (container.value?.scrollTop ?? 0), 250, row?.height ?? 40);
  });
  const wrapper = mount(defineComponent({
    setup() {
      const reveal = useSidebarItemReveal({ container, items, target, expandedChatGroupIds, compactThreshold: 5, isOpen, isDragging, focusArea, focusVersion });
      function renderItems({ list }: { list: SidebarItem[] }): ReturnType<typeof h>[] {
        return list.map(item => {
          switch (item.type) {
          case 'chat': return h('div', { 'data-sidebar-chat-id': item.chat.id }, item.chat.title ?? '');
          case 'chat_group': return h('section', [
            h('div', { 'data-sidebar-group-id': item.chatGroup.id }, item.chatGroup.name),
            h('div', { 'data-sidebar-chat-group-content': '' }, [
              h('div', { 'data-sidebar-chat-list': '' }, renderItems({ list: expandedChatGroupIds.value.has(item.chatGroup.id) ? item.chatGroup.items : item.chatGroup.items.slice(0, 5) })),
            ]),
          ]);
          default: {
            const exhaustive: never = item;
            return exhaustive;
          }
          }
        });
      }
      return () => h('nav', { ref: container, 'data-testid': 'sidebar-nav', onTransitionend: reveal.retry, onScroll: reveal.releaseCompletedScroll, onWheel: reveal.interruptReveal, onTouchstart: reveal.interruptReveal, onPointerdown: reveal.interruptReveal, onKeydown: reveal.interruptReveal }, isOpen.value ? renderItems({ list: items.value }) : []);
    },
  }));
  return {
    target,
    isOpen,
    isDragging,
    items,
    focusArea,
    focusVersion,
    expandedChatGroupIds,
    container,
    rows,
    scroll,
    disconnect,
    resize({ height }: { height: number }) {
      viewportHeight = height;
      resized();
    },
    clip({ bottom }: { bottom: number }) {
      clipBottom = bottom;
    },
    setContentHeight({ height }: { height: number }) {
      contentHeight = height;
    },
    reduceMotion() {
      reducedMotion = true;
    },
    focus({ area }: { area: FocusArea }) {
      focusArea.value = area;
      focusVersion.value++;
    },
    endTransition() {
      return wrapper.trigger('transitionend');
    },
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

async function settle() {
  await nextTick();
  await nextTick();
}

beforeEach(() => {
  // jsdom does not implement element scrolling.
  if (HTMLElement.prototype.scrollTo === undefined) {
    HTMLElement.prototype.scrollTo = () => {};
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('sidebar item reveal', () => {
  it.each([selectedChat, selectedChatGroup])('positions the initial $type at one third without a timer or smooth motion', async selection => {
    const metadata = selection.type === 'chat' ? chatItems() : [{ id: idToRaw({ id: chatGroupId }), type: 'chat_group' as const, chatGroup: { id: chatGroupId, name: 'Chat group', updatedAt: 0, isCollapsed: false, items: [] } }];
    using test = createHarness({ selection, open: true, metadata });
    test.focus({ area: 'chat' });
    await settle();
    const row = test.rows.get(selection.id)!;
    expect(test.scroll).toHaveBeenCalledExactlyOnceWith({ top: row.top - (480 - 40) / 3, behavior: 'auto' });
  });

  it.each([
    { rowTop: 0, height: 4000, expected: 0 },
    { rowTop: 3900, height: 4000, expected: 3520 },
  ])('clamps initial positioning to the available scroll range ($rowTop)', async ({ rowTop, height, expected }) => {
    using test = createHarness({ selection: selectedChat, open: true, metadata: chatItems() });
    test.rows.set(chatId, { top: rowTop, height: 40 });
    test.setContentHeight({ height });
    await settle();
    if (expected === 0) {
      expect(test.scroll).not.toHaveBeenCalled();
    } else {
      expect(test.scroll).toHaveBeenCalledExactlyOnceWith({ top: expected, behavior: 'auto' });
    }
  });

  it('keeps focus and does not move an already comfortable row', async () => {
    using test = createHarness({ selection: selectedChat, open: true, metadata: chatItems() });
    await settle();
    test.scroll.mockClear();
    using input = {
      element: document.createElement('textarea'),
      [Symbol.dispose]() {
        this.element.remove();
      },
    };
    document.body.append(input.element);
    input.element.focus();
    test.focus({ area: 'chat' });
    await settle();
    expect(test.scroll).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input.element);
  });

  it.each([
    { scrollTop: 980, expected: 952 },
    { scrollTop: 500, expected: 608 },
  ])('uses the shortest smooth movement with 48px of breathing room from $scrollTop', async ({ scrollTop, expected }) => {
    using test = createHarness({ selection: selectedChat, open: true, metadata: chatItems() });
    await settle();
    test.scroll.mockClear();
    test.container.value!.scrollTop = scrollTop;
    test.focus({ area: 'chat-settings' });
    await settle();
    expect(test.scroll).toHaveBeenCalledExactlyOnceWith({ top: expected, behavior: 'smooth' });
  });

  it('reduces the margin for a short viewport and respects reduced motion', async () => {
    using test = createHarness({ selection: selectedChat, open: true, metadata: chatItems() });
    await settle();
    test.resize({ height: 160 });
    test.container.value!.scrollTop = 1000;
    test.scroll.mockClear();
    test.reduceMotion();
    test.focus({ area: 'chat' });
    await settle();
    expect(test.scroll).toHaveBeenCalledExactlyOnceWith({ top: 980, behavior: 'auto' });
  });

  it('positions late metadata once and does not pull back manual scrolling on a title update', async () => {
    using test = createHarness({ selection: selectedChat, open: true, metadata: [] });
    await settle();
    expect(test.scroll).not.toHaveBeenCalled();
    test.items.value = chatItems();
    await settle();
    expect(test.scroll).toHaveBeenCalledTimes(1);
    test.scroll.mockClear();
    test.container.value!.scrollTop = 0;
    test.items.value = chatItems().map(item => item.type === 'chat' ? { ...item, chat: { ...item.chat, title: 'Updated' } } : item);
    await settle();
    expect(test.scroll).not.toHaveBeenCalled();
  });

  it('retains pending work while the viewport has no height', async () => {
    using test = createHarness({ selection: selectedChat, open: true, metadata: chatItems() });
    test.resize({ height: 0 });
    await settle();
    expect(test.scroll).not.toHaveBeenCalled();
    test.resize({ height: 480 });
    await settle();
    expect(test.scroll).toHaveBeenCalledTimes(1);
  });

  it('reveals the latest target immediately on reopening without opening the sidebar itself', async () => {
    using test = createHarness({ selection: selectedChat, open: false, metadata: chatItems() });
    await settle();
    test.target.value = { type: 'chat', id: otherChatId };
    await settle();
    expect(test.isOpen.value).toBe(false);
    expect(test.scroll).not.toHaveBeenCalled();
    test.isOpen.value = true;
    await settle();
    expect(test.scroll).toHaveBeenCalledExactlyOnceWith({ top: 1800 - 440 / 3, behavior: 'auto' });
  });

  it('discards stale DOM work when the selected route changes or is cleared', async () => {
    using test = createHarness({ selection: selectedChat, open: true, metadata: chatItems() });
    test.target.value = { type: 'chat', id: otherChatId };
    await settle();
    expect(test.scroll).toHaveBeenCalledExactlyOnceWith({ top: 1800 - 440 / 3, behavior: 'auto' });
    test.scroll.mockClear();
    test.focus({ area: 'chat' });
    test.target.value = undefined;
    await settle();
    expect(test.scroll).not.toHaveBeenCalled();
  });

  it('suppresses pending work during dragging and reveals only the latest target afterward', async () => {
    using test = createHarness({ selection: selectedChat, open: true, metadata: chatItems() });
    test.isDragging.value = true;
    test.target.value = { type: 'chat', id: otherChatId };
    await settle();
    expect(test.scroll).not.toHaveBeenCalled();
    test.isDragging.value = false;
    await settle();
    expect(test.scroll).toHaveBeenCalledExactlyOnceWith({ top: 1800 - 440 / 3, behavior: 'auto' });
  });

  it('expands compact metadata before the first render, including chats beyond 2000px', async () => {
    const children = Array.from({ length: 100 }, (_, i) => ({ id: `row-${i}`, type: 'chat' as const, chat: { id: i === 99 ? chatId : toChatId({ raw: `child-${i}` }), title: 'Child', updatedAt: 0 } }));
    using test = createHarness({ selection: selectedChat, open: true, metadata: [{ id: idToRaw({ id: chatGroupId }), type: 'chat_group', chatGroup: { id: chatGroupId, name: 'Chat group', updatedAt: 0, isCollapsed: false, items: children } }] });
    test.rows.set(chatId, { top: 3500, height: 40 });
    await settle();
    expect(test.expandedChatGroupIds.value.has(chatGroupId)).toBe(true);
    expect(test.scroll).toHaveBeenCalledExactlyOnceWith({ top: 3500 - 440 / 3, behavior: 'auto' });
  });

  it('uses the heading of a collapsed chat group without mutating its saved state', async () => {
    const metadata: SidebarItem[] = [{ id: idToRaw({ id: chatGroupId }), type: 'chat_group', chatGroup: { id: chatGroupId, name: 'Chat group', updatedAt: 0, isCollapsed: true, items: [chatItems()[0] as Extract<SidebarItem, { type: 'chat' }>] } }];
    using test = createHarness({ selection: selectedChat, open: true, metadata });
    await settle();
    expect(test.scroll).toHaveBeenCalledExactlyOnceWith({ top: 600 - 440 / 3, behavior: 'auto' });
    expect((test.items.value[0] as Extract<SidebarItem, { type: 'chat_group' }>).chatGroup.isCollapsed).toBe(true);
    expect(test.expandedChatGroupIds.value.size).toBe(0);
  });

  it('waits for clipping to end instead of consuming a request during expansion', async () => {
    const metadata: SidebarItem[] = [{ id: idToRaw({ id: chatGroupId }), type: 'chat_group', chatGroup: { id: chatGroupId, name: 'Chat group', updatedAt: 0, isCollapsed: false, items: [chatItems()[0] as Extract<SidebarItem, { type: 'chat' }>] } }];
    using test = createHarness({ selection: selectedChat, open: true, metadata });
    test.clip({ bottom: 250 });
    await settle();
    expect(test.scroll).not.toHaveBeenCalled();
    test.clip({ bottom: 4000 });
    await test.endTransition();
    await settle();
    expect(test.scroll).toHaveBeenCalledTimes(1);
  });

  it('supports chat group settings focus and ignores unrelated focus areas', async () => {
    using test = createHarness({ selection: selectedChatGroup, open: true, metadata: [{ id: idToRaw({ id: chatGroupId }), type: 'chat_group', chatGroup: { id: chatGroupId, name: 'Chat group', updatedAt: 0, isCollapsed: false, items: [] } }] });
    await settle();
    test.scroll.mockClear();
    test.container.value!.scrollTop = 0;
    test.focus({ area: 'settings' });
    await settle();
    expect(test.scroll).not.toHaveBeenCalled();
    test.focus({ area: 'chat-group-settings' });
    await settle();
    expect(test.scroll).toHaveBeenCalledExactlyOnceWith({ top: 208, behavior: 'smooth' });
  });

  it('disconnects observers and ignores queued work after unmount', async () => {
    const test = createHarness({ selection: selectedChat, open: true, metadata: chatItems() });
    test[Symbol.dispose]();
    test.resize({ height: 480 });
    await settle();
    expect(test.disconnect).toHaveBeenCalledTimes(1);
    expect(test.scroll).not.toHaveBeenCalled();
  });

  it.each(['visible-target', 'no-target', 'drag', 'close', 'focus'] as const)('cancels a running native smooth scroll on %s', async action => {
    using test = createHarness({ selection: selectedChat, open: true, metadata: chatItems() });
    await settle();
    const nav = test.container.value!;
    nav.scrollTop = 0;
    let smoothDestination: number | undefined;
    // Native smooth scrolling changes the position over time, unlike an instant
    // mock. Keep its destination pending until explicitly replaced or aborted.
    test.scroll.mockImplementation(function (this: HTMLElement, options: ScrollToOptions | number) {
      if (typeof options === 'number') {
        return;
      }
      if (options.behavior === 'smooth') {
        smoothDestination = options.top;
      } else {
        smoothDestination = undefined;
        this.scrollTop = options.top ?? this.scrollTop;
      }
    });
    test.focus({ area: 'chat' });
    await settle();
    expect(smoothDestination).toBe(608);
    test.scroll.mockClear();
    switch (action) {
    case 'visible-target':
      test.rows.set(otherChatId, { top: 150, height: 40 });
      test.target.value = { type: 'chat', id: otherChatId };
      break;
    case 'no-target': test.target.value = undefined;
      break;
    case 'drag': test.isDragging.value = true;
      break;
    case 'close': test.isOpen.value = false;
      break;
    case 'focus':
      test.rows.set(chatId, { top: 150, height: 40 });
      test.focus({ area: 'chat' });
      break;
    default: {
      const exhaustive: never = action;
      throw new Error(String(exhaustive));
    }
    }
    await settle();
    expect(smoothDestination).toBeUndefined();
    expect(test.scroll).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: 'auto' });
  });

  it.each(['wheel', 'touchstart', 'pointerdown', 'keydown'])('hands an unfinished smooth scroll over to manual %s input', async eventType => {
    using test = createHarness({ selection: selectedChat, open: true, metadata: chatItems() });
    await settle();
    const nav = test.container.value!;
    nav.scrollTop = 0;
    test.scroll.mockImplementation(() => {});
    test.focus({ area: 'chat' });
    await settle();
    test.scroll.mockClear();
    nav.dispatchEvent(new Event(eventType));
    expect(test.scroll).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: 'auto' });
    test.scroll.mockClear();
    nav.dispatchEvent(new Event(eventType));
    expect(test.scroll).not.toHaveBeenCalled();
  });

  it('releases completed scrolling without interrupting a later manual scroll', async () => {
    using test = createHarness({ selection: selectedChat, open: true, metadata: chatItems() });
    await settle();
    const nav = test.container.value!;
    nav.scrollTop = 0;
    test.focus({ area: 'chat' });
    await settle();
    nav.dispatchEvent(new Event('scroll'));
    nav.scrollTop = 0;
    test.scroll.mockClear();
    test.rows.set(otherChatId, { top: 150, height: 40 });
    test.target.value = { type: 'chat', id: otherChatId };
    await settle();
    expect(test.scroll).not.toHaveBeenCalled();
  });

  it.each(['wheel', 'touchstart', 'pointerdown', 'keydown'])('discards pending layout work when the user starts %s input', async eventType => {
    const metadata: SidebarItem[] = [{ id: idToRaw({ id: chatGroupId }), type: 'chat_group', chatGroup: { id: chatGroupId, name: 'Chat group', updatedAt: 0, isCollapsed: false, items: [chatItems()[0] as Extract<SidebarItem, { type: 'chat' }>] } }];
    using test = createHarness({ selection: selectedChat, open: true, metadata });
    test.clip({ bottom: 250 });
    await settle();
    test.container.value!.dispatchEvent(new Event(eventType));
    test.container.value!.scrollTop = 50;
    test.clip({ bottom: 4000 });
    await test.endTransition();
    await settle();
    expect(test.scroll).not.toHaveBeenCalled();
    // A new explicit focus can request reveal again after the manual takeover.
    test.focus({ area: 'chat' });
    await settle();
    expect(test.scroll).toHaveBeenCalledExactlyOnceWith({ top: 608, behavior: 'smooth' });
  });
});
