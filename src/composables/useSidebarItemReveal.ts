import { nextTick, onBeforeUnmount, onMounted, watch, type Ref } from 'vue';
import type { ChatGroupId, ChatId } from '@/01-models/ids';
import { idToRaw } from '@/01-models/ids';
import type { SidebarItem } from '@/01-models/types';
import type { FocusArea } from './useLayout';

export type SidebarRevealTarget = { type: 'chat', id: ChatId } | { type: 'chat_group', id: ChatGroupId };
type Placement = 'initial' | 'nearest';

function sameTarget({ left, right }: { left: SidebarRevealTarget | undefined, right: SidebarRevealTarget | undefined }): boolean {
  return left?.type === right?.type && left?.id === right?.id;
}

function scrollPosition({ rowTop, rowHeight, viewportHeight, scrollTop, scrollHeight, placement }: {
  rowTop: number,
  rowHeight: number,
  viewportHeight: number,
  scrollTop: number,
  scrollHeight: number,
  placement: Placement,
}): number {
  const padding = Math.min(48, viewportHeight / 8);
  let top: number;
  switch (placement) {
  case 'initial':
    top = rowTop - Math.max(0, viewportHeight - rowHeight) / 3;
    break;
  case 'nearest':
    if (rowHeight > viewportHeight - padding * 2 || rowTop < scrollTop + padding) {
      top = rowTop - padding;
    } else if (rowTop + rowHeight > scrollTop + viewportHeight - padding) {
      top = rowTop + rowHeight - viewportHeight + padding;
    } else {
      top = scrollTop;
    }
    break;
  default: {
    const exhaustive: never = placement;
    return exhaustive;
  }
  }
  return Math.max(0, Math.min(Math.max(0, scrollHeight - viewportHeight), top));
}

