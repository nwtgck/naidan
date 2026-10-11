import { describe, expect, it, vi } from 'vitest';

describe('test-only resource cleanup', () => {
  it('uses native runtime symbols without modifying them', async () => {
    const before = {
      sync: Object.getOwnPropertyDescriptor(Symbol, 'dispose'),
      async: Object.getOwnPropertyDescriptor(Symbol, 'asyncDispose'),
    };
    {
      using _sync = { [Symbol.dispose]() {} };
      await using _async = { async [Symbol.asyncDispose]() {} };
    }
    expect(Object.getOwnPropertyDescriptor(Symbol, 'dispose')).toEqual(before.sync);
    expect(Object.getOwnPropertyDescriptor(Symbol, 'asyncDispose')).toEqual(before.async);
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
      using _first = {
        [Symbol.dispose]() {
          events.push('first');
        },
      };
      using _second = {
        [Symbol.dispose]() {
          events.push('second');
        },
      };
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
      using _resource = {
        [Symbol.dispose]() {
          target.close();
        },
      };
      target.value = 'new';
    }
    expect(events).toEqual(['new']);
  });

  it('cleans up before an early return', () => {
    const cleanup = vi.fn(() => {});
    const run = () => {
      using _resource = {
        [Symbol.dispose]() {
          cleanup();
        },
      };
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
      await using _resource = {
        async [Symbol.asyncDispose]() {
          events.push('cleanup-start');
          started.resolve();
          await release.promise;
          events.push('cleanup-end');
        },
      };
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
      using _resource = {
        [Symbol.dispose]() {
          cleaned.push(true);
        },
      };
      throw failure;
    }).toThrow(failure);
    expect(cleaned).toEqual([true]);
  });

  it('propagates an asynchronous cleanup failure', async () => {
    const failure = new Error('cleanup');
    await expect((async () => {
      await using _resource = {
        async [Symbol.asyncDispose]() {
          throw failure;
        },
      };
    })()).rejects.toBe(failure);
  });

  it('records both failures rather than asserting try/finally error equivalence', () => {
    const body = new Error('body');
    const cleanup = new Error('cleanup');
    let caught: unknown;
    try {
      using _resource = {
        [Symbol.dispose]() {
          throw cleanup;
        },
      };
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
      await using _resource = {
        async [Symbol.asyncDispose]() {
          throw cleanup;
        },
      };
      throw body;
    })()).rejects.toMatchObject({ name: 'SuppressedError', error: cleanup, suppressed: body });
  });

  it('preserves composite cleanup order and stops after the first failure', () => {
    const events: string[] = [];
    const failure = new Error('first cleanup');
    const first = () => {
      events.push('first');
      throw failure;
    };
    expect(() => {
      using _resource = {
        [Symbol.dispose]() {
          first();
          // The original finally block did not execute later cleanup on failure.
          events.push('second');
        },
      };
    }).toThrow(failure);
    expect(events).toEqual(['first']);
  });

  it('keeps nested finally cleanup mandatory when earlier cleanup fails', async () => {
    const events: string[] = [];
    const failure = new Error('first cleanup');
    await expect((async () => {
      await using _resource = {
        async [Symbol.asyncDispose]() {
          try {
            events.push('first');
            throw failure;
          } finally {
            await Promise.resolve();
            events.push('second');
          }
        },
      };
    })()).rejects.toBe(failure);
    expect(events).toEqual(['first', 'second']);
  });

  it('awaits a non-native thenable returned by asynchronous cleanup', async () => {
    const events: string[] = [];
    const failure = new Error('thenable cleanup');
    const thenable: PromiseLike<void> = {
      then(onfulfilled, onrejected) {
        events.push('then');
        return Promise.reject(failure).then(onfulfilled, onrejected);
      },
    };
    await expect((async () => {
      await using _resource = {
        async [Symbol.asyncDispose]() {
          await thenable;
        },
      };
      events.push('body');
    })()).rejects.toBe(failure);
    expect(events).toEqual(['body', 'then']);
  });
});
