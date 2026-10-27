// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_ONLY } from './run-q8-diagnostic';
import type { Q8DiagnosticClient, Q8DiagnosticWorkerResult } from './q8-diagnostic-worker-types';

afterEach(() => {
  vi.useRealTimers();
});

describe('Q8 diagnostic ownership before lazy import', () => {
  it.each(['abort', 'timeout'] as const)('releases a pending import on %s and never creates a late Worker', async reason => {
    vi.useFakeTimers();
    const control = new AbortController();
    const pending = Promise.withResolvers<{ createQ8DiagnosticClient(): Q8DiagnosticClient }>();
    const loadClient = vi.fn(() => pending.promise);
    const factory = vi.fn<() => Q8DiagnosticClient>();
    const result = TEST_ONLY.run({ signal: control.signal, timeoutMs: 1000, onProgress: () => {}, loadClient });
    const rejected = expect(result).rejects.toThrow(reason === 'abort' ? 'cancelled' : 'timed out');
    switch (reason) {
    case 'abort': control.abort();
      break;
    case 'timeout': await vi.advanceTimersByTimeAsync(1000);
      break;
    default: {
      const exhaustive: never = reason;
      throw new Error(exhaustive);
    }
    }
    await rejected;
    expect(loadClient).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve({ createQ8DiagnosticClient: factory });
    await Promise.resolve();
    await Promise.resolve();
    expect(factory).not.toHaveBeenCalled();
  });

  it('observes a late import rejection after Stop', async () => {
    const control = new AbortController();
    const pending = Promise.withResolvers<{ createQ8DiagnosticClient(): Q8DiagnosticClient }>();
    const result = TEST_ONLY.run({ signal: control.signal, timeoutMs: 1000, onProgress: () => {}, loadClient: () => pending.promise });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    control.abort();
    await rejected;
    pending.reject(new Error('late chunk failure'));
    await Promise.resolve();
  });

  it('does not import after an already cancelled request', async () => {
    const control = new AbortController();
    control.abort();
    const loadClient = vi.fn<Parameters<typeof TEST_ONLY.run>[0]['loadClient']>();
    await expect(TEST_ONLY.run({ signal: control.signal, timeoutMs: 1000, onProgress: () => {}, loadClient })).rejects.toMatchObject({ name: 'AbortError' });
    expect(loadClient).not.toHaveBeenCalled();
  });

  it('retires an active client before a timed-out call settles', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<Q8DiagnosticWorkerResult>();
    const dispose = vi.fn();
    const client: Q8DiagnosticClient = { run: vi.fn(() => pending.promise), dispose };
    const result = TEST_ONLY.run({ signal: undefined, timeoutMs: 1000, onProgress: () => {}, loadClient: async () => ({ createQ8DiagnosticClient: () => client }) });
    const rejected = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(dispose).toHaveBeenCalledOnce();
    pending.reject(new Error('late native rejection'));
    await Promise.resolve();
  });

  it('disposes the client after a successful unavailable result', async () => {
    const dispose = vi.fn();
    const client: Q8DiagnosticClient = { run: vi.fn<Q8DiagnosticClient['run']>(async () => ({ status: 'unavailable', reason: 'artifact' })), dispose };
    await expect(TEST_ONLY.run({ signal: undefined, timeoutMs: 1000, onProgress: () => {}, loadClient: async () => ({ createQ8DiagnosticClient: () => client }) })).resolves.toEqual({ status: 'unavailable', reason: 'artifact' });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
