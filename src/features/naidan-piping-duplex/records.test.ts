// @vitest-environment node
import { encodeProtocolHeader } from './protocol-header';
import { AuthenticatedProtocolError, RecordExhaustedError } from '@/features/naidan-piping-duplex/lifetime';
import { expect, it, vi } from 'vitest';
import { CAPSULE_BYTES, MAX_OFFSET } from '@/features/naidan-piping-duplex/bytes';
import { Records } from '@/features/naidan-piping-duplex/records';
import { encodeRecordPayload } from '@/features/naidan-piping-duplex/wire';
import { emptySnapshot, keyPair, useOfflineScope } from '@/features/naidan-piping-duplex/test-support';

useOfflineScope();

async function codecs() {
  const keys = await keyPair();
  const left = keys.a.createDomain({ label: 'test/record-contracts', context: new Uint8Array() });
  const right = keys.b.createDomain({ label: 'test/record-contracts', context: new Uint8Array() });
  return {
    keys,
    left,
    right,
    tx: new Records({ domain: left, context: keys.a.contextId, direction: 1, usage: 'encrypt' }),
    rx: new Records({ domain: right, context: keys.b.contextId, direction: 1, usage: 'decrypt' }),
  };
}

function plaintext(): Uint8Array {
  return encodeRecordPayload({ payload: { challenge: undefined, echo: undefined, snapshot: emptySnapshot(), receiptRequest: 'not-requested', receivedRecord: undefined } });
}

it('authenticated but malformed plaintext never advances the replay watermark or invokes the application', async () => {
  const { tx, rx } = await codecs(), apply = vi.fn(() => undefined);
  const malformed = await tx.seal({ plaintext: new Uint8Array([255]) });
  await expect(rx.accept({ capsule: malformed, apply })).rejects.toThrow();
  expect(rx.high).toBe(-1n); expect(apply).not.toHaveBeenCalled();
  expect(await rx.accept({ capsule: await tx.seal({ plaintext: plaintext() }), apply })).toBe('accepted');
  expect(rx.high).toBe(1n); expect(apply).toHaveBeenCalledTimes(1);
});

it('a rejected semantic transaction does not consume an authenticated record', async () => {
  const { tx, rx } = await codecs();
  const capsule = await tx.seal({ plaintext: plaintext() });
  await expect(rx.accept({
    capsule,
    apply: () => {
      throw new Error('Semantic rejection');
    },
  })).rejects.toThrow('Semantic');
  expect(rx.high).toBe(-1n);
  expect(await rx.accept({ capsule, apply: () => undefined })).toBe('accepted');
  expect(await rx.accept({
    capsule,
    apply: () => {
      throw new Error('Duplicate application');
    },
  })).toBe('stale');
});

it('all visible header bytes are authenticated and mutation cannot change accepted state', async () => {
  const { tx, rx } = await codecs(), capsule = await tx.seal({ plaintext: plaintext() }), apply = vi.fn(() => undefined);
  for (let offset = 0; offset < capsule.length; offset++) {
    const corrupt = capsule.slice(); corrupt[offset]! ^= 1;
    expect(await rx.accept({ capsule: corrupt, apply })).toBe('unauthenticated');
    expect(rx.high).toBe(-1n);
  }
  expect(apply).not.toHaveBeenCalled();
  expect(await rx.accept({ capsule, apply })).toBe('accepted');
});

it('invalid outer lengths, types, and sequence bounds never invoke cryptography', async () => {
  const { rx } = await codecs();
  const tooHigh = new Uint8Array(38); tooHigh.set(encodeProtocolHeader()); tooHigh[13] = 5;
  new DataView(tooHigh.buffer).setBigUint64(14, MAX_OFFSET + 1n, false);
  const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
  for (const capsule of [new Uint8Array(), new Uint8Array(24), new Uint8Array(25), tooHigh,
    new Uint8Array(CAPSULE_BYTES + 1), new Uint8Array(new SharedArrayBuffer(25)), null as unknown as Uint8Array]) {
    expect(await rx.accept({
      capsule,
      apply: () => {
        throw new Error('Invalid outer record');
      },
    })).toBe('unauthenticated');
  }
  expect(decrypt).not.toHaveBeenCalled(); expect(rx.high).toBe(-1n);
});

