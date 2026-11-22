import { ref } from 'vue';

export function useImageViewport() {
  const zoom = ref(1);
  const position = ref({ x: 0, y: 0 });
  let pointer: { id: number, x: number, y: number } | undefined;

  function reset(): void {
    pointer = undefined;
    zoom.value = 1;
    position.value = { x: 0, y: 0 };
  }

  function magnify({ factor }: { factor: number }): void {
    zoom.value = Math.max(0.25, Math.min(8, zoom.value * factor));
  }

  function pointerDown({ event }: { event: PointerEvent }): void {
    if (!(event.currentTarget instanceof HTMLElement) || event.button !== 0 || pointer) {
      return;
    }
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove({ event }: { event: PointerEvent }): void {
    if (!pointer || event.pointerId !== pointer.id) {
      return;
    }
    position.value = { x: position.value.x + event.clientX - pointer.x, y: position.value.y + event.clientY - pointer.y };
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function endPan({ event }: { event: PointerEvent }): void {
    if (pointer?.id === event.pointerId) {
      pointer = undefined;
    }
  }

  return {
    zoom,
    position,
    reset,
    magnify,
    pointerDown,
    pointerMove,
    endPan,
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
