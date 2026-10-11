import { describe, expect, it, vi } from 'vitest';
import { createAsyncTestDisposable, createTestDisposable } from '@/utils/resource-cleanup.test-support';

// Compile-time checks complement runtime tests: an async callback must never be
// accepted by the synchronous adapter and silently left running after a test.
function checkAdapterTypes() {
  // @ts-expect-error Async cleanup requires the async adapter.
  createTestDisposable({ dispose: async () => {} });
  // @ts-expect-error A synchronous callback is not an asynchronous disposer.
  createAsyncTestDisposable({ dispose: () => {} });
}

void checkAdapterTypes;

describe('test-only resource cleanup', () => {
  it('uses native runtime symbols without modifying them', () => {
    expect(typeof Symbol.dispose).toBe('symbol');
    expect(typeof Symbol.asyncDispose).toBe('symbol');
    const before = Object.getOwnPropertyDescriptor(Symbol, 'dispose');
    {
      using _resource = createTestDisposable({ dispose: () => {} });
    }
    expect(Object.getOwnPropertyDescriptor(Symbol, 'dispose')).toEqual(before);
  });

  it('restores a Vitest spy at the original block boundary', () => {
    const target = { read: () => 'original' };
    {
      using spy = vi.spyOn(target, 'read').mockReturnValue('mock');
      expect(target.read()).toBe('mock');
      expect(spy).toHaveBeenCalledOnce();
    }
    expect(target.read()).toBe('original');
  });

  it('restores a spy when an assertion throws', () => {
    const target = { read: () => 1 };
    const failure = new Error('body');
    expect(() => {
      using _spy = vi.spyOn(target, 'read').mockReturnValue(2);
      throw failure;
    }).toThrow(failure);
    expect(target.read()).toBe(1);
  });

  it('cleans up once in reverse registration order before subsequent assertions', () => {
    const events: string[] = [];
    {
      using _first = createTestDisposable({
        dispose: () => {
          events.push('first');
        },
      });
      using _second = createTestDisposable({
        dispose: () => {
          events.push('second');
        },
      });
      events.push('body');
    }
    expect(events).toEqual(['body', 'second', 'first']);
  });

  it('evaluates the cleanup callback at disposal time with its original receiver', () => {
    const events: string[] = [];
    const target = {
      value: 'old',
      close() {
        events.push(this.value);
      },
    };
    {
      using _resource = createTestDisposable({
        dispose: () => {
          target.close();
        },
      });
      target.value = 'new';
    }
    expect(events).toEqual(['new']);
  });

  it('cleans up before an early return', () => {
    const cleanup = vi.fn(() => {});
    const run = () => {
      using _resource = createTestDisposable({
        dispose: () => {
          cleanup();
        },
      });
      return 42;
    };
    expect(run()).toBe(42);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('waits for asynchronous cleanup before resolving the test operation', async () => {
    const events: string[] = [];
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const operation = (async () => {
      await using _resource = createAsyncTestDisposable({
        dispose: async () => {
          events.push('cleanup-start');
          started.resolve();
          await release.promise;
          events.push('cleanup-end');
        },
      });
      events.push('body');
    })();
    await started.promise;
    // Do not risk leaving the operation suspended if this assertion fails.
    try {
      expect(events).toEqual(['body', 'cleanup-start']);
    } finally {
      release.resolve();
      await operation;
    }
    expect(events).toEqual(['body', 'cleanup-start', 'cleanup-end']);
  });

  it('preserves the body error when synchronous cleanup succeeds', () => {
    const failure = new Error('body');
    const cleaned: boolean[] = [];
    expect(() => {
      using _resource = createTestDisposable({
        dispose: () => {
          cleaned.push(true);
        },
      });
      throw failure;
    }).toThrow(failure);
    expect(cleaned).toEqual([true]);
  });

  it('propagates an asynchronous cleanup failure', async () => {
    const failure = new Error('cleanup');
    await expect((async () => {
      await using _resource = createAsyncTestDisposable({
        dispose: async () => {
          throw failure;
        },
      });
    })()).rejects.toBe(failure);
  });

  it('records both failures rather than asserting try/finally error equivalence', () => {
    const body = new Error('body');
    const cleanup = new Error('cleanup');
    let caught: unknown;
    try {
      using _resource = createTestDisposable({
        dispose: () => {
          throw cleanup;
        },
      });
      throw body;
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'SuppressedError', error: cleanup, suppressed: body });
  });

  it('records asynchronous body and cleanup failures', async () => {
    const body = new Error('body');
    const cleanup = new Error('cleanup');
    await expect((async () => {
      await using _resource = createAsyncTestDisposable({
        dispose: async () => {
          throw cleanup;
        },
      });
      throw body;
    })()).rejects.toMatchObject({ name: 'SuppressedError', error: cleanup, suppressed: body });
  });
});
