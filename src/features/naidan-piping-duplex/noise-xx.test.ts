// @vitest-environment node
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { expect, onTestFinished, it, vi } from 'vitest';
import { promiseAllKeyed } from '@/utils/promise';
import { NoiseXX, NoiseCipher, createNaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import type { NaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import { useOfflineScope } from '@/features/naidan-piping-duplex/test-support';

useOfflineScope();
// Public test keys, not credentials. Fixed external ciphertexts detect mutually compatible implementation bugs.
const vector = {
  "source": "https://raw.githubusercontent.com/rweather/noise-c/master/tests/vector/cacophony.txt",
  "sourceLines": "13115-13151",
  "notice": "Public test keys only. Extracted test data, not production keys.",
  "name": "Noise_XX_25519_AESGCM_SHA256",
  "init_prologue": "4a6f686e2047616c74",
  "init_static": "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1",
  "init_ephemeral": "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
  "resp_prologue": "4a6f686e2047616c74",
  "resp_static": "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
  "resp_ephemeral": "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
  "messages": [
    {
      "payload": "4c756477696720766f6e204d69736573",
      "ciphertext": "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79444c756477696720766f6e204d69736573",
    },
    {
      "payload": "4d757272617920526f746862617264",
      "ciphertext": "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843757117acceb05bd7a45733bc22015c97a9d0cbaf41b80446d5988ff5127235d76b79eade70f473d6a4ef521fdcbeda5340d01e028ba793fc059f2724a83af05f12dda0448a7621a926b379a92477fd",
    },
    {
      "payload": "462e20412e20486179656b",
      "ciphertext": "c90f1cf77eba4e50edb038991565e36c9758943a989229b6051244dc4fbecb6946744b401af2ee1a5881b65fbb87fd07cb6a328ececc9ce6ce84c399dc332d4fd521fa4bb7f467ce909395",
    },
    {
      "payload": "4361726c204d656e676572",
      "ciphertext": "bc3fa77f6aca3e8466d7dc6bea10013e88a6a29add5132b461806c",
    },
    {
      "payload": "4a65616e2d426170746973746520536179",
      "ciphertext": "250b01074cdfe0df2ecf8ccbf1737b15a2ddb5b52fd9a396604e9c793cee3b3bb9",
    },
    {
      "payload": "457567656e2042f6686d20766f6e2042617765726b",
      "ciphertext": "449d4d433b3cdc3d02bf6fc881774b9df54366ebcffb9689bb13f14709822cd7ef42bcdb4d",
    }
  ],
};

function fromHex({ text }: { text: string }): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(text, 'hex'));
}
async function testIdentity({ secret }: { secret: string }): Promise<NaidanPipingIdentity> {
  const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(secret, 'hex')]);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicDer = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return {
    privateKey: await crypto.subtle.importKey('pkcs8', der, 'X25519', false, ['deriveBits']),
    publicKey: new Uint8Array(publicDer.subarray(-32)),
  };
}
async function pair() {
  const identities = await promiseAllKeyed({
    identityA: testIdentity({ secret: vector.init_static }),
    ephemeralA: testIdentity({ secret: vector.init_ephemeral }),
    identityB: testIdentity({ secret: vector.resp_static }),
    ephemeralB: testIdentity({ secret: vector.resp_ephemeral }),
  });
  const states = await promiseAllKeyed({
    a: NoiseXX.create({
      role: 'initiator',
      identity: identities.identityA,
      ephemeral: identities.ephemeralA,
      prologue: fromHex({ text: vector.init_prologue }),
    }),
    b: NoiseXX.create({
      role: 'responder',
      identity: identities.identityB,
      ephemeral: identities.ephemeralB,
      prologue: fromHex({ text: vector.resp_prologue }),
    }),
  });
  onTestFinished(() => {
    states.a.dispose(); states.b.dispose();
  });
  return states;
}
async function handshake({ a, b }: { a: NoiseXX; b: NoiseXX }): Promise<void> {
  for (let index = 0; index < 3; index++) {
    const sender = index % 2 ? b : a, receiver = index % 2 ? a : b;
    await receiver.exchange({ operation: 'read', bytes: await sender.exchange({ operation: 'write', bytes: new Uint8Array() }) });
  }
}

it('published Noise XX vector matches three exact handshake and three transport ciphertexts', async () => {
  const { a, b } = await pair();
  for (let index = 0; index < 3; index++) {
    const expected = vector.messages[index]!, sender = index % 2 ? b : a, receiver = index % 2 ? a : b;
    const message = await sender.exchange({ operation: 'write', bytes: fromHex({ text: expected.payload }) });
    expect(Buffer.from(message).toString('hex')).toBe(expected.ciphertext);
    expect(await receiver.exchange({ operation: 'read', bytes: message })).toEqual(fromHex({ text: expected.payload }));
  }
  const { left, right } = await promiseAllKeyed({ left: a.split(), right: b.split() });
  onTestFinished(() => {
    left.send.dispose(); left.receive.dispose(); right.send.dispose(); right.receive.dispose();
  });
  expect(left.binding).toEqual(right.binding);
  for (let index = 3; index < vector.messages.length; index++) {
    const expected = vector.messages[index]!, sender = index % 2 ? right : left, receiver = index % 2 ? left : right;
    const message = await sender.send.crypt({ operation: 'encrypt', bytes: fromHex({ text: expected.payload }), aad: new Uint8Array() });
    expect(Buffer.from(message).toString('hex')).toBe(expected.ciphertext);
    expect(await receiver.receive.crypt({ operation: 'decrypt', bytes: message, aad: new Uint8Array() })).toEqual(fromHex({ text: expected.payload }));
  }
  await expect(a.split()).rejects.toThrow('consumed');
});