it('oversized or shared outbound plaintext does not burn a valid sequence number', async () => {
  const { tx } = await codecs();
  for (const bytes of [new Uint8Array(CAPSULE_BYTES - 37), new Uint8Array(new SharedArrayBuffer(2))]) {
    await expect(tx.seal({ plaintext: bytes })).rejects.toThrow(); expect(tx.next).toBe(0n);
  }
  const capsule = await tx.seal({ plaintext: new Uint8Array(CAPSULE_BYTES - 38) });
  expect(capsule.length).toBe(CAPSULE_BYTES); expect(tx.next).toBe(1n);
});

it('sealing copies the input before asynchronous derivation and rejects a concurrent writer', async () => {
  const { tx, rx, left } = await codecs(), bytes = plaintext();
  const derive = left.aead.bind(left), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  vi.spyOn(left, 'aead').mockImplementation(async args => {
    entered.resolve(); await release.promise; return derive(args);
  });
  const pending = tx.seal({ plaintext: bytes }); await entered.promise; bytes.fill(255);
  await expect(tx.seal({ plaintext: plaintext() })).rejects.toThrow('unavailable');
  expect(tx.next).toBe(1n); release.resolve();
  expect(await rx.accept({
    capsule: await pending,
    apply: ({ snapshot }) => {
      expect(snapshot.goaway).toBe(false);
    },
  })).toBe('accepted');
});

it('receiving copies the encrypted record before an asynchronous key lookup', async () => {
  const { tx, rx, right } = await codecs(), capsule = await tx.seal({ plaintext: plaintext() });
  const derive = right.aead.bind(right), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  vi.spyOn(right, 'aead').mockImplementation(async args => {
    entered.resolve(); await release.promise; return derive(args);
  });
  const pending = rx.accept({ capsule, apply: () => undefined }); await entered.promise; capsule.fill(0); release.resolve();
  expect(await pending).toBe('accepted');
});

it('epoch rotation changes the key before reusing the per-epoch nonce', async () => {
  const { tx, rx, left, right } = await codecs(), encoded = plaintext();
  const outbound = vi.spyOn(left, 'aead'), inbound = vi.spyOn(right, 'aead');
  const selected = new Map<number, Uint8Array>();
  // Exercise the actual counter, KDF, and AES-GCM; no private-state writes or nonce mocks.
  for (let number = 0; number <= 16384; number++) {
    const capsule = await tx.seal({ plaintext: encoded });
    if (number === 0 || number === 16383 || number === 16384) selected.set(number, capsule);
  }
  expect(outbound.mock.calls.map(([args]) => args.epoch)).toEqual([0n, 1n]);
  for (const number of [0, 16383, 16384]) {
    const capsule = selected.get(number)!;
    expect(new DataView(capsule.buffer).getBigUint64(14, false)).toBe(BigInt(number));
    expect(await rx.accept({ capsule, apply: () => undefined })).toBe('accepted');
  }
  expect(inbound.mock.calls.map(([args]) => args.epoch)).toEqual([0n, 1n]);
  expect(selected.get(0)!.slice(22)).not.toEqual(selected.get(16384)!.slice(22));
  expect(await rx.accept({
    capsule: selected.get(16383)!,
    apply: () => {
      throw new Error('Previous epoch replay');
    },
  })).toBe('stale');
}, 15000);

