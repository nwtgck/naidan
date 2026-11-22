import { computed, onBeforeUnmount, onMounted, ref, toValue, type CSSProperties, type MaybeRefOrGetter, type Ref } from 'vue';
import { useElementBounding } from '@vueuse/core';
import { useEventTargetListener } from '@/composables/useEventTargetListener';

/** Keep a body-teleported popup inside the currently visible viewport. */
export function useAnchoredPopup({ anchor, preferredWidth, maxWidthPx, preferredPlacement, horizontalAlignment, ownerDocument = document }: {
  anchor: Ref<HTMLElement | null>,
  preferredWidth: { unit: 'px' | 'rem', value: number },
  maxWidthPx: number | undefined,
  preferredPlacement?: { direction: 'top' | 'bottom', minHeightPx: number },
  horizontalAlignment?: MaybeRefOrGetter<'left' | 'center'>,
  ownerDocument?: Document,
}) {
  const view = ownerDocument.defaultView ?? window;
  const bounds = useElementBounding(anchor, { windowScroll: view === window, windowResize: view === window });
  const windowSize = ref({ width: view.innerWidth, height: view.innerHeight });
  const viewport = ref<{ left: number, top: number, width: number, height: number }>();
  const rootFontSize = ref(16);

  function measureViewport() {
    windowSize.value = { width: view.innerWidth, height: view.innerHeight };
    const visible = view.visualViewport;
    viewport.value = visible ? { left: visible.offsetLeft, top: visible.offsetTop, width: visible.width, height: visible.height } : undefined;
    rootFontSize.value = parseFloat(view.getComputedStyle(ownerDocument.documentElement).fontSize) || 16;
  }

  function refresh() {
    measureViewport();
    bounds.update?.();
  }

  function handleAncestorTransition({ event }: { event: TransitionEvent }) {
    const target = event.target as Node | null;
    if (anchor.value && target?.contains(anchor.value)) {
      refresh();
    }
  }
  useEventTargetListener(ownerDocument, 'transitionend', event => handleAncestorTransition({ event }), { capture: true });
  const move = () => bounds.update();
  if (view !== window) {
    useEventTargetListener(view, 'scroll', move, { capture: true, passive: true });
    useEventTargetListener(view, 'resize', move, { passive: true });
  }

  onMounted(() => {
    measureViewport();
    view.visualViewport?.addEventListener('resize', measureViewport);
    view.visualViewport?.addEventListener('scroll', measureViewport);
    view.addEventListener('resize', measureViewport);
  });
  onBeforeUnmount(() => {
    view.visualViewport?.removeEventListener('resize', measureViewport);
    view.visualViewport?.removeEventListener('scroll', measureViewport);
    view.removeEventListener('resize', measureViewport);
  });

  const placement = computed(() => {
    const visible = viewport.value ?? { left: 0, top: 0, ...windowSize.value };
    const gap = Math.min(16, visible.width / 4, visible.height / 4);
    const preferredWidthPx = (() => {
      const unit = preferredWidth.unit;
      switch (unit) {
      case 'px': return preferredWidth.value;
      case 'rem': return preferredWidth.value * rootFontSize.value;
      default: {
        const _ex: never = unit;
        throw new Error(`Unhandled popup width unit: ${_ex}`);
      }
      }
    })();
    const width = Math.max(0, Math.min(Math.max(bounds.width.value, preferredWidthPx), visible.width - gap * 2, maxWidthPx ?? Number.POSITIVE_INFINITY));
    const alignment = toValue(horizontalAlignment);
    let preferredLeft = bounds.left.value;
    switch (alignment) {
    case 'center':
      preferredLeft += (bounds.width.value - width) / 2;
      break;
    case 'left': case undefined: break;
    default: throw new Error(String(alignment satisfies never));
    }
    const left = Math.max(visible.left + gap, Math.min(preferredLeft, visible.left + visible.width - gap - width));
    const bottom = visible.top + visible.height;
    const spaceAbove = Math.max(0, Math.min(bounds.top.value, bottom) - visible.top - gap - 8);
    const spaceBelow = Math.max(0, bottom - Math.max(bounds.bottom.value, visible.top) - gap - 8);
    let opensAbove: boolean;
    if (!preferredPlacement) {
      opensAbove = spaceBelow < 320 && spaceAbove > spaceBelow;
    } else {
      switch (preferredPlacement.direction) {
      case 'top': opensAbove = spaceAbove >= Math.min(preferredPlacement.minHeightPx, spaceBelow);
        break;
      case 'bottom': opensAbove = spaceBelow < Math.min(preferredPlacement.minHeightPx, spaceAbove);
        break;
      default: {
        const _ex: never = preferredPlacement.direction;
        throw new Error(`Unhandled popup placement: ${_ex}`);
      }
      }
    }
    const direction = opensAbove ? 'top' : 'bottom';
    const maxHeight = opensAbove ? spaceAbove : spaceBelow;
    const top = opensAbove ? Math.min(bottom - gap, bounds.top.value - 8) : Math.max(visible.top + gap, bounds.bottom.value + 8);
    const style: CSSProperties = {
      position: 'fixed',
      left: `${left}px`,
      width: `${width}px`,
      maxWidth: `${Math.max(0, Math.min(visible.width - gap * 2, maxWidthPx ?? Number.POSITIVE_INFINITY))}px`,
      maxHeight: `${maxHeight}px`,
      top: opensAbove ? 'auto' : `${top}px`,
      bottom: opensAbove ? `${windowSize.value.height - top}px` : 'auto',
      zIndex: 9999,
    };
    return { direction, style };
  });

  return {
    placement,
    refresh,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
