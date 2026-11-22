import { computed, shallowRef, watch } from 'vue';
import type { Ref } from 'vue';
import { useFileExplorerPreferences } from './useFileExplorerPreferences';

type WidthPreference = 'previewWidthPx' | 'treeWidthPx';
type WidthChange = { pixels: number, isCurrent: () => boolean };
const paneWidths = {
  previewWidthPx: { initial: 288, min: 176, max: 720, fraction: 0.7, direction: -1 },
  treeWidthPx: { initial: 208, min: 144, max: 400, fraction: 0.45, direction: 1 },
};
const pending = { previewWidthPx: shallowRef<WidthChange>(), treeWidthPx: shallowRef<WidthChange>() };
const keySaveTimers = new Map<WidthPreference, ReturnType<typeof setTimeout>>();
let saveTail = Promise.resolve();

export function useFileExplorerPaneWidth({ panel, preference }: {
  panel: Readonly<Ref<HTMLElement | null>>,
  preference: WidthPreference,
}) {
  const { preferences, initialized, captureStorage, savePreferences } = useFileExplorerPreferences();
  const { initial, min, max, fraction, direction } = paneWidths[preference];
  const preferredWidth = computed(() => {
    const stored = preferences.value?.[preference];
    const change = pending[preference].value;
    if (change?.isCurrent()) {
      return change.pixels;
    }
    return stored !== undefined && Number.isFinite(stored) ? Math.max(min, Math.min(max, Math.round(stored))) : initial;
  });
  const availableWidth = shallowRef(0);
  const maximum = computed(() => availableWidth.value > 0
    ? Math.max(1, Math.min(max, Math.floor(availableWidth.value * fraction)))
    : max);
  const minimum = computed(() => Math.min(maximum.value, min));
  const drag = shallowRef<{ id: number, startX: number, startWidth: number, pixels: number, isCurrent: () => boolean }>();
  const width = computed(() => {
    const active = drag.value;
    const pixels = active?.isCurrent() ? active.pixels : preferredWidth.value;
    return clampWidth({ pixels });
  });

  watch(panel, (element, _previous, onCleanup) => {
    const container = element?.parentElement;
    availableWidth.value = container?.clientWidth ?? 0;
    drag.value = undefined;
    if (!container || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => {
      availableWidth.value = container.clientWidth;
    });
    observer.observe(container);
    onCleanup(() => observer.disconnect());
  }, { flush: 'post' });

  function clampWidth({ pixels }: { pixels: number }): number {
    return Math.max(minimum.value, Math.min(maximum.value, Math.round(pixels)));
  }

  function saveWidth({ pixels, isCurrent, delayMs }: { pixels: number, isCurrent: () => boolean, delayMs: number }): void {
    if (!isCurrent()) {
      return;
    }
    const change = { pixels, isCurrent };
    pending[preference].value = change;
    clearTimeout(keySaveTimers.get(preference));
    keySaveTimers.delete(preference);
    if (!initialized.value) {
      return;
    }
    function enqueueSave(): void {
      keySaveTimers.delete(preference);
      saveTail = saveTail.then(async () => {
        if (pending[preference].value !== change) {
          return;
        }
        try {
          await savePreferences({ patch: { [preference]: Math.max(min, pixels) }, isCurrent });
        } finally {
          if (pending[preference].value === change) {
            pending[preference].value = undefined;
          }
        }
      });
    }
    if (delayMs === 0) {
      enqueueSave();
    } else {
      keySaveTimers.set(preference, setTimeout(enqueueSave, delayMs));
    }
  }

  function start({ event }: { event: PointerEvent }): void {
    if (event.button !== 0 || drag.value !== undefined || !(event.currentTarget instanceof HTMLElement)) {
      return;
    }
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const pixels = width.value;
    drag.value = { id: event.pointerId, startX: event.clientX, startWidth: pixels, pixels, isCurrent: captureStorage() };
  }

  function move({ event }: { event: PointerEvent }): void {
    const active = drag.value;
    if (active !== undefined && active.id === event.pointerId && active.isCurrent()) {
      const pixels = clampWidth({ pixels: active.startWidth + direction * (event.clientX - active.startX) });
      drag.value = { ...active, pixels };
    }
  }

  function end({ event, finish }: { event: PointerEvent, finish: 'save' | 'cancel' }): void {
    const active = drag.value;
    if (active !== undefined && active.id === event.pointerId) {
      drag.value = undefined;
      switch (finish) {
      case 'save':
        if (active.pixels !== active.startWidth) {
          saveWidth({ pixels: active.pixels, isCurrent: active.isCurrent, delayMs: 0 });
        }
        break;
      case 'cancel': break;
      default: {
        const exhaustive: never = finish;
        throw new Error(String(exhaustive));
      }
      }
    }
  }

  function onKeydown({ event }: { event: KeyboardEvent }): void {
    let pixels: number;
    switch (event.key) {
    case 'ArrowLeft': pixels = width.value - direction * 24;
      break;
    case 'ArrowRight': pixels = width.value + direction * 24;
      break;
    case 'Home': pixels = minimum.value;
      break;
    case 'End': pixels = maximum.value;
      break;
    default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    const next = clampWidth({ pixels });
    if (next !== width.value) {
      saveWidth({ pixels: next, isCurrent: captureStorage(), delayMs: 180 });
    }
  }

  return {
    width,
    minimum,
    maximum,
    resizing: computed(() => drag.value !== undefined),
    start,
    move,
    end,
    onKeydown,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

export const TEST_ONLY = {
};
