import { expect, it, vi } from 'vitest';
import { createRpcIdentityLoader, decodePeerKey, encodePeerKey, restoreRpcIdentity } from './identity';
import { createNaidanPipingIdentity } from '@/features/naidan-piping-duplex';

it('does not read storage or generate an identity before an explicit load', async () => {
  const read = vi.fn(async () => undefined), loader = createRpcIdentityLoader({ read });
  expect(read).not.toHaveBeenCalled();
  const one = loader.load(), two = loader.load(); expect(one).toBe(two);
  const identity = await one; expect(read).toHaveBeenCalledOnce(); expect(identity.privateKey.extractable).toBe(false);
});
it('validates a structured cloned private/public binding without extracting the private key', async () => {
  const identity = await createNaidanPipingIdentity();
  const stored = structuredClone({ privateKey: identity.privateKey, publicKey: encodePeerKey({ bytes: identity.publicKey }) });
  const restored = await restoreRpcIdentity({ identity: stored }); expect(restored.publicKey).toEqual(identity.publicKey); expect(restored.privateKey.extractable).toBe(false);
});
it('rejects stored public/private keys from different identities', async () => {
  const a = await createNaidanPipingIdentity(), b = await createNaidanPipingIdentity();
  await expect(restoreRpcIdentity({ identity: { privateKey: a.privateKey, publicKey: encodePeerKey({ bytes: b.publicKey }) } })).rejects.toThrow('does not match');
});
it('rejects a zero key and noncanonical base64url rather than accepting a display label', () => {
  expect(() => decodePeerKey({ value: 'A'.repeat(43) })).toThrow();
  const canonical = encodePeerKey({ bytes: new Uint8Array(32).fill(1) });
  expect(decodePeerKey({ value: canonical })).toEqual(new Uint8Array(32).fill(1));
  expect(() => decodePeerKey({ value: canonical.slice(0, -1) + 'B' })).toThrow();
});
it('does not silently replace an unreadable saved identity', async () => {
  const read = vi.fn(async () => {
      throw new Error('Blocked storage');
    }), loader = createRpcIdentityLoader({ read });
  await expect(loader.load()).rejects.toThrow('Blocked'); await expect(loader.load()).rejects.toThrow('Blocked'); expect(read).toHaveBeenCalledTimes(2);
});
it('retries a failed identity read only on the next explicit load and preserves the stored key', async () => {
  const identity = await createNaidanPipingIdentity();
  const stored = { privateKey: identity.privateKey, publicKey: encodePeerKey({ bytes: identity.publicKey }) };
  const read = vi.fn().mockRejectedValueOnce(new Error('Storage was blocked')).mockResolvedValue(stored);
  const loader = createRpcIdentityLoader({ read });
  const first = loader.load(), concurrent = loader.load();
  expect(concurrent).toBe(first);
  await expect(first).rejects.toThrow('blocked');
  await Promise.resolve(); expect(read).toHaveBeenCalledOnce();
  const retry = loader.load();
  expect(loader.load()).toBe(retry);
  const restored = await retry;
  expect(read).toHaveBeenCalledTimes(2);
  expect(restored.publicKey).toEqual(identity.publicKey);
  expect(restored.privateKey).toBe(identity.privateKey);
  expect(await loader.load()).toBe(restored); expect(read).toHaveBeenCalledTimes(2);
});
it('does not replace a mismatched stored identity when explicit recovery is retried', async () => {
  const a = await createNaidanPipingIdentity(), b = await createNaidanPipingIdentity();
  const read = vi.fn().mockResolvedValueOnce({ privateKey: a.privateKey, publicKey: encodePeerKey({ bytes: b.publicKey }) })
    .mockResolvedValue({ privateKey: a.privateKey, publicKey: encodePeerKey({ bytes: a.publicKey }) });
  const loader = createRpcIdentityLoader({ read });
  await expect(loader.load()).rejects.toThrow('does not match');
  const repaired = await loader.load();
  expect(repaired.publicKey).toEqual(a.publicKey); expect(repaired.privateKey).toBe(a.privateKey);
});
