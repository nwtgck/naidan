// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDownloadProgressEmitter } from './download-progress-emitter';
import type { ProgressInfo } from '@/features/transformers-js/types';
import { createDownloadEtaEstimator } from '@/features/transformers-js/download-eta';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

// These scalar/fake-clock controls prove the emitter's scheduling policy, not
// native browser timing. The adjacent real Comlink tests cover writer isolation.
it('coalesces many samples to the latest value at 150 ms even when the observer acknowledges immediately', async () => {
  const received: ProgressInfo[] = [];
  const emitter = createDownloadProgressEmitter({ callback: ({ info }) => {
    received.push(info);
  } });
  try {
    emitter.publish({ info: { status: 'progress', file: 'model.onnx', loaded: 1, total: 100 } });
    await vi.advanceTimersByTimeAsync(0);
    for (let loaded = 2; loaded <= 100; loaded++) {
      emitter.publish({ info: { status: 'progress', file: 'model.onnx', loaded, total: 100 } });
      // Each attempted publication has a chance to finish a fast callback; the
      // one-in-flight guard alone cannot explain the bounded notification count.
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(received).toEqual([{ status: 'progress', file: 'model.onnx', loaded: 1, total: 100 }]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(149);
    expect(received).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toEqual([
      { status: 'progress', file: 'model.onnx', loaded: 1, total: 100 },
      { status: 'progress', file: 'model.onnx', loaded: 100, total: 100 },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    emitter.close();
  }
});

it('removes the pending throttle timer on close and never publishes a buffered or later sample', async () => {
  const received: ProgressInfo[] = [];
  const emitter = createDownloadProgressEmitter({ callback: ({ info }) => {
    received.push(info);
  } });
  try {
    emitter.publish({ info: { status: 'progress', file: 'model.onnx', loaded: 1 } });
    await vi.advanceTimersByTimeAsync(0);
    emitter.publish({ info: { status: 'progress', file: 'model.onnx', loaded: 2 } });
    expect(vi.getTimerCount()).toBe(1);
    emitter.close();
    expect(vi.getTimerCount()).toBe(0);
    emitter.publish({ info: { status: 'done', file: 'model.onnx', loaded: 3, total: 3 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toEqual([{ status: 'progress', file: 'model.onnx', loaded: 1 }]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    emitter.close();
  }
});

it('does not rearm or deliver buffered files after an observer acknowledges a closed emitter', async () => {
  const held = Promise.withResolvers<void>();
  const received: ProgressInfo[] = [];
  const emitter = createDownloadProgressEmitter({ callback: ({ info }) => {
    received.push(info);
    return held.promise;
  } });
  try {
    emitter.publish({ info: { status: 'progress', file: 'first.onnx', loaded: 1 } });
    await vi.advanceTimersByTimeAsync(0);
    emitter.publish({ info: { status: 'progress', file: 'second.onnx', loaded: 2 } });
    emitter.close();
    expect(vi.getTimerCount()).toBe(0);
    held.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual([{ status: 'progress', file: 'first.onnx', loaded: 1 }]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    emitter.close();
    held.resolve();
  }
});

it('preserves cumulative source-clock throughput when held acknowledgement coalesces hundreds of samples', async () => {
  const held = Promise.withResolvers<void>();
  let arrival = 0;
  const eta = createDownloadEtaEstimator({ now: () => arrival });
  const received: ProgressInfo[] = [];
  const emitter = createDownloadProgressEmitter({ callback: ({ info }) => {
    received.push(info); eta.observe({ info }); return held.promise;
  } });
  try {
    emitter.publish({ info: { status: 'download', file: 'a', loaded: 0, downloadTiming: { clockId: 'worker', requestId: 1, sequence: 1, observedAtMs: 50_000 } } });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 1; i <= 400; i++) emitter.publish({ info: { status: 'progress', file: 'a', loaded: i, downloadTiming: { clockId: 'worker', requestId: 1, sequence: i + 1, observedAtMs: 50_000 + i * 10 } } });
    expect(received).toHaveLength(1);
    arrival = 150; held.resolve(); await vi.advanceTimersByTimeAsync(150);
    expect(received).toHaveLength(2);
    expect(received[1]?.downloadTiming).toEqual({ clockId: 'worker', requestId: 1, sequence: 401, observedAtMs: 54_000 });
    expect(eta.snapshot({ remainingBytes: 600, active: true })).toEqual({ status: 'estimating', remainingSeconds: 6, bytesPerSecond: 100 });
  } finally {
    emitter.close(); held.resolve();
  }
});

it('keeps disabled timing on a terminal that replaces the failed sample while acknowledgement is held', async () => {
  const acknowledgement = Promise.withResolvers<void>();
  const eta = createDownloadEtaEstimator({ now: () => 0 });
  eta.observe({ info: { status: 'download', loaded: 0, downloadTiming: { clockId: 'source', requestId: 1, sequence: 1, observedAtMs: 0 } } });
  const received: ProgressInfo[] = [];
  const emitter = createDownloadProgressEmitter({ callback: ({ info }) => {
    received.push(info); eta.observe({ info }); return acknowledgement.promise;
  } });
  try {
    emitter.publish({ info: { status: 'progress', file: 'a', loaded: 300, downloadTiming: { clockId: 'source', requestId: 1, sequence: 2, observedAtMs: 3000 } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(eta.snapshot({ remainingBytes: 300, active: true }).status).toBe('estimating');
    emitter.publish({ info: { status: 'progress', file: 'a', loaded: 301, downloadTiming: 'unavailable' } });
    emitter.publish({ info: { status: 'done', file: 'a', loaded: 400, downloadTiming: 'unavailable' } });
    expect(received).toHaveLength(1);
    acknowledgement.resolve(); await vi.advanceTimersByTimeAsync(150);
    expect(received.at(-1)).toMatchObject({ status: 'done', loaded: 400, downloadTiming: 'unavailable' });
    expect(eta.snapshot({ remainingBytes: 200, active: true })).toEqual({ status: 'unavailable' });
  } finally {
    emitter.close(); acknowledgement.resolve();
  }
});
