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

describe('request-local Flash Attention evidence', () => {
  it('retains failed-attempt resolution separately and never carries it into a successful retry', () => {
    const worker = Object.assign(new EventTarget(), { postMessage() {} });
    const observer = observeMeasurementMemory({ worker, now: () => 7 });
    observer.record({ diagnostic: { event: 'context-start' } });
    observer.record({ diagnostic: { event: 'native-info', nativeFlashAttention: { kind: 'requested', mode: 'auto' } } });
    observer.record({ diagnostic: { event: 'native-info', nativeFlashAttention: { kind: 'resolved', mode: 'enabled' } } });
    observer.record({ diagnostic: { event: 'context-retry', contextTokens: 4096, batchTokens: 128 } });
    observer.record({ diagnostic: { event: 'native-info', nativeFlashAttention: { kind: 'requested', mode: 'auto' } } });
    observer.record({ diagnostic: { event: 'context-ready', contextTokens: 4096, batchTokens: 128 } });
    observer.record({ diagnostic: { event: 'native-info', nativeFlashAttention: { kind: 'resolved', mode: 'disabled' } } });
    const result = observer.finish();
    expect(result.nativeSettings).toEqual([
      { observedMs: 7, contextAttempt: 1, contextEvent: 'context-start' },
      { observedMs: 7, contextAttempt: 1, nativeFlashAttention: { kind: 'requested', mode: 'auto' } },
      { observedMs: 7, contextAttempt: 1, nativeFlashAttention: { kind: 'resolved', mode: 'enabled' } },
      { observedMs: 7, contextAttempt: 2, contextEvent: 'context-retry', contextTokens: 4096, batchTokens: 128 },
      { observedMs: 7, contextAttempt: 2, nativeFlashAttention: { kind: 'requested', mode: 'auto' } },
      { observedMs: 7, contextAttempt: 2, contextEvent: 'context-ready', contextTokens: 4096, batchTokens: 128 },
      { observedMs: 7, nativeFlashAttention: { kind: 'resolved', mode: 'disabled' } },
    ]);
    expect(memoryDiagnosticsSchema.safeParse(result).success).toBe(true);
    observer.record({ diagnostic: { event: 'context-start' } });
    expect(observer.finish()).toEqual(result);
  });

  it('preserves incomplete attempts and keeps a reused request unassociated without new boundaries', () => {
    const worker = Object.assign(new EventTarget(), { postMessage() {} });
    const first = observeMeasurementMemory({ worker, now: () => 1 });
    first.record({ diagnostic: { event: 'context-start' } });
    first.record({ diagnostic: { event: 'native-info', nativeFlashAttention: { kind: 'resolved', mode: 'enabled' } } });
    const failed = first.finish();
    const second = observeMeasurementMemory({ worker, now: () => 2 });
    second.record({ diagnostic: { event: 'native-info', nativeFlashAttention: { kind: 'requested', mode: 'enabled' } } });
    second.record({ diagnostic: { event: 'context-ready' } });
    expect(failed.nativeSettings).toHaveLength(2);
    expect(second.finish().nativeSettings).toEqual([
      { observedMs: 2, nativeFlashAttention: { kind: 'requested', mode: 'enabled' } },
      { observedMs: 2, contextEvent: 'context-ready' },
    ]);
  });

  it('uses the existing bounded settings history and copies rather than retaining mutable diagnostics', () => {
    const worker = Object.assign(new EventTarget(), { postMessage() {} });
    const observer = observeMeasurementMemory({ worker, now: () => 0 });
    const nativeFlashAttention: { kind: 'resolved', mode: 'enabled' | 'disabled' } = { kind: 'resolved', mode: 'enabled' };
    observer.record({ diagnostic: { event: 'native-info', nativeFlashAttention } });
    for (let i = 0; i < 200; i++) observer.record({ diagnostic: { event: 'context-start' } });
    const result = observer.finish();
    expect(result.nativeSettings).toHaveLength(128); expect(result.droppedNativeSettings).toBe(73);
    nativeFlashAttention.mode = 'disabled';
    expect(result.nativeSettings[0]).toEqual({ observedMs: 0, nativeFlashAttention: { kind: 'resolved', mode: 'enabled' } });
    expect('nativeFlashAttention' in result.nativeSettings[0]! && result.nativeSettings[0].nativeFlashAttention).not.toBe(nativeFlashAttention);
    expect(result.nativeSettings.at(-1)).toEqual({ observedMs: 0, contextAttempt: 200, contextEvent: 'context-start' });
    expect(memoryDiagnosticsSchema.safeParse({ ...result, nativeSettings: [{ observedMs: 0, contextAttempt: 0, contextEvent: 'context-ready' }] }).success).toBe(false);
    expect(memoryDiagnosticsSchema.safeParse({ ...result, nativeSettings: [{ observedMs: 0, nativeFlashAttention: { kind: 'resolved', mode: 'auto' } }] }).success).toBe(false);
  });
});

