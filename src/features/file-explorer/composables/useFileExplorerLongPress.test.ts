import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileExplorerLongPress } from './useFileExplorerLongPress';

function createPointerEvent({
  type,
  pointerType = 'touch',
  pointerId = 1,
  clientX = 10,
  clientY = 20,
  isPrimary = true,
  button = 0,
  cancelable = true,
}: {
  type: string,
  pointerType?: string,
  pointerId?: number,
  clientX?: number,
  clientY?: number,
  isPrimary?: boolean,
  button?: number,
  cancelable?: boolean,
}): PointerEvent {
  const event = new Event(type, { cancelable }) as PointerEvent;
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    clientY: { value: clientY },
    isPrimary: { value: isPrimary },
    button: { value: button },
  });
  return event;
}

function createClickEvent(): MouseEvent {
  return new MouseEvent('click', { bubbles: true, cancelable: true });
}

describe('useFileExplorerLongPress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup({ enabled = true }: { enabled?: boolean } = {}) {
    const onLongPress = vi.fn();
    let controller: ReturnType<typeof useFileExplorerLongPress> | undefined;
    const wrapper = mount(defineComponent({
      setup() {
        controller = useFileExplorerLongPress({
          onLongPress,
          isEnabled: () => enabled,
        });
        return () => h('div');
      },
    }));
    if (controller === undefined) throw new Error('Expected long press controller');
    return { controller, onLongPress, wrapper };
  }

  it('fires after a stationary touch pointer is held for the delay', () => {
    const { controller, onLongPress, wrapper } = setup();
    const event = createPointerEvent({ type: 'pointerdown' });

    controller.onPointerDown({ event });
    vi.advanceTimersByTime(controller.TEST_ONLY.LONG_PRESS_DELAY_MS - 1);
    expect(onLongPress).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledWith({ event });
    wrapper.unmount();
  });

  it('ignores mouse pointer presses', () => {
    const { controller, onLongPress, wrapper } = setup();
    controller.onPointerDown({
      event: createPointerEvent({ type: 'pointerdown', pointerType: 'mouse' }),
    });

    vi.runAllTimers();
    expect(onLongPress).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('does not start while disabled', () => {
    const { controller, onLongPress, wrapper } = setup({ enabled: false });
    controller.onPointerDown({ event: createPointerEvent({ type: 'pointerdown' }) });

    vi.runAllTimers();
    expect(onLongPress).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('cancels when the pointer moves beyond the threshold', () => {
    const { controller, onLongPress, wrapper } = setup();
    controller.onPointerDown({ event: createPointerEvent({ type: 'pointerdown' }) });

    window.dispatchEvent(createPointerEvent({
      type: 'pointermove',
      clientX: 10 + controller.TEST_ONLY.LONG_PRESS_MOVE_THRESHOLD_PX + 1,
    }));
    vi.runAllTimers();

    expect(onLongPress).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('cancels when the pointer is released before the delay', () => {
    const { controller, onLongPress, wrapper } = setup();
    controller.onPointerDown({ event: createPointerEvent({ type: 'pointerdown' }) });
    window.dispatchEvent(createPointerEvent({ type: 'pointerup' }));

    vi.runAllTimers();
    expect(onLongPress).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('cancels when the browser takes over the gesture for scrolling', () => {
    const { controller, onLongPress, wrapper } = setup();
    controller.onPointerDown({ event: createPointerEvent({ type: 'pointerdown' }) });
    window.dispatchEvent(createPointerEvent({ type: 'pointercancel' }));

    vi.runAllTimers();
    expect(onLongPress).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('suppresses the compatibility click after a completed long press', () => {
    const { controller, wrapper } = setup();
    controller.onPointerDown({ event: createPointerEvent({ type: 'pointerdown' }) });
    vi.advanceTimersByTime(controller.TEST_ONLY.LONG_PRESS_DELAY_MS);

    const firstClick = createClickEvent();
    const firstPreventDefault = vi.spyOn(firstClick, 'preventDefault');
    const firstStopImmediatePropagation = vi.spyOn(firstClick, 'stopImmediatePropagation');
    expect(controller.consumeClick({ event: firstClick })).toBe(true);
    expect(firstPreventDefault).toHaveBeenCalled();
    expect(firstStopImmediatePropagation).toHaveBeenCalled();

    expect(controller.consumeClick({ event: createClickEvent() })).toBe(false);
    wrapper.unmount();
  });

  it('removes pending work when the component unmounts', () => {
    const { controller, onLongPress, wrapper } = setup();
    controller.onPointerDown({ event: createPointerEvent({ type: 'pointerdown' }) });
    wrapper.unmount();

    vi.runAllTimers();
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
