import { computed, onBeforeUnmount, onMounted, ref, type CSSProperties, type Ref } from 'vue';
import { useElementBounding, useWindowSize } from '@vueuse/core';
import { useEventTargetListener } from '@/composables/useEventTargetListener';

/** Keep a body-teleported popup inside the currently visible viewport. */
export function useAnchoredPopup({ anchor, preferredWidth, maxWidthPx, preferredPlacement }: {
  anchor: Ref<HTMLElement | null>,
  preferredWidth: { unit: 'px' | 'rem', value: number },
  maxWidthPx: number | undefined,
  preferredPlacement?: { direction: 'top' | 'bottom', minHeightPx: number },
}) {
  const bounds = useElementBounding(anchor);
  const windowSize = useWindowSize();
  const viewport = ref<{ left: number, top: number, width: number, height: number }>();
  const rootFontSize = ref(16);

  function measureViewport() {
    const visible = window.visualViewport;
    viewport.value = visible ? { left: visible.offsetLeft, top: visible.offsetTop, width: visible.width, height: visible.height } : undefined;
    rootFontSize.value = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  }

  function refresh() {
    measureViewport();
    bounds.update?.();
  }

  function handleAncestorTransition({ event }: { event: TransitionEvent }) {
    if (event.target instanceof HTMLElement && anchor.value && event.target.contains(anchor.value)) {
      refresh();
    }
  }
  useEventTargetListener(document, 'transitionend', event => handleAncestorTransition({ event }), { capture: true });

  onMounted(() => {
    measureViewport();
    window.visualViewport?.addEventListener('resize', measureViewport);
    window.visualViewport?.addEventListener('scroll', measureViewport);
    window.addEventListener('resize', measureViewport);
  });
  onBeforeUnmount(() => {
    window.visualViewport?.removeEventListener('resize', measureViewport);
    window.visualViewport?.removeEventListener('scroll', measureViewport);
    window.removeEventListener('resize', measureViewport);
  });

  const placement = computed(() => {
    const visible = viewport.value ?? { left: 0, top: 0, width: windowSize.width.value, height: windowSize.height.value };
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
    const left = Math.max(visible.left + gap, Math.min(bounds.left.value, visible.left + visible.width - gap - width));
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
      bottom: opensAbove ? `${windowSize.height.value - top}px` : 'auto',
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
