import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useToast } from './useToast';

describe('useToast', () => {
  beforeEach(() => {
    const { toasts } = useToast();
    toasts.value = [];
    vi.useFakeTimers();
  });

  it('adds and removes toasts', () => {
    const { addToast, removeToast, toasts } = useToast();
    
    const id = addToast({ message: 'Hello' });
    expect(toasts.value).toHaveLength(1);
    expect(toasts.value[0]?.message).toBe('Hello');

    removeToast(id);
    expect(toasts.value).toHaveLength(0);
  });

  it('automatically removes toast after duration', () => {
    const { addToast, toasts } = useToast();
    
    addToast({ message: 'Temporary', duration: 1000 });
    expect(toasts.value).toHaveLength(1);

    vi.advanceTimersByTime(1001);
    expect(toasts.value).toHaveLength(0);
  });

  it('does not remove toast when duration is 0', () => {
    const { addToast, toasts } = useToast();
    
    addToast({ message: 'Permanent', duration: 0 });
    expect(toasts.value).toHaveLength(1);

    vi.advanceTimersByTime(100000);
    expect(toasts.value).toHaveLength(1);
  });

  it('uses default duration of 20000ms', () => {
    const { addToast, toasts } = useToast();
    
    addToast({ message: 'Default' });
    
    vi.advanceTimersByTime(19999);
    expect(toasts.value).toHaveLength(1);

    vi.advanceTimersByTime(2);
    expect(toasts.value).toHaveLength(0);
  });
});
