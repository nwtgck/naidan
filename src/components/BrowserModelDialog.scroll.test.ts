import { mount } from '@vue/test-utils';
import { h, nextTick, ref } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import BrowserModelDialog from './BrowserModelDialog.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle() {
  await nextTick();
  await nextTick();
}

function renderDialog({ transitionMs, initialHeight }: { transitionMs: number, initialHeight: number }) {
  const expanded = ref(false);
  const view = ref<'models' | 'other'>('models');
  const resizeObserver = vi.fn();
  const mutationsDisconnected = vi.spyOn(MutationObserver.prototype, 'disconnect');
  const addedListener = vi.spyOn(window, 'addEventListener');
  let viewportHeight = 200;
  let contentHeight = initialHeight;
  let disposed = false;
  vi.stubGlobal('ResizeObserver', resizeObserver);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'browser-model-dialog-content' ? viewportHeight : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'browser-model-dialog-content' ? contentHeight : 0;
  });
  const wrapper = mount(BrowserModelDialog, {
    props: { open: true, dismissible: true, suspended: false },
    attachTo: document.body,
    global: { stubs: { teleport: true } },
    slots: {
      default: () => view.value === 'other' ? h('section', { key: 'other' }, 'Another step') : h('div', { key: 'models', 'data-testid': 'model-view' }, [
        h('button', { 'data-testid': 'start-action', type: 'button' }, 'Try model'),
        h('div', { 'data-browser-model-preparation-error': '', 'data-testid': 'preparation-error' }, [
          h('p', { 'data-testid': 'preparation-error-copy', role: 'alert' }, 'Could not prepare this model.'),
          h('button', {
            'data-testid': 'failure-trigger',
            type: 'button',
            'aria-expanded': expanded.value,
            'aria-controls': expanded.value ? 'failure-body' : undefined,
            onClick: () => {
              expanded.value = !expanded.value;
            },
          }, 'Hints for this error'),
          h('div', { id: 'failure-body', 'data-testid': 'guidance-body', 'aria-hidden': !expanded.value, inert: expanded.value ? undefined : true, style: { transitionDuration: `${transitionMs}ms` } }, expanded.value ? [
            h('h4', { 'data-testid': 'guidance-heading' }, 'Use model files on this device'),
            h('button', { type: 'button', 'data-testid': 'guidance-action' }, 'Choose files'),
          ] : []),
        ]),
      ]),
    },
  });
  const scroller = wrapper.get<HTMLElement>('[data-testid="browser-model-dialog-content"]').element;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'browser-model-dialog-content') {
      return new DOMRect(0, 100, 600, viewportHeight);
    }
    const top = (() => {
      switch (this.dataset.testid) {
      case 'preparation-error-copy': return 700;
      case 'failure-trigger': return 740;
      case 'guidance-heading': return 780;
      case 'guidance-action': return 820;
      default: return 0;
      }
    })();
    return new DOMRect(0, 100 + top - scroller.scrollTop, 600, 20);
  });
  const scroll = vi.fn(({ top }: ScrollToOptions) => {
    if (top !== undefined) {
      scroller.scrollTop = top;
    }
  });
  Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scroll });
  return {
    wrapper,
    scroller,
    scroll,
    expanded,
    view,
    resizeObserver,
    mutationsDisconnected,
    addedListener,
    resize({ viewport, height }: { viewport: number, height: number }) {
      viewportHeight = viewport;
      contentHeight = height;
    },
    [Symbol.dispose]() {
      if (!disposed) {
        disposed = true;
        wrapper.unmount();
      }
    },
  };
}

it('adds no continuation cue or geometry observers even when the modal overflows', async () => {
  using dialog = renderDialog({ transitionMs: 0, initialHeight: 150 });
  await settle();
  expect(dialog.wrapper.find('[data-testid="browser-model-dialog-scroll-cue"]').exists()).toBe(false);
  dialog.resize({ viewport: 200, height: 1000 });
  await settle();
  expect(dialog.wrapper.find('[data-testid="browser-model-dialog-scroll-cue"]').exists()).toBe(false);
  dialog.scroller.scrollTop = 800;
  await dialog.wrapper.get('[data-testid="browser-model-dialog-content"]').trigger('scroll');
  expect(dialog.wrapper.find('[data-testid="browser-model-dialog-scroll-cue"]').exists()).toBe(false);
  dialog.resize({ viewport: 200, height: 1200 });
  await settle();
  expect(dialog.wrapper.find('[data-testid="browser-model-dialog-scroll-cue"]').exists()).toBe(false);
  expect(dialog.resizeObserver).not.toHaveBeenCalled();
  expect(dialog.addedListener).not.toHaveBeenCalledWith('resize', expect.any(Function));
  expect(dialog.scroll).not.toHaveBeenCalled();
});

