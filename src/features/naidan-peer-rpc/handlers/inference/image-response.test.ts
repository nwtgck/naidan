// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { promiseAllKeyed } from '@/utils/promise';
import { collectBytes } from '@/features/naidan-peer-rpc/codecs/transfer';
import { createInferenceBudget } from './budget';
import { createImageResponse } from './image-response';
import type { ImageExecutionOutput } from '@/features/image-generation/execution/types';

function output(): ImageExecutionOutput {
  const bytes = new Uint8Array(33); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer); view.setUint32(8, 13); view.setUint32(12, 0x49484452); view.setUint32(16, 256); view.setUint32(20, 256);
  return { png: new Blob([bytes], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'test', uniformOutput: false };
}
async function collect<T>({ stream }: { stream: ReadableStream<T> }): Promise<T[]> {
  const reader = stream.getReader(); const values: T[] = [];
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) return values; values.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}
function setup({ run }: { run: Parameters<typeof createImageResponse>[0]['run'] }) {
  const budget = createInferenceBudget({ capacity: 80 * 1024 * 1024 }); const lifetime = new AbortController();
  const response = createImageResponse({ signal: lifetime.signal, seed: '42', width: 256, height: 256, budget, run });
  return { budget, lifetime, response };
}
it('produces two concurrently consumed streams with exactly one native job', async () => {
  const run = vi.fn(async () => output()); const { response, budget, lifetime } = setup({ run });
  await Promise.resolve(); expect(run).not.toHaveBeenCalled(); expect(budget.reserved).toBe(0);
  const result = await promiseAllKeyed({ image: collectBytes({ readable: response.image, limit: 100, signal: lifetime.signal }), events: collect({ stream: response.events }) });
  expect(result.image.length).toBe(33); expect(result.events).toEqual([{ type: 'completed', seed: '42', width: 256, height: 256, modelVersion: 'test', uniformOutput: false }]);
  expect(run).toHaveBeenCalledOnce(); expect(budget.reserved).toBe(0);
});
it('does not start when either required output is cancelled before reading', async () => {
  const run = vi.fn(async () => output()); const { response, budget } = setup({ run });
  await response.events.cancel(); await expect(response.image.getReader().read()).rejects.toThrow();
  expect(run).not.toHaveBeenCalled(); expect(budget.reserved).toBe(0);
});
it('holds physical-work reservations while cancellation waits for an uncooperative producer', async () => {
  const gate = Promise.withResolvers<ImageExecutionOutput>(), started = Promise.withResolvers<void>();
  const { response, budget } = setup({
    run: async () => {
      started.resolve(); return gate.promise;
    },
  });
  const reader = response.image.getReader(); const reading = reader.read(); const failed = expect(reading).rejects.toThrow();
  await started.promise;
  let cancelled = false; const cancelling = response.events.cancel().then(() => {
    cancelled = true;
  });
  await failed; await Promise.resolve(); expect(cancelled).toBe(false); expect(budget.reserved).toBeGreaterThan(0);
  gate.resolve(output()); await cancelling; expect(budget.reserved).toBe(0); reader.releaseLock();
});
it('fails both readers on native failure and releases the delivery reservation', async () => {
  const { response, budget } = setup({
    run: async () => {
      throw new Error('Native failure');
    },
  });
  await Promise.all([expect(response.image.getReader().read()).rejects.toMatchObject({ details: { stage: 'generation', reason: 'generation-failed' } }),
    expect(response.events.getReader().read()).rejects.toMatchObject({ details: { stage: 'generation', reason: 'generation-failed' } })]);
  expect(budget.reserved).toBe(0);
});
it('bounds pending previews without blocking native computation behind a slow events reader', async () => {
  const completed = Promise.withResolvers<void>();
  const { response, lifetime, budget } = setup({
    run: async ({ onPreview }) => {
      for (let step = 1; step <= 100; step++) onPreview({ frame: { ...output(), type: 'naidan-image-preview-v1', runId: 1, revision: 0, step, steps: 100, mode: 'projection' } });
      completed.resolve(); return output();
    },
  });
  const image = collectBytes({ readable: response.image, limit: 100, signal: lifetime.signal });
  await completed.promise; await image; expect(budget.reserved).toBeGreaterThan(0);
  const events = await collect({ stream: response.events });
  expect(events.filter(event => event.type === 'preview-start')).toEqual([expect.objectContaining({ step: 100 })]);
  expect(events.at(-1)?.type).toBe('completed');
  // EOF is visible before the underlying pull promise retires.
  await vi.waitFor(() => expect(budget.reserved).toBe(0));
});
it('does not invoke native code when retained deliveries exhausted the shared budget', async () => {
  const budget = createInferenceBudget({ capacity: 40 * 1024 * 1024 }); const lifetime = new AbortController();
  const first = createImageResponse({ signal: lifetime.signal, seed: '1', width: 256, height: 256, budget, run: async () => output() });
  await collectBytes({ readable: first.image, limit: 100, signal: lifetime.signal });
  const run = vi.fn(async () => output());
  const second = createImageResponse({ signal: lifetime.signal, seed: '2', width: 256, height: 256, budget, run });
  await expect(second.image.getReader().read()).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' }); expect(run).not.toHaveBeenCalled();
  await first.events.cancel(); expect(budget.reserved).toBe(0);
});
it('propagates external revocation to both outputs before native work settles', async () => {
  const gate = Promise.withResolvers<ImageExecutionOutput>(), started = Promise.withResolvers<void>();
  const { response, lifetime, budget } = setup({
    run: async () => {
      started.resolve(); return gate.promise;
    },
  });
  const image = response.image.getReader().read(), events = response.events.getReader().read();
  const failures = Promise.all([expect(image).rejects.toThrow('Revoked'), expect(events).rejects.toThrow('Revoked')]);
  await started.promise; lifetime.abort(new Error('Revoked')); await failures;
  expect(budget.reserved).toBeGreaterThan(0); gate.resolve(output());
  await vi.waitFor(() => expect(budget.reserved).toBe(0));
});
it('rejects returned pixels with unexpected dimensions', async () => {
  const { response, budget } = setup({ run: async () => ({ ...output(), width: 512 }) });
  await Promise.all([expect(collect({ stream: response.image })).rejects.toMatchObject({ details: { stage: 'output-validation', reason: 'invalid-output' } }),
    expect(collect({ stream: response.events })).rejects.toMatchObject({ details: { stage: 'output-validation', reason: 'invalid-output' } })]);
  expect(budget.reserved).toBe(0);
});
it('retains delivery ownership while a cancelled preview is still materializing bytes', async () => {
  const materializing = Promise.withResolvers<void>(), bytes = Promise.withResolvers<ArrayBuffer>();
  class SlowPreview extends Blob {
    override arrayBuffer(): Promise<ArrayBuffer> {
      materializing.resolve(); return bytes.promise;
    }
  }
  const sample = output();
  const { response, budget, lifetime } = setup({
    run: async ({ onPreview }) => {
      onPreview({
        frame: {
          ...sample,
          png: new SlowPreview([sample.png], { type: 'image/png' }),
          type: 'naidan-image-preview-v1',
          runId: 1,
          revision: 1,
          step: 1,
          steps: 1,
          mode: 'projection',
        },
      });
      return sample;
    },
  });
  const events = response.events.getReader();
  const reading = events.read().catch(() => undefined);
  await materializing.promise;
  await collectBytes({ readable: response.image, limit: 100, signal: lifetime.signal });
  let retired = false;
  const retiring = events.cancel().then(() => {
    retired = true;
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(retired).toBe(false); expect(budget.reserved).toBeGreaterThan(0);
  } finally {
    bytes.resolve(await sample.png.arrayBuffer()); await reading; await retiring; events.releaseLock();
  }
  expect(budget.reserved).toBe(0);
});
it('external revocation retains the preview reservation until its byte read ends', async () => {
  const materializing = Promise.withResolvers<void>(), bytes = Promise.withResolvers<ArrayBuffer>();
  class SlowPreview extends Blob {
    override arrayBuffer(): Promise<ArrayBuffer> {
      materializing.resolve(); return bytes.promise;
    }
  }
  const sample = output();
  const { response, budget, lifetime } = setup({
    run: async ({ onPreview }) => {
      onPreview({
        frame: {
          ...sample,
          png: new SlowPreview([sample.png], { type: 'image/png' }),
          type: 'naidan-image-preview-v1',
          runId: 1,
          revision: 1,
          step: 1,
          steps: 1,
          mode: 'projection',
        },
      });
      return sample;
    },
  });
  const events = response.events.getReader(); const reading = events.read().catch(() => undefined);
  await materializing.promise;
  await collectBytes({ readable: response.image, limit: 100, signal: lifetime.signal });
  lifetime.abort(new Error('Revoked'));
  try {
    await reading; expect(budget.reserved).toBeGreaterThan(0);
  } finally {
    bytes.resolve(await sample.png.arrayBuffer()); events.releaseLock();
  }
  await vi.waitFor(() => expect(budget.reserved).toBe(0));
});
it('waits for output-reader cancellation cleanup instead of just native completion', async () => {
  const reading = Promise.withResolvers<void>(), cleanup = Promise.withResolvers<void>();
  class SlowCleanup extends Blob {
    override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      return new ReadableStream({
        pull() {
          reading.resolve();
        },
        cancel() {
          return cleanup.promise;
        },
      }, { highWaterMark: 0 });
    }
  }
  const sample = output(); const png = new SlowCleanup([sample.png], { type: 'image/png' });
  const { response, budget } = setup({ run: async () => ({ ...sample, png }) });
  const image = response.image.getReader(); const received = image.read().catch(() => undefined);
  await reading.promise;
  let retired = false; const retiring = response.events.cancel().then(() => {
    retired = true;
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(retired).toBe(false); expect(budget.reserved).toBeGreaterThan(0);
  } finally {
    cleanup.resolve(); await retiring; await received; image.releaseLock();
  }
  expect(budget.reserved).toBe(0);
});
