import { onUnmounted } from 'vue';

const LONG_PRESS_DELAY_MS = 600;
const LONG_PRESS_MOVE_THRESHOLD_PX = 12;
const CLICK_SUPPRESSION_TIMEOUT_MS = 1_000;

type ActiveLongPress =
  | {
    status: 'waiting',
    pointerId: number,
    startX: number,
    startY: number,
    event: PointerEvent,
    timeoutId: ReturnType<typeof setTimeout>,
  }
  | {
    status: 'triggered',
    pointerId: number,
  };

type ClickSuppressionState =
  | { status: 'inactive' }
  | { status: 'pending', timeoutId: ReturnType<typeof setTimeout> };

export function useFileExplorerLongPress({
  onLongPress,
  isEnabled,
}: {
  onLongPress: ({ event }: { event: PointerEvent }) => void,
  isEnabled: (() => boolean) | undefined,
}) {
  let activeLongPress: ActiveLongPress | undefined;
  let clickSuppressionState: ClickSuppressionState = { status: 'inactive' };

  function clearClickSuppression(): void {
    switch (clickSuppressionState.status) {
    case 'inactive':
      break;
    case 'pending':
      clearTimeout(clickSuppressionState.timeoutId);
      clickSuppressionState = { status: 'inactive' };
      break;
    default: {
      const _ex: never = clickSuppressionState;
      throw new Error(`Unhandled click suppression state: ${JSON.stringify(_ex)}`);
    }
    }
  }

  function removeWindowListeners(): void {
    window.removeEventListener('pointermove', onWindowPointerMove);
    window.removeEventListener('pointerup', onWindowPointerUp);
    window.removeEventListener('pointercancel', onWindowPointerCancel);
  }

  function clearActiveLongPress(): void {
    const current = activeLongPress;
    activeLongPress = undefined;
    removeWindowListeners();
    if (current === undefined) return;
    switch (current.status) {
    case 'waiting':
      clearTimeout(current.timeoutId);
      break;
    case 'triggered':
      break;
    default: {
      const _ex: never = current;
      throw new Error(`Unhandled active long press state: ${JSON.stringify(_ex)}`);
    }
    }
  }

  function beginClickSuppression(): void {
    clearClickSuppression();
    const timeoutId = setTimeout(() => {
      switch (clickSuppressionState.status) {
      case 'inactive':
        break;
      case 'pending':
        if (clickSuppressionState.timeoutId === timeoutId) {
          clickSuppressionState = { status: 'inactive' };
        }
        break;
      default: {
        const _ex: never = clickSuppressionState;
        throw new Error(`Unhandled click suppression state: ${JSON.stringify(_ex)}`);
      }
      }
    }, CLICK_SUPPRESSION_TIMEOUT_MS);
    clickSuppressionState = { status: 'pending', timeoutId };
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- EventTarget callback contract.
  function onWindowPointerMove(event: PointerEvent): void {
    const current = activeLongPress;
    if (current === undefined || current.pointerId !== event.pointerId) return;
    switch (current.status) {
    case 'waiting': {
      const deltaX = event.clientX - current.startX;
      const deltaY = event.clientY - current.startY;
      if (Math.hypot(deltaX, deltaY) > LONG_PRESS_MOVE_THRESHOLD_PX) {
        clearActiveLongPress();
      }
      break;
    }
    case 'triggered':
      break;
    default: {
      const _ex: never = current;
      throw new Error(`Unhandled active long press state: ${JSON.stringify(_ex)}`);
    }
    }
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- EventTarget callback contract.
  function onWindowPointerUp(event: PointerEvent): void {
    const current = activeLongPress;
    if (current === undefined || current.pointerId !== event.pointerId) return;
    switch (current.status) {
    case 'waiting':
      break;
    case 'triggered':
      if (event.cancelable) {
        event.preventDefault();
        event.stopPropagation();
      }
      break;
    default: {
      const _ex: never = current;
      throw new Error(`Unhandled active long press state: ${JSON.stringify(_ex)}`);
    }
    }
    clearActiveLongPress();
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- EventTarget callback contract.
  function onWindowPointerCancel(event: PointerEvent): void {
    const current = activeLongPress;
    if (current === undefined || current.pointerId !== event.pointerId) return;
    clearActiveLongPress();
  }

  function onPointerDown({ event }: { event: PointerEvent }): void {
    if (
      (event.pointerType !== 'touch' && event.pointerType !== 'pen') ||
      !event.isPrimary ||
      event.button !== 0 ||
      (isEnabled !== undefined && !isEnabled())
    ) {
      return;
    }

    clearActiveLongPress();
    clearClickSuppression();

    const timeoutId = setTimeout(() => {
      const current = activeLongPress;
      if (current === undefined || current.pointerId !== event.pointerId) return;
      switch (current.status) {
      case 'waiting':
        activeLongPress = {
          status: 'triggered',
          pointerId: event.pointerId,
        };
        beginClickSuppression();
        onLongPress({ event: current.event });
        break;
      case 'triggered':
        break;
      default: {
        const _ex: never = current;
        throw new Error(`Unhandled active long press state: ${JSON.stringify(_ex)}`);
      }
      }
    }, LONG_PRESS_DELAY_MS);

    activeLongPress = {
      status: 'waiting',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      event,
      timeoutId,
    };

    window.addEventListener('pointermove', onWindowPointerMove, { passive: true });
    window.addEventListener('pointerup', onWindowPointerUp, { passive: false });
    window.addEventListener('pointercancel', onWindowPointerCancel, { passive: true });
  }

  function cancel(): void {
    clearActiveLongPress();
  }

  function consumeClick({ event }: { event: MouseEvent }): boolean {
    switch (clickSuppressionState.status) {
    case 'inactive':
      return false;
    case 'pending':
      clearClickSuppression();
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    default: {
      const _ex: never = clickSuppressionState;
      throw new Error(`Unhandled click suppression state: ${JSON.stringify(_ex)}`);
    }
    }
  }

  function dispose(): void {
    clearActiveLongPress();
    clearClickSuppression();
  }

  onUnmounted(dispose);

  return {
    onPointerDown,
    cancel,
    consumeClick,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        LONG_PRESS_DELAY_MS,
        LONG_PRESS_MOVE_THRESHOLD_PX,
      },
    }) || {}),
  };
}