it('reveals only the error and first hint action inside the modal without moving focus', async () => {
  using dialog = renderDialog({ transitionMs: 0, initialHeight: 1000 });
  await settle();
  const start = dialog.wrapper.get<HTMLElement>('[data-testid="start-action"]').element;
  start.focus();
  await dialog.wrapper.vm.revealPreparationError({ isCurrent: () => true });
  expect(dialog.scroll).toHaveBeenCalledExactlyOnceWith({ top: 584, behavior: 'auto' });
  expect(document.activeElement).toBe(start);
  expect(dialog.wrapper.get('[data-testid="start-action"]').element).toBe(start);
  await dialog.wrapper.vm.revealPreparationError({ isCurrent: () => true });
  expect(dialog.scroll).toHaveBeenCalledOnce();
});

it('clamps the reveal to the modal range and leaves an already visible error in place', async () => {
  using dialog = renderDialog({ transitionMs: 0, initialHeight: 760 });
  await settle();
  await dialog.wrapper.vm.revealPreparationError({ isCurrent: () => true });
  expect(dialog.scroller.scrollTop).toBe(560);
  dialog.resize({ viewport: 200, height: 1000 });
  dialog.scroller.scrollTop = 650;
  dialog.scroll.mockClear();
  await dialog.wrapper.vm.revealPreparationError({ isCurrent: () => true });
  expect(dialog.scroll).not.toHaveBeenCalled();
  dialog.scroller.scrollTop = 780;
  await dialog.wrapper.vm.revealPreparationError({ isCurrent: () => true });
  expect(dialog.scroll).toHaveBeenCalledExactlyOnceWith({ top: 676, behavior: 'auto' });
});

it('reveals an explicitly expanded hint through its first action and keeps the trigger focused', async () => {
  vi.useFakeTimers();
  using dialog = renderDialog({ transitionMs: 0, initialHeight: 1000 });
  await settle();
  dialog.scroller.scrollTop = 600;
  const trigger = dialog.wrapper.get<HTMLElement>('[data-testid="failure-trigger"]');
  trigger.element.focus();
  await trigger.trigger('click');
  await settle();
  expect(dialog.scroll).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  await settle();
  expect(dialog.scroll).toHaveBeenCalledExactlyOnceWith({ top: 664, behavior: 'auto' });
  expect(document.activeElement).toBe(trigger.element);
  await trigger.trigger('click');
  await settle();
  expect(dialog.scroll).toHaveBeenCalledOnce();
});

it('keeps reactive content changes passive without a continuation cue', async () => {
  using dialog = renderDialog({ transitionMs: 0, initialHeight: 1000 });
  await settle();
  dialog.expanded.value = true;
  dialog.resize({ viewport: 200, height: 1400 });
  await settle();
  window.dispatchEvent(new Event('resize'));
  await settle();
  expect(dialog.wrapper.find('[data-testid="browser-model-dialog-scroll-cue"]').exists()).toBe(false);
  expect(dialog.scroll).not.toHaveBeenCalled();
});

it.each(['wheel', 'touchstart', 'pointerdown', 'keydown', 'scroll'])('cancels a pending expansion reveal when the user takes over with %s', async event => {
  vi.useFakeTimers();
  using dialog = renderDialog({ transitionMs: 200, initialHeight: 1000 });
  await settle();
  await dialog.wrapper.get('[data-testid="failure-trigger"]').trigger('click');
  await settle();
  await vi.advanceTimersByTimeAsync(0);
  await settle();
  expect(dialog.scroll).not.toHaveBeenCalled();
  await dialog.wrapper.get('[data-testid="browser-model-dialog-content"]').trigger(event, { key: 'PageDown' });
  await vi.advanceTimersByTimeAsync(300);
  expect(dialog.scroll).not.toHaveBeenCalled();
});

it.each(['close', 'suspend', 'replace'] as const)('does not apply a pending expansion reveal after %s and returning', async change => {
  vi.useFakeTimers();
  using dialog = renderDialog({ transitionMs: 200, initialHeight: 1000 });
  await settle();
  await dialog.wrapper.get('[data-testid="failure-trigger"]').trigger('click');
  await settle();
  await vi.advanceTimersByTimeAsync(0);
  await settle();
  switch (change) {
  case 'close':
    await dialog.wrapper.setProps({ open: false });
    await dialog.wrapper.setProps({ open: true });
    break;
  case 'suspend':
    await dialog.wrapper.setProps({ suspended: true });
    await dialog.wrapper.setProps({ suspended: false });
    break;
  case 'replace':
    dialog.view.value = 'other';
    await settle();
    dialog.view.value = 'models';
    break;
  default: {
    const exhaustive: never = change;
    throw new Error(String(exhaustive));
  }
  }
  await settle();
  await vi.advanceTimersByTimeAsync(300);
  expect(dialog.scroll).not.toHaveBeenCalled();
  expect(dialog.wrapper.get<HTMLElement>('[data-testid="browser-model-dialog-content"]').element.scrollTop).toBe(0);
});

