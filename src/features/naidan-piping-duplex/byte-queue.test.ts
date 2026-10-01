// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { ByteQueue } from '@/features/naidan-piping-duplex/byte-queue';
import { Pulse, ownBytes, fields, ascii, bitSet, bitHas } from '@/features/naidan-piping-duplex/bytes';
import { pattern, useOfflineScope } from '@/features/naidan-piping-duplex/test-support';

useOfflineScope();

it('immutable queue snapshots and returned buffers never alias caller data', () => {
  const input = pattern({ size: 5000, seed: 31 });
  const empty = ByteQueue.empty(), first = empty.append({ bytes: input });
  const second = first.append({ bytes: new Uint8Array([73]) });
  input.fill(0);
  const page = second.take();
  expect(page).toBeDefined();
  page!.bytes.fill(0);
  expect(empty.length).toBe(0);
  expect(first.length).toBe(5000);
  expect(second.length).toBe(5001);
  expect(first.take()?.bytes).toEqual(pattern({ size: 5000, seed: 31 }).subarray(0, 4096));
  expect(second.take()?.bytes).toEqual(first.take()?.bytes);
});

it('one-byte arrivals have a bounded page count rather than a retained object per arrival', () => {
  let queue = ByteQueue.empty();
  for (let index = 0; index < 65536; index++) queue = queue.append({ bytes: new Uint8Array([index & 255]) });
  expect(queue.length).toBe(65536);
  expect(queue.pageCount).toBe(16);
  expect(() => queue.append({ bytes: new Uint8Array([1]) })).toThrow('capacity');
  let offset = 0;
  for (;;) {
    const item = queue.take();
    if (!item) break;
    expect(item.bytes.length).toBe(4096);
    expect(item.bytes).toEqual(Uint8Array.from({ length: 4096 }, (_, index) => (offset + index) & 255));
    queue = item.remaining; offset += item.bytes.length;
  }
  expect(offset).toBe(65536);
  expect(queue.length).toBe(0);
  expect(queue.pageCount).toBe(0);
});

it('append and take agree with an independent byte-array model through fragmentation', () => {
  let queue = ByteQueue.empty();
  const expected: number[] = [];
  for (let step = 0; step < 600; step++) {
    const bytes = pattern({ size: (step * 137) % 6000, seed: step + 1 });
    if (expected.length + bytes.length <= 65536) {
      queue = queue.append({ bytes }); expected.push(...bytes);
    }
    if (step % 3 !== 0) {
      const result = queue.take();
      if (result) {
        expect([...result.bytes]).toEqual(expected.splice(0, result.bytes.length));
        queue = result.remaining;
      }
    }
    expect(queue.length).toBe(expected.length);
    expect(queue.pageCount).toBeLessThanOrEqual(16);
  }
  const received: number[] = [];
  while (queue.length) {
    const item = queue.take()!; received.push(...item.bytes); queue = item.remaining;
  }
  expect(received).toEqual(expected);
});

it('owned bytes reject shared and detached inputs and copy a subarray without its neighbours', () => {
  const input = new Uint8Array([1, 2, 3, 4]);
  const copy = ownBytes({ bytes: input.subarray(1, 3), maxBytes: 2 });
  input.fill(9);
  expect(copy).toEqual(new Uint8Array([2, 3]));
  expect(copy.buffer.byteLength).toBe(2);
  expect(() => ownBytes({ bytes: new Uint8Array(new SharedArrayBuffer(2)), maxBytes: 2 })).toThrow('non-shared');
  expect(() => ownBytes({ bytes: input, maxBytes: 3 })).toThrow('limit');
  const detached = new Uint8Array([1]); structuredClone(detached.buffer, { transfer: [detached.buffer] });
  expect(() => ownBytes({ bytes: detached, maxBytes: 3 })).toThrow();
});

it('length-delimited fields distinguish concatenation aliases and enforce their bounds', () => {
  expect(fields({ parts: [new Uint8Array([1]), new Uint8Array([2, 3])] })).not.toEqual(
    fields({ parts: [new Uint8Array([1, 2]), new Uint8Array([3])] }));
  expect(fields({ parts: [] })).toEqual(new Uint8Array([0, 0]));
  expect(() => fields({ parts: [new Uint8Array(65536)] })).toThrow('limit');
  expect(() => fields({ parts: Array.from({ length: 65536 }, () => new Uint8Array()) })).toThrow('limit');
  for (const text of ['\ud800', 'Ａ', '\0', '\n', '\x7f']) expect(() => ascii({ text })).toThrow('ASCII');
  expect(ascii({ text: ' a/1~' })).toEqual(new TextEncoder().encode(' a/1~'));
});

it('terminal bitmap bits address both ends without changing neighbouring bits', () => {
  const bitmap = new Uint8Array(8192);
  for (const id of [0, 7, 8, 65535]) bitSet({ bitmap, id });
  for (const id of [0, 7, 8, 65535]) expect(bitHas({ bitmap, id })).toBe(true);
  for (const id of [1, 6, 9, 65534]) expect(bitHas({ bitmap, id })).toBe(false);
  for (const id of [-1, 65536, 1.5, NaN]) expect(() => bitSet({ bitmap, id })).toThrow('ID');
});

it('Pulse cannot miss a revision between observing state and registering a waiter', async () => {
  const pulse = new Pulse(), revision = pulse.revision;
  pulse.fire();
  await expect(pulse.wait({ revision, signal: undefined })).resolves.toBeUndefined();
  const current = pulse.revision, first = pulse.wait({ revision: current, signal: undefined }), second = pulse.wait({ revision: current, signal: undefined });
  pulse.fire();
  await Promise.all([first, second]);
  expect(pulse.revision).toBe(current + 1);
});

it('Pulse cancellation preserves the reason, removes the listener, and does not cancel other waiters', async () => {
  const pulse = new Pulse(), stop = new AbortController(), reason = new Error('Stop waiting');
  const remove = vi.spyOn(stop.signal, 'removeEventListener');
  const first = expect(pulse.wait({ revision: pulse.revision, signal: stop.signal })).rejects.toBe(reason);
  const second = pulse.wait({ revision: pulse.revision, signal: undefined });
  stop.abort(reason); await first;
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  pulse.fire(); await second;
  await expect(pulse.wait({ revision: -1, signal: stop.signal })).rejects.toBe(reason);
});
