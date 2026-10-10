import { describe, expect, it } from 'vitest';
import type { MemoryDiagnostic } from '@/features/llama-cpp-browser/memory-diagnostics';
import { memoryDiagnosticsSchema } from '@/features/llama-cpp-browser/performance/memory-schema';
import { observeMeasurementMemory } from './memory-observation';

const sample: MemoryDiagnostic = { kind: 'naidan-llama-cpp-memory', instanceId: 'core-one', profile: 'cpu-wasm32', checkpoint: 'runtime-ready', capacityBytes: 65536, timestamp: 100 };

describe('request-local memory evidence', () => {
  it('keeps first and last source records, counts truncation, and never sums allocation attempts', () => {
    const worker = Object.assign(new EventTarget(), { postMessage() {} });
    const observer = observeMeasurementMemory({ worker, now: () => 5 });
    for (let i = 0; i < 400; i++) {
      worker.dispatchEvent(new MessageEvent('message', { data: { ...sample, timestamp: i } }));
      observer.record({ diagnostic: { event: 'native-info', nativeMetric: 'kv_buffer_mib', nativeBackend: 'WebGPU', nativeValue: i } });
      observer.record({ diagnostic: { event: 'native-info', nativeMetric: 'graph_splits', nativeValue: i, batchTokens: 512, nativeSingleTokenValue: 2 } });
    }
    const result = observer.finish();
    expect(result.samples).toHaveLength(128); expect(result.nativeAllocations).toHaveLength(128);
    expect(result.droppedSamples).toBe(272); expect(result.droppedNativeAllocations).toBe(272);
    expect(result.nativeSettings).toHaveLength(128); expect(result.droppedNativeSettings).toBe(272);
    expect(result.nativeSettings.at(-1)).toEqual({ observedMs: 5, nativeMetric: 'graph_splits', nativeValue: 399, batchTokens: 512, nativeSingleTokenValue: 2 });
    expect(result.samples[15]?.timestamp).toBe(15); expect(result.samples[16]?.timestamp).toBe(288); expect(result.samples.at(-1)?.timestamp).toBe(399);
    expect(result.nativeAllocations[15]?.nativeValue).toBe(15); expect(result.nativeAllocations.at(-1)?.nativeValue).toBe(399);
    expect(result.nativeAllocations[0]?.observedMs).toBe(5); expect(memoryDiagnosticsSchema.safeParse(result).success).toBe(true);
    worker.dispatchEvent(new MessageEvent('message', { data: sample }));
    observer.record({ diagnostic: { event: 'native-info', nativeMetric: 'kv_buffer_mib', nativeBackend: 'WebGPU', nativeValue: 999 } });
    expect(observer.finish()).toEqual(result); expect(result.droppedSamples).toBe(272);
  });

  it('rejects malformed messages and private fields while preserving unavailable counters', () => {
    const worker = Object.assign(new EventTarget(), { postMessage() {} });
    const observer = observeMeasurementMemory({ worker, now: () => 0 });
    for (const data of [{ ...sample, capacityBytes: -1 }, { ...sample, prompt: 'private' }, { ...sample, gpuRequests: { private: 'device' } }, { ...sample, gpuRequests: { bufferCount: 0, bufferBytes: 0, writeCount: 0, writeBytes: 0, largestWriteBytes: 0, writesAtLeast4MiB: 0, metadata: { adapterInfo: { prompt: 'private' } } } }, { kind: 'other' }]) worker.dispatchEvent(new MessageEvent('message', { data }));
    worker.dispatchEvent(new MessageEvent('message', { data: sample }));
    observer.record({ diagnostic: { event: 'native-info', nativeMetric: 'n_ctx', nativeValue: 512 } });
    const result = observer.finish();
    expect(result.samples).toEqual([sample]); expect(result.samples[0]?.gpuRequests).toBeUndefined(); expect(result.nativeAllocations).toEqual([]); expect(result.nativeSettings).toMatchObject([{ nativeMetric: 'n_ctx', nativeValue: 512 }]);
    expect(memoryDiagnosticsSchema.safeParse({ ...result, nativeAllocations: [{ observedMs: 1, nativeMetric: 'kv_buffer_mib', nativeBackend: 'private-device', nativeValue: 4 }] }).success).toBe(false);
  });

  it('attributes reused worker events only to the active request and preserves GPU request counters verbatim', () => {
    const worker = Object.assign(new EventTarget(), { postMessage() {} });
    const first = observeMeasurementMemory({ worker, now: () => 0 });
    worker.dispatchEvent(new MessageEvent('message', { data: sample }));
    const before = first.finish();
    const second = observeMeasurementMemory({ worker, now: () => 10 });
    const gpuRequests = { bufferCount: 3, bufferBytes: 999, writeCount: 4, writeBytes: 1000, largestWriteBytes: 500, writesAtLeast4MiB: 0 };
    worker.dispatchEvent(new MessageEvent('message', { data: { ...sample, checkpoint: 'generation-cleaned', gpuRequests } }));
    const after = second.finish();
    expect(before.samples).toEqual([sample]); expect(after.samples).toHaveLength(1);
    expect(after.samples[0]?.gpuRequests).toEqual(gpuRequests); expect(after.samples[0]?.checkpoint).toBe('generation-cleaned');
  });
});