it('reveals once after the expansion transition and does not repeat at its fallback deadline', async () => {
  vi.useFakeTimers();
  using dialog = renderDialog({ transitionMs: 200, initialHeight: 1000 });
  await settle();
  dialog.scroller.scrollTop = 600;
  await dialog.wrapper.get('[data-testid="failure-trigger"]').trigger('click');
  await settle();
  await vi.advanceTimersByTimeAsync(0);
  await settle();
  await dialog.wrapper.get('[data-testid="guidance-body"]').trigger('transitionend', { propertyName: 'grid-template-rows' });
  expect(dialog.scroll).toHaveBeenCalledExactlyOnceWith({ top: 664, behavior: 'auto' });
  await vi.advanceTimersByTimeAsync(300);
  expect(dialog.scroll).toHaveBeenCalledOnce();
});

it.each(['wheel', 'close'] as const)('cancels the post-dispatch task before it starts after %s', async action => {
  vi.useFakeTimers();
  using dialog = renderDialog({ transitionMs: 0, initialHeight: 1000 });
  await settle();
  await dialog.wrapper.get('[data-testid="failure-trigger"]').trigger('click');
  await settle();
  switch (action) {
  case 'wheel': await dialog.wrapper.get('[data-testid="browser-model-dialog-content"]').trigger('wheel');
    break;
  case 'close':
    await dialog.wrapper.setProps({ open: false });
    await dialog.wrapper.setProps({ open: true });
    break;
  default: {
    const exhaustive: never = action;
    throw new Error(String(exhaustive));
  }
  }
  await vi.advanceTimersByTimeAsync(300);
  expect(dialog.scroll).not.toHaveBeenCalled();
  expect(dialog.wrapper.get<HTMLElement>('[data-testid="browser-model-dialog-content"]').element.scrollTop).toBe(0);
});

it('cancels an attempt reveal before DOM settlement when input or the operation expires', async () => {
  using dialog = renderDialog({ transitionMs: 0, initialHeight: 1000 });
  await settle();
  const interrupted = dialog.wrapper.vm.revealPreparationError({ isCurrent: () => true });
  await dialog.wrapper.get('[data-testid="browser-model-dialog-content"]').trigger('wheel');
  await interrupted;
  expect(dialog.scroll).not.toHaveBeenCalled();
  await dialog.wrapper.vm.revealPreparationError({ isCurrent: () => false });
  expect(dialog.scroll).not.toHaveBeenCalled();
});

it('keeps selection usable when geometry or scroll APIs fail and falls back when scrollTo is absent', async () => {
  using dialog = renderDialog({ transitionMs: 0, initialHeight: 1000 });
  await settle();
  const geometry = dialog.scroller.getBoundingClientRect;
  Object.defineProperty(dialog.scroller, 'getBoundingClientRect', {
    configurable: true,
    value: () => {
      throw new Error('No geometry');
    },
  });
  await expect(dialog.wrapper.vm.revealPreparationError({ isCurrent: () => true })).resolves.toBeUndefined();
  expect(dialog.scroll).not.toHaveBeenCalled();
  Object.defineProperty(dialog.scroller, 'getBoundingClientRect', { configurable: true, value: geometry });
  dialog.scroll.mockImplementationOnce(() => {
    throw new Error('Scrolling unavailable');
  });
  await expect(dialog.wrapper.vm.revealPreparationError({ isCurrent: () => true })).resolves.toBeUndefined();
  expect(dialog.wrapper.get('[data-testid="start-action"]').attributes('disabled')).toBeUndefined();
  Object.defineProperty(dialog.scroller, 'scrollTo', { configurable: true, value: undefined });
  await dialog.wrapper.vm.revealPreparationError({ isCurrent: () => true });
  expect(dialog.scroller.scrollTop).toBe(584);
});

it('reveals the error without depending on a geometry observer', async () => {
  using dialog = renderDialog({ transitionMs: 0, initialHeight: 1000 });
  vi.stubGlobal('ResizeObserver', undefined);
  await settle();
  await dialog.wrapper.vm.revealPreparationError({ isCurrent: () => true });
  expect(dialog.scroll).toHaveBeenCalledExactlyOnceWith({ top: 584, behavior: 'auto' });
  expect(dialog.wrapper.find('[data-testid="browser-model-dialog-scroll-cue"]').exists()).toBe(false);
  expect(dialog.wrapper.get('[data-testid="start-action"]').attributes('disabled')).toBeUndefined();
});

it('disconnects step tracking and cancels a pending reveal when unmounted', async () => {
  vi.useFakeTimers();
  using dialog = renderDialog({ transitionMs: 200, initialHeight: 1000 });
  await settle();
  await dialog.wrapper.get('[data-testid="failure-trigger"]').trigger('click');
  await settle();
  await vi.advanceTimersByTimeAsync(0);
  await settle();
  dialog[Symbol.dispose]();
  await vi.advanceTimersByTimeAsync(300);
  expect(dialog.mutationsDisconnected).toHaveBeenCalled();
  expect(dialog.scroll).not.toHaveBeenCalled();
});