/** Reveal only inside the sidebar list, without changing the editor's focus. */
export function useSidebarItemReveal({ container, items, target, expandedChatGroupIds, compactThreshold, isOpen, isDragging, focusArea, focusVersion }: {
  container: Readonly<Ref<HTMLElement | null>>,
  items: Readonly<Ref<SidebarItem[]>>,
  target: Readonly<Ref<SidebarRevealTarget | undefined>>,
  expandedChatGroupIds: Ref<Set<ChatGroupId>>,
  compactThreshold: number,
  isOpen: Readonly<Ref<boolean>>,
  isDragging: Readonly<Ref<boolean>>,
  focusArea: Readonly<Ref<FocusArea>>,
  focusVersion: Readonly<Ref<number>>,
}) {
  let pending: { target: SidebarRevealTarget, placement: Placement, behavior: ScrollBehavior } | undefined;
  let initialPlacement = true;
  let disposed = false;
  let revision = 0;
  let observer: ResizeObserver | undefined;
  let smoothScroll: { container: HTMLElement, top: number } | undefined;

  function releaseCompletedScroll(): void {
    if (smoothScroll !== undefined && Math.abs(smoothScroll.container.scrollTop - smoothScroll.top) < 1) {
      smoothScroll = undefined;
    }
  }

  function stopSmoothScroll(): void {
    const scroll = smoothScroll;
    smoothScroll = undefined;
    if (scroll !== undefined && Math.abs(scroll.container.scrollTop - scroll.top) >= 1) {
      // Replacing pending work cannot abort a native scroll already in progress.
      // Only stop our own movement, and release ownership on arrival or input.
      scroll.container.scrollTo({ top: scroll.container.scrollTop, behavior: 'auto' });
    }
  }

  function interruptReveal(): void {
    pending = undefined;
    ++revision;
    initialPlacement = false;
    stopSmoothScroll();
  }

  function rowTarget({ selected }: { selected: SidebarRevealTarget }): SidebarRevealTarget {
    switch (selected.type) {
    case 'chat_group': return selected;
    case 'chat':
      for (const item of items.value) {
        switch (item.type) {
        case 'chat': break;
        case 'chat_group': {
          const index = item.chatGroup.items.findIndex(child => child.chat.id === selected.id);
          if (index < 0) {
            break;
          }
          // Respect saved collapse state. Its heading represents the hidden chat.
          if (item.chatGroup.isCollapsed) {
            return { type: 'chat_group', id: item.chatGroup.id };
          }
          if (index >= compactThreshold) {
            expandedChatGroupIds.value.add(item.chatGroup.id);
          }
          return selected;
        }
        default: {
          const exhaustive: never = item;
          return exhaustive;
        }
        }
      }
      return selected;
    default: {
      const exhaustive: never = selected;
      return exhaustive;
    }
    }
  }

  async function attempt(): Promise<void> {
    const request = pending;
    const attemptRevision = ++revision;
    if (request === undefined || disposed || !isOpen.value || isDragging.value) {
      return;
    }
    const selected = rowTarget({ selected: request.target });
    await nextTick();
    if (disposed || attemptRevision !== revision || pending !== request || !isOpen.value || isDragging.value) {
      return;
    }
    const nav = container.value;
    if (nav === null || nav.clientHeight <= 0) {
      return;
    }
    const attribute = (() => {
      switch (selected.type) {
      case 'chat': return 'data-sidebar-chat-id';
      case 'chat_group': return 'data-sidebar-group-id';
      default: {
        const exhaustive: never = selected;
        return exhaustive;
      }
      }
    })();
    const row = Array.from(nav.querySelectorAll<HTMLElement>(`[${attribute}]`)).find(element =>
      element.getAttribute(attribute) === idToRaw({ id: selected.id }),
    );
    if (row === undefined) {
      return;
    }
    // FLIP rects include a temporary visual offset. Its existing cleanup retries
    // this request after removing the transform, including interrupted motion.
    if (row.closest('.sidebar-reorder-animating') !== null) {
      return;
    }
    const rect = row.getBoundingClientRect();
    if (rect.height <= 0) {
      return;
    }
    // An expanding list can contain the row in the DOM while still clipping it.
    // Its transitionend retries the pending request at the final geometry.
    for (let parent = row.parentElement; parent !== null && parent !== nav; parent = parent.parentElement) {
      if (!parent.hasAttribute('data-sidebar-chat-list') && !parent.hasAttribute('data-sidebar-chat-group-content')) {
        continue;
      }
      const bounds = parent.getBoundingClientRect();
      if (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1) {
        return;
      }
    }
    const navRect = nav.getBoundingClientRect();
    const top = scrollPosition({
      rowTop: rect.top - navRect.top - nav.clientTop + nav.scrollTop,
      rowHeight: rect.height,
      viewportHeight: nav.clientHeight,
      scrollTop: nav.scrollTop,
      scrollHeight: nav.scrollHeight,
      placement: request.placement,
    });
    pending = undefined;
    initialPlacement = false;
    if (Math.abs(top - nav.scrollTop) < 1) {
      return;
    }
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const behavior = reducedMotion ? 'auto' : request.behavior;
    switch (behavior) {
    case 'smooth': smoothScroll = { container: nav, top };
      break;
    case 'auto': case 'instant': smoothScroll = undefined;
      break;
    default: {
      const exhaustive: never = behavior;
      throw new Error(String(exhaustive));
    }
    }
    nav.scrollTo({ top, behavior });
  }

  function requestReveal({ placement, behavior }: { placement: Placement, behavior: ScrollBehavior }): void {
    const selected = target.value;
    if (selected === undefined) {
      return;
    }
    stopSmoothScroll();
    // Initial autofocus must not replace the URL's immediate positioning.
    if (pending?.placement === 'initial' && sameTarget({ left: pending.target, right: selected })) {
      void attempt();
      return;
    }
    pending = { target: selected, placement, behavior };
    void attempt();
  }

  watch(target, (selected, previous) => {
    if (sameTarget({ left: selected, right: previous })) {
      return;
    }
    stopSmoothScroll();
    pending = undefined;
    ++revision;
    if (selected !== undefined) {
      requestReveal({ placement: initialPlacement ? 'initial' : 'nearest', behavior: initialPlacement ? 'auto' : 'smooth' });
    }
  }, { immediate: true, flush: 'sync' });

  watch(focusVersion, () => {
    switch (focusArea.value) {
    case 'chat':
    case 'chat-settings':
    case 'chat-group-settings':
      requestReveal({ placement: initialPlacement ? 'initial' : 'nearest', behavior: initialPlacement ? 'auto' : 'smooth' });
      return;
    case 'sidebar':
    case 'settings':
    case 'onboarding':
    case 'dialog':
    case 'none':
    case 'search': return;
    default: {
      const exhaustive: never = focusArea.value;
      throw new Error(`Unhandled sidebar focus area: ${exhaustive}`);
    }
    }
  });

  watch([isOpen, isDragging], ([open, dragging], [wasOpen, wasDragging]) => {
    ++revision;
    if (!open || dragging) {
      stopSmoothScroll();
      return;
    }
    if (!wasOpen) {
      requestReveal({ placement: 'initial', behavior: 'auto' });
    } else if (wasDragging) {
      requestReveal({ placement: initialPlacement ? 'initial' : 'nearest', behavior: 'auto' });
    }
  });
  // Metadata updates only retry unfinished work, never pull back manual scrolling.
  watch(items, () => {
    if (pending !== undefined) {
      void attempt();
    }
  }, { deep: true, flush: 'post' });
  watch(container, (nav, previous) => {
    if (previous !== null) {
      observer?.unobserve(previous);
    }
    if (nav !== null) {
      observer?.observe(nav);
    }
    if (pending !== undefined) {
      void attempt();
    }
  }, { flush: 'post' });

  onMounted(() => {
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (pending !== undefined) {
          void attempt();
        }
      });
      if (container.value !== null) {
        observer.observe(container.value);
      }
    }
    if (pending !== undefined) {
      void attempt();
    } else {
      initialPlacement = false;
    }
  });
  onBeforeUnmount(() => {
    stopSmoothScroll();
    disposed = true;
    pending = undefined;
    ++revision;
    observer?.disconnect();
  });

  return {
    releaseCompletedScroll,
    interruptReveal,
    retry: () => {
      if (pending !== undefined) {
        void attempt();
      }
    },
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
  scrollPosition,
};
