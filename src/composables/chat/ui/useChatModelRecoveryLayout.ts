import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue';

type Rect = { left: number, top: number, right: number, bottom: number };
type RecoveryLayout = { left: number, bottom: number, width: number, compactHeight: number, expandedHeight: number };

/** All rects use layout-viewport coordinates, including the visual viewport. */
export function calculateChatModelRecoveryLayout({ anchor, anchorViewport, anchorClip, root, viewport, visual }: {
  anchor: Rect, anchorViewport: Rect, anchorClip: Rect, root: Rect, viewport: Rect, visual: Rect,
}): RecoveryLayout | undefined {
  const safeTop = Math.max(viewport.top + 12, root.top, visual.top);
  const left = Math.max(anchor.left, anchorViewport.left, anchorClip.left, root.left, visual.left);
  const right = Math.min(anchor.right, anchorViewport.right, anchorClip.right, root.right, visual.right);
  const top = Math.max(anchor.top, anchorViewport.top, anchorClip.top, safeTop);
  const bottom = Math.min(anchor.bottom, anchorViewport.bottom, anchorClip.bottom, root.bottom, visual.bottom);
  if (right <= left || bottom <= top) {
    return undefined;
  }
  return { left: left - root.left, bottom: root.bottom - bottom, width: right - left, compactHeight: bottom - top, expandedHeight: Math.min(720, bottom - safeTop) };
}

/** The compact footprint participates in composer layout; the frame never does. */
export function useChatModelRecoveryLayout({ anchor, anchorViewport, anchorClip, root, viewport, toolbar }: {
  anchor: Readonly<Ref<HTMLElement | undefined>>,
  anchorViewport: Readonly<Ref<HTMLElement | undefined>>,
  anchorClip: Readonly<Ref<HTMLElement | undefined>>,
  root: Readonly<Ref<HTMLElement | undefined>>,
  viewport: Readonly<Ref<HTMLElement | undefined>>,
  toolbar: Readonly<Ref<HTMLElement | undefined>>,
}) {
  const layout = shallowRef<RecoveryLayout>();
  const toolbarHeight = ref(0);
  let observer: ResizeObserver | undefined;
  let frame: number | undefined;
  let disposed = false;

  function measure(): void {
    if (disposed) {
      return;
    }
    const anchorElement = anchor.value;
    const rootElement = root.value;
    const viewportElement = viewport.value;
    const anchorViewportElement = anchorViewport.value;
    const anchorClipElement = anchorClip.value;
    if (anchorElement === undefined || rootElement === undefined || viewportElement === undefined || anchorViewportElement === undefined || anchorClipElement === undefined) {
      layout.value = undefined;
      return;
    }
    const visual = window.visualViewport;
    const left = visual?.offsetLeft ?? 0;
    const top = visual?.offsetTop ?? 0;
    layout.value = calculateChatModelRecoveryLayout({
      anchor: anchorElement.getBoundingClientRect(),
      anchorViewport: anchorViewportElement.getBoundingClientRect(),
      anchorClip: anchorClipElement.getBoundingClientRect(),
      root: rootElement.getBoundingClientRect(),
      viewport: viewportElement.getBoundingClientRect(),
      visual: { left, top, right: left + (visual?.width ?? window.innerWidth), bottom: top + (visual?.height ?? window.innerHeight) },
    });
    toolbarHeight.value = toolbar.value?.scrollHeight ?? 0;
  }

  function schedule(): void {
    if (frame !== undefined || disposed) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = undefined;
      measure();
    });
  }

  function observe(): void {
    observer?.disconnect();
    for (const element of [anchor.value, anchorViewport.value, anchorClip.value, root.value, viewport.value, toolbar.value]) {
      if (element !== undefined) {
        observer?.observe(element);
      }
    }
    measure();
  }
  watch([anchor, anchorViewport, anchorClip, root, viewport, toolbar], observe, { flush: 'post' });
  onMounted(() => {
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule);
    }
    observe();
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    document.fonts?.addEventListener('loadingdone', schedule);
  });
  onBeforeUnmount(() => {
    disposed = true;
    observer?.disconnect();
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
    }
    window.removeEventListener('resize', schedule);
    document.removeEventListener('scroll', schedule, true);
    window.visualViewport?.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('scroll', schedule);
    document.fonts?.removeEventListener('loadingdone', schedule);
  });
  return {
    layout,
    // At very low heights, the whole frame scrolls instead of nesting a source
    // viewport beneath a toolbar which already fills the available space.
    scrollMode: computed<'source' | 'frame'>(() => layout.value !== undefined && layout.value.expandedHeight < toolbarHeight.value + 96 ? 'frame' : 'source'),
    measure,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