it('failed-authentication accounting survives success and epoch changes and reserves concurrent attempts', async () => {
  const { rx, right } = await codecs();
  const cachedKey = await right.aead({ direction: 1, epoch: 0n, usage: 'decrypt' });
  vi.spyOn(right, 'aead').mockResolvedValue(cachedKey);
  const failure = new DOMException('Injected authentication failure', 'OperationError');
  const decrypt = vi.spyOn(crypto.subtle, 'decrypt').mockRejectedValue(failure);
  const capsule = new Uint8Array(38); capsule.set(encodeProtocolHeader()); capsule[13] = 5;
  const apply = vi.fn(() => undefined);
  // Only test the accounting policy here. Real authentication is covered by the other record tests.
  for (let index = 0; index < 65534; index++) await rx.accept({ capsule, apply });
  expect(decrypt).toHaveBeenCalledTimes(65534); expect(apply).not.toHaveBeenCalled();
  const rotated = capsule.slice(); new DataView(rotated.buffer).setBigUint64(14, 16384n, false);
  decrypt.mockResolvedValueOnce(plaintext().buffer as ArrayBuffer);
  expect(await rx.accept({ capsule: rotated, apply })).toBe('accepted');
  expect(await rx.accept({ capsule, apply })).toBe('unauthenticated');
  const release = Promise.withResolvers<ArrayBuffer>(); decrypt.mockReturnValueOnce(release.promise);
  const last = rx.accept({ capsule, apply });
  const lastRejected = expect(last).rejects.toThrow('budget exhausted');
  await expect(rx.accept({ capsule, apply })).rejects.toThrow('budget exhausted');
  release.reject(failure); await lastRejected;
  await expect(rx.accept({ capsule, apply })).rejects.toThrow('budget exhausted');
  expect(decrypt).toHaveBeenCalledTimes(65537); // 65,536 failures and one successful verification.
  expect(apply).toHaveBeenCalledTimes(1); expect(rx.high).toBe(16384n);
}, 15000);

it('an unavailable key derivation releases the pending verification reservation', async () => {
  const { tx, rx, right } = await codecs(), capsule = await tx.seal({ plaintext: plaintext() });
  vi.spyOn(right, 'aead').mockRejectedValueOnce(new Error('Injected derivation error'));
  await expect(rx.accept({ capsule, apply: () => undefined })).rejects.toThrow('derivation');
  expect(await rx.accept({ capsule, apply: () => undefined })).toBe('accepted');
});

it('the last legal local record succeeds and the next seal is typed exhaustion without wrap', async () => {
  const { tx } = await codecs();
  // Test-only boundary injection, not a production counter-reset API.
  Object.defineProperty(tx, 'internalNext', { value: MAX_OFFSET, writable: true });
  const last = await tx.seal({ plaintext: plaintext() });
  expect(new DataView(last.buffer, last.byteOffset, last.byteLength).getBigUint64(14, false)).toBe(MAX_OFFSET);
  expect(tx.next).toBe(MAX_OFFSET + 1n);
  await expect(tx.seal({ plaintext: plaintext() })).rejects.toBeInstanceOf(RecordExhaustedError);
  expect(tx.next).toBe(MAX_OFFSET + 1n);
});

it('a failed final seal still consumes its local number permanently', async () => {
  const { tx } = await codecs(), failure = new Error('Native seal failed');
  Object.defineProperty(tx, 'internalNext', { value: MAX_OFFSET, writable: true });
  const encrypt = vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(failure);
  await expect(tx.seal({ plaintext: plaintext() })).rejects.toBe(failure);
  await expect(tx.seal({ plaintext: plaintext() })).rejects.toBeInstanceOf(RecordExhaustedError);
  expect(encrypt).toHaveBeenCalledOnce(); expect(tx.next).toBe(MAX_OFFSET + 1n);
});

it('untrusted high record numbers and forged reason text cannot exhaust the local sender', async () => {
  const { tx, rx } = await codecs(), apply = vi.fn(() => undefined);
  const forged = new Uint8Array(64); forged.set(encodeProtocolHeader()); forged[13] = 5;
  new DataView(forged.buffer).setBigUint64(14, MAX_OFFSET + 1n, false);
  forged.set(new TextEncoder().encode('record-exhausted'), 22);
  await expect(rx.accept({ capsule: forged, apply })).resolves.toBe('unauthenticated');
  new DataView(forged.buffer).setBigUint64(14, 0n, false);
  await expect(rx.accept({ capsule: forged, apply })).resolves.toBe('unauthenticated');
  expect(tx.next).toBe(0n); expect(rx.high).toBe(-1n); expect(apply).not.toHaveBeenCalled();
  await expect(tx.seal({ plaintext: plaintext() })).resolves.toBeInstanceOf(Uint8Array);
});