it('copies loaded descriptors and retains bounded request-local history', () => {
  const worker = Object.assign(new EventTarget(), { postMessage() {} });
  const observer = observeMeasurementMemory({ worker, now: () => 1 });
  const descriptor = { source: 'loaded-model-native-api' as const, layers: 64, parameterCount: '9007199254740993' };
  for (let i = 0; i < 400; i++) observer.record({ diagnostic: { event: 'native-info', loadedModelDescriptor: descriptor } });
  descriptor.layers = 32;
  const result = observer.finish();
  expect(result.nativeSettings).toHaveLength(128); expect(result.droppedNativeSettings).toBe(272);
  expect(result.nativeSettings[0]).toEqual({ observedMs: 1, loadedModelDescriptor: { ...descriptor, layers: 64 } });
  expect(memoryDiagnosticsSchema.safeParse(JSON.parse(JSON.stringify(result))).success).toBe(true);
  observer.record({ diagnostic: { event: 'native-info', loadedModelDescriptor: descriptor } });
  expect(result.droppedNativeSettings).toBe(272);
  const next = observeMeasurementMemory({ worker, now: () => 0 });
  expect(next.finish().nativeSettings).toEqual([]);
});

it('validates notification payloads, snapshots attributes, and removes both subscriptions on finish', () => {
  const worker = Object.assign(new EventTarget(), { postMessage() {} });
  const observer = observeMeasurementMemory({ worker, now: () => 3 });
  const descriptor = { source: 'loaded-model-native-api' as const, layers: 64 };
  for (const data of [
    { event: 'context-start', contextTokens: -1 },
    { event: 'native-info', loadedModelDescriptor: { ...descriptor, prompt: 'private' } },
    { event: 'native-info', nativeFlashAttention: { kind: 'resolved', mode: 'auto' } },
    { event: 'native-info', nativeMetric: 'n_ctx', nativeValue: 512, private: 'private' },
  ]) worker.dispatchEvent(new MessageEvent('message', { data }));
  worker.dispatchEvent(new MessageEvent('message', { data: { event: 'native-info', loadedModelDescriptor: descriptor } }));
  descriptor.layers = 32;
  const observed = observer.finish();
  expect(observed.nativeSettings).toEqual([{ observedMs: 3, loadedModelDescriptor: { source: 'loaded-model-native-api', layers: 64 } }]);
  // A forcibly retired request cannot recover notifications still queued at
  // retirement. Late messages must not mutate its already captured history.
  worker.dispatchEvent(new MessageEvent('message', { data: { event: 'context-start' } }));
  worker.dispatchEvent(new MessageEvent('message', { data: sample }));
  expect(observer.finish()).toEqual(observed);
  expect(observed.nativeSettings).toHaveLength(1); expect(observed.samples).toEqual([]);
  const next = observeMeasurementMemory({ worker, now: () => 4 });
  expect(next.finish().nativeSettings).toEqual([]);
});

it.each([false, true])('collects ordered settings before the same-endpoint RPC settles (failure=%s)', async fail => {
  const { MessageChannel } = await import('node:worker_threads');
  const { diagnosticSchema } = await import('@/features/llama-cpp-browser/debug-log');
  const { exposeWorkerRemote, wrapWorkerRemote, releaseWorkerRemote, postWorkerNotification } = await import('@/utils/worker-transport');
  const { port1, port2 } = new MessageChannel();
  const server = port1 as unknown as Worker; const client = port2 as unknown as Worker;
  type Api = { complete({ fail }: { fail: boolean }): Promise<void> };
  exposeWorkerRemote<Api>({
    endpoint: server,
    api: {
      async complete({ fail }) {
        for (const diagnostic of [
          { event: 'native-info', loadedModelDescriptor: { source: 'loaded-model-native-api', layers: 64 } },
          { event: 'context-start' },
          { event: 'native-info', nativeMetric: 'n_ctx', nativeValue: 512 },
          { event: 'native-info', nativeFlashAttention: { kind: 'requested', mode: 'auto' } },
          { event: 'native-info', nativeFlashAttention: { kind: 'resolved', mode: 'enabled' } },
          { event: 'context-ready' },
        ] as const) postWorkerNotification({ endpoint: server, schema: diagnosticSchema, value: diagnostic });
        if (fail) throw new Error('initialization failed');
      },
    },
  });
  const observer = observeMeasurementMemory({ worker: client, now: () => 2 });
  const remote = wrapWorkerRemote<Api>({ endpoint: client });
  try {
    if (fail) await expect(remote.complete({ fail })).rejects.toThrow('initialization failed');
    else await remote.complete({ fail });
    expect(observer.finish().nativeSettings).toEqual([
      { observedMs: 2, loadedModelDescriptor: { source: 'loaded-model-native-api', layers: 64 } },
      { observedMs: 2, contextAttempt: 1, contextEvent: 'context-start' },
      { observedMs: 2, nativeMetric: 'n_ctx', nativeValue: 512 },
      { observedMs: 2, contextAttempt: 1, nativeFlashAttention: { kind: 'requested', mode: 'auto' } },
      { observedMs: 2, contextAttempt: 1, nativeFlashAttention: { kind: 'resolved', mode: 'enabled' } },
      { observedMs: 2, contextAttempt: 1, contextEvent: 'context-ready' },
    ]);
  } finally {
    observer.finish(); releaseWorkerRemote({ remote }); port1.close(); port2.close();
  }
});
