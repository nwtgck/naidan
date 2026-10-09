// @vitest-environment node
import { expect, it } from 'vitest';
import { OwnedByteQueue } from '@/features/naidan-piping-duplex/owned-byte-queue';

it('packs byte-at-a-time input across page boundaries without borrowing the source', () => {
  const queue = new OwnedByteQueue({ capacity: 65536 }), input = new Uint8Array([0]);
  for (let i = 0; i < 65536; i++) {
    input[0] = i % 251; queue.append({ bytes: input });
  }
  input[0] = 255;
  const bytes = queue.take({ maximum: 65536 });
  expect(bytes.every((byte, i) => byte === i % 251)).toBe(true); expect(queue.byteLength).toBe(0);
});

it('never overwrites previously returned bytes and compacts long-running queues', () => {
  const queue = new OwnedByteQueue({ capacity: 8192 }); queue.append({ bytes: new Uint8Array(4097).fill(23) });
  const first = queue.take({ maximum: 4096 });
  for (let i = 0; i < 1000; i++) {
    queue.append({ bytes: new Uint8Array(4096).fill(i % 251) }); expect(queue.take({ maximum: 4096 })).toHaveLength(4096);
  }
  expect(first.every(value => value === 23)).toBe(true); expect(queue.byteLength).toBe(1);
  expect(queue.clear()).toBe(1); expect(queue.clear()).toBe(0);
});

it('checks capacity and shared memory before adding any data', () => {
  const queue = new OwnedByteQueue({ capacity: 8 }); queue.append({ bytes: new Uint8Array([1, 2, 3]) });
  expect(() => queue.append({ bytes: new Uint8Array(6) })).toThrow();
  expect(() => queue.append({ bytes: new Uint8Array(new SharedArrayBuffer(1)) })).toThrow();
  expect([...queue.take({ maximum: 8 })]).toEqual([1, 2, 3]);
  for (const maximum of [0, -1, 0.5, Infinity]) expect(() => queue.take({ maximum })).toThrow();
});
