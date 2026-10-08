// @vitest-environment node
import { expect, it } from 'vitest';
import { decodeRecordPayload, encodeRecordPayload } from './wire';
import { MAX_OFFSET } from './bytes';
import { Records } from './records';
import { emptySnapshot, keyPair, useOfflineScope } from './test-support';

useOfflineScope();

it.each(Array.from({ length: 16 }, (_, flags) => flags))('canonical private token payload flags %i', flags => {
  const challenge = flags & 4 ? new Uint8Array(32).fill(0x5a) : undefined;
  const echo = flags & 8 ? new Uint8Array(32).fill(0xa5) : undefined;
  const receivedRecord = flags & 2 ? 0x010203040506n : undefined;
  const payload = { receiptRequest: flags & 1 ? 'requested' as const : 'not-requested' as const, receivedRecord, challenge, echo, snapshot: emptySnapshot() };
  const reference = new Uint8Array(Buffer.from(flags.toString(16).padStart(2, '0') + (receivedRecord === undefined ? '' : '0000010203040506')
    + (challenge ? '5a'.repeat(32) : '') + (echo ? 'a5'.repeat(32) : '') + '0000000000', 'hex'));
  expect(encodeRecordPayload({ payload })).toEqual(reference);
  expect(decodeRecordPayload({ bytes: reference })).toEqual(payload);
  for (let length = 0; length < reference.length; length++) expect(() => decodeRecordPayload({ bytes: reference.subarray(0, length) })).toThrow();
});

it('unknown flags, extra bytes and incorrect token lengths fail closed', () => {
  const payload = { receiptRequest: 'not-requested' as const, receivedRecord: undefined, challenge: undefined, echo: undefined, snapshot: emptySnapshot() };
  const valid = encodeRecordPayload({ payload });
  for (const flag of [16, 32, 64, 128, 255]) {
    const bytes = valid.slice(); bytes[0] = flag; expect(() => decodeRecordPayload({ bytes })).toThrow();
  }
  const trailing = new Uint8Array(valid.length + 1); trailing.set(valid); expect(() => decodeRecordPayload({ bytes: trailing })).toThrow();
  for (const token of [new Uint8Array(), new Uint8Array(31), new Uint8Array(33), new Uint8Array(new SharedArrayBuffer(32))]) {
    expect(() => encodeRecordPayload({ payload: { ...payload, challenge: token } })).toThrow();
    expect(() => encodeRecordPayload({ payload: { ...payload, echo: token } })).toThrow();
  }
});

it('decoder respects byte offsets and owns token buffers independently of input', () => {
  const bytes = encodeRecordPayload({ payload: { receiptRequest: 'requested', receivedRecord: 1n, challenge: new Uint8Array(32).fill(7), echo: new Uint8Array(32).fill(9), snapshot: emptySnapshot() } });
  const storage = new Uint8Array(bytes.length + 11); storage.set(bytes, 5);
  const decoded = decodeRecordPayload({ bytes: storage.subarray(5, 5 + bytes.length) }); storage.fill(0);
  expect(decoded.challenge).toEqual(new Uint8Array(32).fill(7)); expect(decoded.echo).toEqual(new Uint8Array(32).fill(9));
  decoded.challenge!.fill(1); expect(decoded.echo).toEqual(new Uint8Array(32).fill(9));
});

it('maximum structural snapshot and control-only tokens fit the current finite body with actual record codec', async () => {
  const keys = await keyPair(), domain = keys.a.createDomain({ label: 'test/challenge-size', context: new Uint8Array() });
  const records = new Records({ domain, context: keys.a.contextId, direction: 1, usage: 'encrypt' });
  const metadata = { receiptRequest: 'requested' as const, receivedRecord: MAX_OFFSET, challenge: new Uint8Array(32), echo: new Uint8Array(32) };
  const snapshot = {
    goaway: false,
    finished: new Uint8Array(8192).fill(1),
    reset: new Uint8Array(8192).fill(1),
    states: Array.from({ length: 32 }, (_, id) => ({ id, flags: 0, rxNext: 0n, rxLimit: 65536n, final: 0n })),
    data: [0, 1].map(id => ({ id, offset: 0n, bytes: new Uint8Array(16384) })),
  };
  const full = await records.seal({ plaintext: encodeRecordPayload({ payload: { ...metadata, snapshot } }) });
  const control = await records.seal({ plaintext: encodeRecordPayload({ payload: { ...metadata, snapshot: emptySnapshot() } }) });
  // Hpd13 + kind1 + number8 + tag16 gives 38 bytes of outer overhead.
  expect(full.byteLength).toBe(50_156); expect(control.byteLength).toBe(116);
});
