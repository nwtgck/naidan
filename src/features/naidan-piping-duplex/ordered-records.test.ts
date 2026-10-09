// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { keyPair, useOfflineScope } from '@/features/naidan-piping-duplex/test-support';
import { OrderedRecords, TEST_ONLY } from '@/features/naidan-piping-duplex/ordered-records';
import { BoundedBody } from '@/features/naidan-piping-duplex/finite-transfer';
import { BATCH_BYTES, batchHeader } from '@/features/naidan-piping-duplex/batch-wire';

useOfflineScope();
const signal = new AbortController().signal;
async function codecs() {
  const keys = await keyPair();
  const left = keys.a.createDomain({ label: 'test/ordered-v1', context: keys.a.contextId }), right = keys.b.createDomain({ label: 'test/ordered-v1', context: keys.b.contextId });
  return { keys, left, right, tx: new OrderedRecords({ domain: left, context: keys.a.contextId, direction: 1, usage: 'encrypt' }), rx: new OrderedRecords({ domain: right, context: keys.b.contextId, direction: 1, usage: 'decrypt' }) };
}
async function read({ rx, bytes, chunkBytes = 10000 }: { rx: OrderedRecords; bytes: Uint8Array; chunkBytes?: number }): Promise<Uint8Array[]> {
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else {
        const end = Math.min(bytes.length, offset + chunkBytes); controller.enqueue(bytes.slice(offset, end)); offset = end;
      }
    },
  });
  const reader = stream.getReader(), received: Uint8Array[] = [];
  try {
    await rx.receive({
      body: new BoundedBody({ reader, maximum: BATCH_BYTES, signal }),
      signal,
      onRecord: async ({ plaintext }) => {
        received.push(plaintext.slice());
      },
    }); return received;
  } finally {
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

it('encrypts authenticated prefixes and reads records across arbitrarily small chunks', async () => {
  const { tx, rx } = await codecs();
  const first = new Uint8Array([1, 2, 3]); expect(await read({ rx, bytes: await tx.seal({ plaintexts: [first], signal }), chunkBytes: 1 })).toEqual([first]);
  const plains = [new Uint8Array(65520).fill(17), new Uint8Array([9, 10])];
  const bytes = await tx.seal({ plaintexts: plains, signal });
  expect(await read({ rx, bytes })).toEqual(plains);
});

it('derives reciprocal, directional and per-batch paths', async () => {
  const { tx, rx, left } = await codecs();
  const first = await tx.nextRoute({ signal }); expect(first).toBe(await rx.nextRoute({ signal }));
  expect(first).not.toBe(await left.batchRoute({ direction: 2, number: 0n }));
  await read({ rx, bytes: await tx.seal({ plaintexts: [new Uint8Array([1])], signal }) });
  const second = await tx.nextRoute({ signal }); expect(second).not.toBe(first); expect(second).toBe(await rx.nextRoute({ signal }));
});

it('poisons the receiver after a bad tag instead of retaining a retry budget', async () => {
  const { tx, rx } = await codecs(); const bytes = await tx.seal({ plaintexts: [new Uint8Array([1])], signal });
  const bad = bytes.slice(); bad[bad.length - 1]! ^= 1;
  await expect(read({ rx, bytes: bad })).rejects.toThrow();
  await expect(read({ rx, bytes })).rejects.toThrow('disposed');
});

it('rejects replay, reordering, body splicing and trailing bytes', async () => {
  for (const attack of ['replay', 'reorder', 'splice', 'trailing'] as const) {
    const { tx, rx } = await codecs();
    const first = await tx.seal({ plaintexts: [new Uint8Array([1])], signal });
    const second = await tx.seal({ plaintexts: [new Uint8Array([2]), new Uint8Array([3])], signal });
    switch (attack) {
    case 'replay': await read({ rx, bytes: first }); await expect(read({ rx, bytes: first })).rejects.toThrow(); break;
    case 'reorder': await expect(read({ rx, bytes: second })).rejects.toThrow(); break;
    case 'splice': {
      await read({ rx, bytes: first }); const bad = second.slice(); bad.set(first.subarray(20), 20);
      await expect(read({ rx, bytes: bad })).rejects.toThrow(); break;
    }
    case 'trailing': {
      const bad = new Uint8Array(first.length + 1); bad.set(first);
      await expect(read({ rx, bytes: bad })).rejects.toThrow('Trailing'); break;
    }
    }
  }
});

it('copies input before asynchronous derivation and refuses a second encryption owner', async () => {
  const { tx, rx, left, keys } = await codecs(), input = new Uint8Array([17]);
  const derive = left.aead.bind(left), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  vi.spyOn(left, 'aead').mockImplementation(async args => {
    entered.resolve(); await release.promise; return derive(args);
  });
  const pending = tx.seal({ plaintexts: [input], signal }); await entered.promise; input[0] = 98;
  await expect(tx.seal({ plaintexts: [input], signal })).rejects.toThrow('owned');
  expect(() => new OrderedRecords({ domain: left, context: keys.a.contextId, direction: 1, usage: 'encrypt' })).toThrow('consumed');
  release.resolve(); expect(await read({ rx, bytes: await pending })).toEqual([new Uint8Array([17])]);
});

it('matches an independently assembled AAD layout', () => {
  const context = new Uint8Array(32).fill(51), header = batchHeader({ count: 3 });
  const encode64 = (value: bigint) => {
    const data = Buffer.alloc(8); data.writeBigUInt64BE(value); return data;
  };
  const parts = [Buffer.from('naidan-piping-duplex/v1/records'), context, new Uint8Array([2]), header, encode64(7n), encode64(91n), new Uint8Array([0, 2]), new Uint8Array([0, 0, 0, 31])];
  const oracle = Buffer.concat(parts.map(part => {
    const length = Buffer.alloc(2); length.writeUInt16BE(part.length); return Buffer.concat([length, Buffer.from(part)]);
  }));
  expect(Buffer.from(TEST_ONLY.recordAad({ context, direction: 2, header, batch: 7n, record: 91n, index: 2, length: 31 }))).toEqual(oracle);
});

it('rejects a too-large length before invoking native decryption', async () => {
  const { rx } = await codecs(); const bad = new Uint8Array(20); bad.set(batchHeader({ count: 1 })); new DataView(bad.buffer).setUint32(16, 0xffffffff);
  const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
  await expect(read({ rx, bytes: bad })).rejects.toThrow('length'); expect(decrypt).not.toHaveBeenCalled();
});
