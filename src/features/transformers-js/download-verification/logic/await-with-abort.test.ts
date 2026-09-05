import { describe, expect, it, vi } from 'vitest';
import { awaitWithAbort } from '@/features/transformers-js/download-verification/logic/await-with-abort';

describe('awaitWithAbort', () => {
  it('returns the operation result when no signal is provided', async () => {
    await expect(awaitWithAbort({ operation: Promise.resolve('ok') })).resolves.toBe('ok');
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already aborted'));

    await expect(awaitWithAbort({
      operation: new Promise<never>(() => undefined),
      signal: controller.signal,
    })).rejects.toThrow('already aborted');
  });

  it('does not miss an abort that happens before the listener is registered', async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const originalAddEventListener = signal.addEventListener.bind(signal);
    vi.spyOn(signal, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'abort') controller.abort(new Error('registration race'));
      originalAddEventListener(type, listener, options);
    });

    await expect(awaitWithAbort({
      operation: new Promise<never>(() => undefined),
      signal,
    })).rejects.toThrow('registration race');
  });

  it('removes the abort listener when the operation settles first', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');

    await expect(awaitWithAbort({
      operation: Promise.resolve(42),
      signal: controller.signal,
    })).resolves.toBe(42);

    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
