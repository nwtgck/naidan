// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createPipingFetchPool } from './piping-pool';

it('does not release a finite response slot at headers or the final data chunk before EOF', async () => {
  const body = new TransformStream<Uint8Array, Uint8Array>(), writer = body.writable.getWriter();
  const request = vi.fn(async () => new Response(body.readable));
  const pool = createPipingFetchPool({ capacity: 1, request }), signal = new AbortController().signal;
  const first = await pool.request({ input: 'https://relay.invalid/first', init: { signal } });
  const controller = new AbortController();
  const waiting = pool.request({ input: 'https://relay.invalid/second', init: { signal: controller.signal } });
  expect(pool.stats).toEqual({ active: 1, queued: 1, peak: 1 }); expect(request).toHaveBeenCalledOnce();
  const reader = first.body!.getReader(); const writing = writer.write(new Uint8Array([1]));
  expect((await reader.read()).value).toEqual(new Uint8Array([1])); await writing;
  expect(pool.stats.active).toBe(1); expect(request).toHaveBeenCalledOnce();
  controller.abort(new Error('queued canceled')); await expect(waiting).rejects.toThrow('queued canceled');
  expect(pool.stats.queued).toBe(0); expect(pool.stats.active).toBe(1);
  await Promise.all([writer.close(), reader.read()]); reader.releaseLock();
  expect(pool.stats).toEqual({ active: 0, queued: 0, peak: 1 });
});

it('keeps its slot during delayed response cancellation and then starts the next request', async () => {
  const canceled = Promise.withResolvers<void>();
  const request = vi.fn(async () => new Response(null));
  request.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: () => canceled.promise })));
  const pool = createPipingFetchPool({ capacity: 1, request }), signal = new AbortController().signal;
  const response = await pool.request({ input: 'https://relay.invalid/first', init: { signal } });
  const waiting = pool.request({ input: 'https://relay.invalid/second', init: { signal } });
  const canceling = response.body!.cancel(); await Promise.resolve();
  expect(request).toHaveBeenCalledOnce(); expect(pool.stats.active).toBe(1);
  canceled.resolve(); await canceling; await waiting;
  expect(request).toHaveBeenCalledTimes(2); expect(pool.stats.active).toBe(0);
});
