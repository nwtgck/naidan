import { associateGpuRequests, createGpuRequestObserver } from './webgpu-request-diagnostics';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginMemoryDiagnostics, sampleMemoryDiagnostics, subscribeMemoryDiagnostics } from './memory-diagnostics';
import type { MemoryDiagnostic } from '@/features/llama-cpp-browser/memory-diagnostics';

afterEach(() => vi.useRealTimers());

describe('passive Wasm memory checkpoints', () => {
  it('reads the current heap after growth and preserves the runtime identity', () => {
    const core = { module: { HEAPU8: new Uint8Array(65536) } };
    const samples: MemoryDiagnostic[] = [];
    const stop = subscribeMemoryDiagnostics({ listener: ({ diagnostic }) => samples.push(diagnostic) });
    beginMemoryDiagnostics({ core, profile: 'cpu-wasm64' });
    core.module.HEAPU8 = new Uint8Array(131072);
    sampleMemoryDiagnostics({ core, checkpoint: 'model-loaded' });
    sampleMemoryDiagnostics({ core, checkpoint: 'model-released' });
    sampleMemoryDiagnostics({ core, checkpoint: 'runtime-released' });
    sampleMemoryDiagnostics({ core, checkpoint: 'decode' });
    stop();
    expect(samples.map(sample => sample.capacityBytes)).toEqual([65536, 131072, 131072, 131072]);
    expect(new Set(samples.map(sample => sample.instanceId)).size).toBe(1);
  });

  it('throttles decode samples without hiding phase boundaries or observer failures', () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const core = { module: { HEAPU8: new Uint8Array(65536) } };
    const listener = vi.fn();
    const stopThrowing = subscribeMemoryDiagnostics({
      listener: () => {
        throw new Error('observer');
      },
    });
    const stop = subscribeMemoryDiagnostics({ listener });
    beginMemoryDiagnostics({ core, profile: 'cpu-wasm32' });
    for (let i = 0; i < 100; i++) sampleMemoryDiagnostics({ core, checkpoint: 'decode' });
    sampleMemoryDiagnostics({ core, checkpoint: 'prefill-complete' });
    vi.advanceTimersByTime(1000);
    sampleMemoryDiagnostics({ core, checkpoint: 'decode' });
    expect(listener).toHaveBeenCalledTimes(4);
    stop(); stopThrowing();
  });
});

it('includes GPU request snapshots in the same phase, timestamp and runtime identity', () => {
  const core = { module: { HEAPU8: new Uint8Array(65536) } };
  const observer = createGpuRequestObserver();
  const device = observer.wrapDevice({ device: { queue: {}, createBuffer: ({ size }: GPUBufferDescriptor) => ({ size }) } as unknown as GPUDevice });
  associateGpuRequests({ core, snapshot: observer.snapshot });
  const samples: MemoryDiagnostic[] = [];
  const stop = subscribeMemoryDiagnostics({ listener: ({ diagnostic }) => samples.push(diagnostic) });
  beginMemoryDiagnostics({ core, profile: 'webgpu-wasm64-jspi' });
  device.createBuffer({ size: 100, usage: 0 });
  sampleMemoryDiagnostics({ core, checkpoint: 'model-loaded' });
  stop();
  expect(samples[0]!.gpuRequests!.bufferBytes).toBe(0);
  expect(samples[1]!.gpuRequests!.bufferBytes).toBe(100);
  expect(samples[1]!.instanceId).toBe(samples[0]!.instanceId);
  expect(samples[1]!.checkpoint).toBe('model-loaded');
});