it('wrong usage and concurrent writer ownership are not counter exhaustion', async () => {
  const { tx, rx } = await codecs();
  await expect(rx.seal({ plaintext: plaintext() })).rejects.not.toBeInstanceOf(RecordExhaustedError);
  Object.defineProperty(tx, 'internalBusy', { value: true, writable: true });
  await expect(tx.seal({ plaintext: plaintext() })).rejects.not.toBeInstanceOf(RecordExhaustedError);
});

it('even authenticated forged terminal text remains malformed payload, not local exhaustion', async () => {
  const { tx, rx } = await codecs();
  const capsule = await tx.seal({ plaintext: new TextEncoder().encode('record-exhausted') });
  const result = rx.accept({ capsule, apply: () => undefined });
  await expect(result).rejects.toBeInstanceOf(AuthenticatedProtocolError);
  await expect(result).rejects.not.toBeInstanceOf(RecordExhaustedError);
  expect(rx.high).toBe(-1n);
});

it('AEAD associated data contains the complete selected header, kind and record number', async () => {
  const { tx, rx } = await codecs(), encrypt = vi.spyOn(crypto.subtle, 'encrypt');
  const capsule = await tx.seal({ plaintext: plaintext() });
  const parameters = encrypt.mock.calls[0]![0] as AesGcmParams;
  const aad = parameters.additionalData;
  if (!(aad instanceof Uint8Array)) throw new Error('Expected owned record associated data');
  expect(aad.slice(-22)).toEqual(capsule.slice(0, 22));
  const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
  const wrong = capsule.slice(); new DataView(wrong.buffer).setUint32(9, 0x80000003, true);
  expect(await rx.accept({ capsule: wrong, apply: () => undefined })).toBe('unauthenticated'); expect(decrypt).not.toHaveBeenCalled();
  expect(await rx.accept({ capsule, apply: () => undefined })).toBe('accepted');
});

it('fits the maximum current snapshot plus all lifecycle controls inside one peer envelope', async () => {
  const { encodePeerEnvelope, decodePeerEnvelope } = await import('./peer-envelope');
  const { tx, rx } = await codecs();
  const finished = new Uint8Array(8192), reset = new Uint8Array(8192); finished[8191] = 128; reset[8191] = 64;
  const body = encodeRecordPayload({
    payload: {
      receiptRequest: 'requested',
      receivedRecord: 0n,
      challenge: new Uint8Array(32),
      echo: new Uint8Array(32),
      control: { ready: true, close: new Uint8Array(32), closeAck: new Uint8Array(32) },
      snapshot: {
        goaway: false,
        finished,
        reset,
        states: Array.from({ length: 32 }, (_, id) => ({ id, flags: 0, rxNext: 0n, rxLimit: 65536n, final: 0n })),
        data: [0, 2].map(id => ({ id, offset: 0n, bytes: new Uint8Array(16384) })),
      },
    },
  });
  const capsule = await tx.seal({ plaintext: body }); expect(capsule.length).toBe(50221);
  const envelope = encodePeerEnvelope({ envelope: { kind: 'routed', channel: 'c'.repeat(96), route: 'r'.repeat(96), body: new Uint8Array(capsule) } });
  expect(envelope.length).toBeLessThanOrEqual(65536);
  const decoded = decodePeerEnvelope({ bytes: envelope }); if (decoded?.kind !== 'routed') throw new Error('Missing routed record');
  expect(await rx.accept({ capsule: decoded.body, apply: () => undefined })).toBe('accepted');
});
