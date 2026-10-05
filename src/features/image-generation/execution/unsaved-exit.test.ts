import { expect, it, vi } from 'vitest';
import { protectUnsavedImages } from './unsaved-exit';
it('warns only while application-owned images or metadata remain pending, independent of a view', () => {
  const target = new EventTarget(); let pending = false, listener = () => {}; const unsubscribe = vi.fn();
  const dispose = protectUnsavedImages({ target, hasPending: () => pending, subscribe: ({ listener: value }) => {
    listener = value; return unsubscribe;
  } });
  const close = () => {
    const event = new Event('beforeunload', { cancelable: true }); target.dispatchEvent(event); return event.defaultPrevented;
  };
  expect(close()).toBe(false); pending = true; listener(); expect(close()).toBe(true);
  listener(); expect(close()).toBe(true); pending = false; listener(); expect(close()).toBe(false);
  pending = true; listener(); dispose(); expect(close()).toBe(false); expect(unsubscribe).toHaveBeenCalledOnce();
});
