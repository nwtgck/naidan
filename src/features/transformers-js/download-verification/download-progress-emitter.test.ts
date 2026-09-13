// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDownloadProgressEmitter } from './download-progress-emitter';
import type { ProgressInfo } from '@/features/transformers-js/types';

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
