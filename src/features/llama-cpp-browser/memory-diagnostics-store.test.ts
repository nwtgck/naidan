import { beforeEach, describe, expect, it } from 'vitest';
import { memoryDiagnosticsHistories, observeWorkerMemory, TEST_ONLY } from './memory-diagnostics-store';
import type { MemoryDiagnostic } from './memory-diagnostics';
const sample: MemoryDiagnostic = { kind: 'naidan-llama-cpp-memory', instanceId: 'runtime-one', profile: 'cpu-wasm64', checkpoint: 'runtime-ready', capacityBytes: 65536, timestamp: 1000 };

beforeEach(() => TEST_ONLY.reset());

describe('worker memory history', () => {
  it('validates messages, collects without a panel, and preserves samples after disposal', () => {
    const worker = Object.assign(new EventTarget(), { postMessage() {} });
    const stop = observeWorkerMemory({ worker });
    worker.dispatchEvent(new MessageEvent('message', { data: { ...sample, capacityBytes: -1 } }));
    worker.dispatchEvent(new MessageEvent('message', { data: { type: 'RAW', value: 1 } }));
    expect(memoryDiagnosticsHistories.value).toEqual([]);
    worker.dispatchEvent(new MessageEvent('message', { data: sample }));
    worker.dispatchEvent(new MessageEvent('message', { data: { ...sample, checkpoint: 'model-released', capacityBytes: 2 ** 33 } }));
    expect(memoryDiagnosticsHistories.value[0]?.observedMaximumBytes).toBe(2 ** 33);
    stop(); stop();
    worker.dispatchEvent(new MessageEvent('message', { data: { ...sample, capacityBytes: 0 } }));
    expect(memoryDiagnosticsHistories.value[0]?.status).toBe('worker-ended');
    expect(memoryDiagnosticsHistories.value[0]?.samples).toHaveLength(2);
  });

  it('keeps the latest model-load baseline independently of retained checkpoints', () => {
    const worker = Object.assign(new EventTarget(), { postMessage() {} });
    const stop = observeWorkerMemory({ worker });
    for (const capacityBytes of [65536, 131072]) {
      worker.dispatchEvent(new MessageEvent('message', { data: { ...sample, checkpoint: 'before-model-load', capacityBytes } }));
    }
    for (let i = 0; i < 400; i++) worker.dispatchEvent(new MessageEvent('message', { data: { ...sample, checkpoint: 'decode', capacityBytes: 262144 } }));
    expect(memoryDiagnosticsHistories.value[0]?.latestLoad).toEqual({ ordinal: 2, baselineBytes: 131072 });
    stop();
  });

  it('bounds history while retaining startup samples and lifetime observed maximum', () => {
    const worker = Object.assign(new EventTarget(), { postMessage() {} }); const stop = observeWorkerMemory({ worker });
    for (let i = 0; i < 400; i++) worker.dispatchEvent(new MessageEvent('message', { data: { ...sample, checkpoint: i === 0 ? 'runtime-ready' : 'decode', timestamp: i, capacityBytes: i === 1 ? 1000000 : 65536 } }));
    const history = memoryDiagnosticsHistories.value[0]!;
    expect(history.samples).toHaveLength(128);
    expect(history.samples[0]?.checkpoint).toBe('runtime-ready');
    expect(history.samples.at(-1)?.timestamp).toBe(399);
    expect(history.observedMaximumBytes).toBe(1000000);
    for (let i = 0; i < 20; i++) worker.dispatchEvent(new MessageEvent('message', { data: { ...sample, instanceId: `runtime-${i}` } }));
    expect(memoryDiagnosticsHistories.value).toHaveLength(8); stop();
  });
});

it('receives real MessagePort notifications alongside Comlink requests without acknowledgements', async () => {
  const { MessageChannel } = await import('node:worker_threads');
  const { exposeWorkerRemote, wrapWorkerRemote, releaseWorkerRemote, postWorkerNotification } = await import('@/utils/worker-transport');
  const { memoryDiagnosticSchema } = await import('./memory-diagnostics');
  const { port1, port2 } = new MessageChannel();
  const server = port1 as unknown as Worker;
  const client = port2 as unknown as Worker;
  type Api = { ping(): Promise<number> };
  exposeWorkerRemote<Api>({
    api: {
      async ping() {
        postWorkerNotification({ endpoint: server, schema: memoryDiagnosticSchema, value: sample });
        return 42;
      },
    },
    endpoint: server,
  });
  const stop = observeWorkerMemory({ worker: client });
  const remote = wrapWorkerRemote<Api>({ endpoint: client });
  try {
    expect(await remote.ping()).toBe(42);
    expect(await remote.ping()).toBe(42);
    expect(memoryDiagnosticsHistories.value[0]?.samples).toHaveLength(2);
  } finally {
    stop(); releaseWorkerRemote({ remote }); port1.close(); port2.close();
  }
});