it.each([0, 31, 32, 79, 95])('a truncated second flight of %s bytes poisons only that handshake', async length => {
  const { a, b } = await pair();
  await b.exchange({ operation: 'read', bytes: await a.exchange({ operation: 'write', bytes: new Uint8Array() }) });
  const reply = await b.exchange({ operation: 'write', bytes: new Uint8Array() });
  await expect(a.exchange({ operation: 'read', bytes: reply.subarray(0, length) })).rejects.toThrow();
  await expect(a.exchange({ operation: 'read', bytes: reply })).rejects.toThrow('unavailable');
});

it('mutated handshake authentication never allows split or retry on the same state', async () => {
  const { a, b } = await pair();
  await b.exchange({ operation: 'read', bytes: await a.exchange({ operation: 'write', bytes: new Uint8Array() }) });
  const reply = await b.exchange({ operation: 'write', bytes: new Uint8Array() }); reply[reply.length - 1]! ^= 1;
  await expect(a.exchange({ operation: 'read', bytes: reply })).rejects.toThrow();
  await expect(a.exchange({ operation: 'read', bytes: reply })).rejects.toThrow('unavailable');
  await expect(a.split()).rejects.toThrow('consumed');
});

it('wrong flight and premature split are rejected before advancing the handshake', async () => {
  const { a, b } = await pair();
  await expect(a.exchange({ operation: 'read', bytes: new Uint8Array() })).rejects.toThrow('Wrong');
  await expect(a.split()).rejects.toThrow('incomplete');
  await handshake({ a, b });
  const split = await a.split(); split.send.dispose(); split.receive.dispose();
});

it('concurrent handshake writes cannot advance the same state twice', async () => {
  const { a } = await pair();
  const first = a.exchange({ operation: 'write', bytes: new Uint8Array() });
  await expect(a.exchange({ operation: 'write', bytes: new Uint8Array() })).rejects.toThrow('unavailable');
  await first;
});

it('encoded-flight bounds apply to overhead as well as to payload size', async () => {
  const { a } = await pair();
  await expect(a.exchange({ operation: 'write', bytes: new Uint8Array(512) })).rejects.toThrow('message limit');
  await expect(a.exchange({ operation: 'write', bytes: new Uint8Array() })).rejects.toThrow('unavailable');
});

it('all-zero X25519 input is rejected instead of establishing a predictable secret', async () => {
  const key = await createNaidanPipingIdentity();
  const invalid = await crypto.subtle.importKey('raw', new Uint8Array(32), 'X25519', false, []);
  await expect(crypto.subtle.deriveBits({ name: 'X25519', public: invalid }, key.privateKey, 256)).rejects.toThrow();
  expect(key.privateKey.extractable).toBe(false);
  await expect(crypto.subtle.exportKey('pkcs8', key.privateKey)).rejects.toThrow();
});

it('disposing while split is in progress never publishes usable ciphers', async () => {
  const { a, b } = await pair(); await handshake({ a, b });
  const pending = a.split(); a.dispose();
  await expect(pending).rejects.toThrow('disposed');
});

it('cipher encryption failure permanently burns the cipher rather than recycling its nonce', async () => {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const cipher = new NoiseCipher({ key }); onTestFinished(() => cipher.dispose());
  const encrypt = vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(new Error('Local encryption failure'));
  await expect(cipher.crypt({ operation: 'encrypt', bytes: new Uint8Array([1]), aad: new Uint8Array() })).rejects.toThrow('Local encryption');
  await expect(cipher.crypt({ operation: 'encrypt', bytes: new Uint8Array([2]), aad: new Uint8Array() })).rejects.toThrow('unavailable');
  expect(encrypt).toHaveBeenCalledTimes(1);
});

it('failed transport decryption does not consume the valid receive nonce', async () => {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const tx = new NoiseCipher({ key }), rx = new NoiseCipher({ key });
  onTestFinished(() => {
    tx.dispose(); rx.dispose();
  });
  const bytes = new Uint8Array([8, 9]), aad = new Uint8Array([2, 5]);
  const good = await tx.crypt({ operation: 'encrypt', bytes, aad }), corrupt = good.slice(); corrupt[0]! ^= 1;
  await expect(rx.crypt({ operation: 'decrypt', bytes: corrupt, aad })).rejects.toThrow();
  await expect(rx.crypt({ operation: 'decrypt', bytes: good, aad })).resolves.toEqual(bytes);
  await expect(rx.crypt({ operation: 'decrypt', bytes: good, aad })).rejects.toThrow();
});
