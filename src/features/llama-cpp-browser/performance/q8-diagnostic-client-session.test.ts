// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRemote } from '@/utils/worker-transport';
import { createQ8DiagnosticClientSession } from './q8-diagnostic-client-session';
import type { Q8DiagnosticClient, Q8DiagnosticWorkerApi, Q8DiagnosticWorkerResult } from './q8-diagnostic-worker-types';

const request = { assetBaseURL: 'https://fixture.invalid/profiles/', schemaAssetSha256: 'a'.repeat(64) };
const unavailable = { status: 'unavailable', reason: 'native-exports' } as const;
const progress = { shapeIndex: 0, shapeCount: 8, phase: 'preparing', completedSamples: 0, totalSamples: 192 } as const;

function setup() {
  const worker = Object.assign(new EventTarget(), { postMessage: vi.fn() });
  const pending = Promise.withResolvers<Q8DiagnosticWorkerResult>();
  const run = vi.fn<Q8DiagnosticWorkerApi['run']>(() => pending.promise);
  const disposeTransport = vi.fn();
  const client = createQ8DiagnosticClientSession({ worker, remote: { run } as unknown as WorkerRemote<Q8DiagnosticWorkerApi>, disposeTransport, request });
  const onProgress = vi.fn<Parameters<Q8DiagnosticClient['run']>[0]['onProgress']>();
  return { worker, pending, run, disposeTransport, client, onProgress };
}

afterEach(() => vi.useRealTimers());

describe('dedicated Q8 diagnostic Worker lifetime', () => {
  it('validates progress, returns the result and unconditionally retires the Worker', async () => {
    const test = setup();
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        test.client.dispose();
      },
    };
    const result = test.client.run({ signal: undefined, timeoutMs: 1000, onProgress: test.onProgress });
    test.worker.dispatchEvent(new MessageEvent('message', { data: { kind: 'naidan-q8-kernel-progress', progress } }));
    test.worker.dispatchEvent(new MessageEvent('message', { data: { kind: 'naidan-q8-kernel-progress', progress: { ...progress, shapeIndex: 999 } } }));
    test.pending.resolve(unavailable);
    await expect(result).resolves.toEqual(unavailable);
    expect(test.run).toHaveBeenCalledExactlyOnceWith({ request });
    expect(test.onProgress).toHaveBeenCalledExactlyOnceWith({ progress });
    expect(test.disposeTransport).toHaveBeenCalledOnce();
    test.worker.dispatchEvent(new MessageEvent('message', { data: { kind: 'naidan-q8-kernel-progress', progress } }));
    expect(test.onProgress).toHaveBeenCalledOnce();
    await expect(test.client.run({ signal: undefined, timeoutMs: 1000, onProgress: test.onProgress })).rejects.toThrow('already been used');
  });

  it('terminates before settling an abort without waiting for native execution', async () => {
    const test = setup();
    using _cleanup = {
      [Symbol.dispose]() {
        test.client.dispose();
      },
    };
    const control = new AbortController();
    const result = test.client.run({ signal: control.signal, timeoutMs: 1000, onProgress: test.onProgress });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    expect(test.run).toHaveBeenCalledOnce();
    control.abort();
    expect(test.disposeTransport).toHaveBeenCalledOnce();
    await rejected;
    // A transport rejection arriving after termination is still observed.
    test.pending.reject(new Error('late native rejection'));
    await Promise.resolve();
    expect(test.disposeTransport).toHaveBeenCalledOnce();
  });

  it('honors an already aborted signal before invoking the remote method', async () => {
    const test = setup();
    const control = new AbortController();
    control.abort();
    await expect(test.client.run({ signal: control.signal, timeoutMs: 1000, onProgress: test.onProgress })).rejects.toMatchObject({ name: 'AbortError' });
    expect(test.run).not.toHaveBeenCalled();
    expect(test.disposeTransport).toHaveBeenCalledOnce();
  });

  it.each(['error', 'messageerror', 'dispose', 'timeout'] as const)('retires a suspended Worker after %s', async reason => {
    vi.useFakeTimers();
    const test = setup();
    using _cleanup = {
      [Symbol.dispose]() {
        test.client.dispose();
      },
    };
    const result = test.client.run({ signal: undefined, timeoutMs: 1000, onProgress: test.onProgress });
    const rejected = expect(result).rejects.toThrow();
    await Promise.resolve();
    switch (reason) {
    case 'error': case 'messageerror': test.worker.dispatchEvent(new Event(reason));
      break;
    case 'dispose': test.client.dispose();
      break;
    case 'timeout': await vi.advanceTimersByTimeAsync(1000);
      break;
    default: {
      const exhaustive: never = reason;
      throw new Error(exhaustive);
    }
    }
    await rejected;
    expect(test.disposeTransport).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects malformed responses and still retires the Worker', async () => {
    const test = setup();
    const result = test.client.run({ signal: undefined, timeoutMs: 1000, onProgress: test.onProgress });
    test.pending.resolve({ status: 'completed', benchmark: {} } as never);
    await expect(result).rejects.toThrow();
    expect(test.disposeTransport).toHaveBeenCalledOnce();
  });

  it('does not publish a completed response after cancellation retires its session', async () => {
    const test = setup();
    const control = new AbortController();
    const result = test.client.run({ signal: control.signal, timeoutMs: 1000, onProgress: test.onProgress });
    test.pending.resolve(unavailable);
    control.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(test.disposeTransport).toHaveBeenCalledOnce();
  });

  it('rejects a stale asset identity even when the response schema is valid', async () => {
    const test = setup();
    const result = test.client.run({ signal: undefined, timeoutMs: 1000, onProgress: test.onProgress });
    test.pending.resolve({
      status: 'completed',
      schemaAssetSha256: 'b'.repeat(64),
      compiledSchemaSha256: 'c'.repeat(64),
      setupWallMs: 1,
      benchmark: { version: 1, fixtureId: 'q8-dyadic-v1', status: 'cancelled', repetitions: 32, rounds: 4, shapes: [] },
    });
    await expect(result).rejects.toThrow('asset identity mismatch');
    expect(test.disposeTransport).toHaveBeenCalledOnce();
  });

  it('releases the Worker after local validation fails without starting native work', async () => {
    const test = setup();
    await expect(test.client.run({ signal: undefined, timeoutMs: 0, onProgress: test.onProgress })).rejects.toThrow('timeout');
    expect(test.run).not.toHaveBeenCalled();
    expect(test.disposeTransport).toHaveBeenCalledOnce();
  });
});
