// @vitest-environment node
import { expect, it, onTestFinished, vi } from 'vitest';
import { createNaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import { pairKeys } from '@/features/naidan-piping-duplex/finite-handshake';
import { connectPinnedKeys } from '@/features/naidan-piping-duplex/pinned-contact';
import { FiniteTransferEndpoint } from '@/features/naidan-piping-duplex/finite-transfer';
import { FiniteMemoryRelay } from '@/features/naidan-piping-duplex/finite-memory-relay.test-support';
import { useOfflineScope } from '@/features/naidan-piping-duplex/test-support';

useOfflineScope();
async function fixture() {
  const relay = new FiniteMemoryRelay(), controller = new AbortController();
  vi.mocked(fetch).mockImplementation(relay.fetch);
  const identities = await Promise.all([createNaidanPipingIdentity(), createNaidanPipingIdentity()]);
  const endpoint = () => new FiniteTransferEndpoint({ baseUrl: 'https://relay.invalid', policy: 'https-only', timeoutMs: 1000 });
  const options = { signal: controller.signal, responseTimeoutMs: 1000, publicHandshakeData: new Uint8Array([1, 2]), handshakeData: new Uint8Array([3, 4]) };
  const jobs: Promise<{ keys: { dispose(): void } }>[] = [];
  onTestFinished(async () => {
    controller.abort();
    await Promise.allSettled(jobs.map(async job => (await job).keys.dispose()));
    relay.interrupt();
  });
  return { relay, controller, identities, endpoint, options, jobs };
}

it('connects pinned peers with one fixed OFFER and unique directional flights', async () => {
  const f = await fixture();
  for (const index of [0, 1]) f.jobs.push(connectPinnedKeys({ ...f.options, endpoint: f.endpoint(), identity: f.identities[index]!, expectedPeer: f.identities[1 - index]!.publicKey, purpose: 'naidan-rpc/v1' }));
  const [a, b] = await Promise.all(f.jobs);
  expect(a!.keys).toBeDefined(); expect(b!.keys).toBeDefined();
  const offers = f.relay.posts.filter(post => post.bytes[13] === 0x21);
  expect(offers).toHaveLength(1); expect(offers[0]!.bytes).toHaveLength(78);
  expect(new Set(f.relay.posts.map(post => post.route)).size).toBe(f.relay.posts.length);
  expect(f.relay.occupied).toBe(0);
});

it('authenticates both public and private advertisement data in the completed key context', async () => {
  const f = await fixture();
  const data = new Uint8Array(16384).fill(72);
  const jobs = [0, 1].map(index => connectPinnedKeys({ ...f.options, handshakeData: data, endpoint: f.endpoint(), identity: f.identities[index]!, expectedPeer: f.identities[1 - index]!.publicKey, purpose: 'naidan-rpc/v1' }));
  f.jobs.push(...jobs); const [a, b] = await Promise.all(jobs);
  expect(a!.keys.contextId).toEqual(b!.keys.contextId);
  expect(a!.keys.peerIdentity).toEqual(f.identities[1]!.publicKey);
  expect(a!.peerHandshakeData).toEqual(data); expect(b!.peerPublicHandshakeData).toEqual(f.options.publicHandshakeData);
});

it('pairs explicit opposite roles after matching the full comparison value', async () => {
  const f = await fixture(), comparisons: Uint8Array[] = [];
  const jobs = [0, 1].map(index => pairKeys({
    ...f.options,
    endpoint: f.endpoint(),
    identity: f.identities[index]!,
    code: '1234-5678',
    role: index === 0 ? 'initiator' : 'responder',
    verifyPeer: async ({ comparison }) => {
      comparisons.push(comparison.slice()); return true;
    },
  }));
  f.jobs.push(...jobs); const [a, b] = await Promise.all(jobs);
  expect(comparisons).toHaveLength(2); expect(comparisons[0]).toHaveLength(32); expect(comparisons[0]).toEqual(comparisons[1]);
  expect(a!.keys.contextId).toEqual(b!.keys.contextId);
});

it('elects one initiator for ordinary pairing without a caller-specified role', async () => {
  const f = await fixture();
  const jobs = [0, 1].map(index => pairKeys({ ...f.options, endpoint: f.endpoint(), identity: f.identities[index]!, code: '1234-5678', verifyPeer: async () => true }));
  f.jobs.push(...jobs); const [a, b] = await Promise.all(jobs);
  expect(a!.keys.contextId).toEqual(b!.keys.contextId); expect(a!.keys.role).not.toBe(b!.keys.role);
});

it('does not restart comparison after a user rejects pairing', async () => {
  const f = await fixture(), promptsReady = Promise.withResolvers<void>(); let prompted = 0;
  const prompt = async ({ approved }: { approved: boolean }) => {
    if (++prompted === 2) promptsReady.resolve();
    await promptsReady.promise; return approved;
  };
  const verified = [vi.fn(() => prompt({ approved: false })), vi.fn(() => prompt({ approved: true }))];
  const jobs = [0, 1].map(index => pairKeys({ ...f.options, endpoint: f.endpoint(), identity: f.identities[index]!, code: '1234-5678', role: index === 0 ? 'initiator' : 'responder', verifyPeer: verified[index]! }));
  f.jobs.push(...jobs);
  await expect(jobs[0]).rejects.toThrow('Peer comparison rejected'); f.controller.abort(); await Promise.allSettled(jobs);
  expect(verified[0]).toHaveBeenCalledOnce(); expect(verified[1]).toHaveBeenCalledOnce();
});

it('waits for human comparison longer than the automatic response timeout without timing it out', async () => {
  const f = await fixture(), approval = Promise.withResolvers<boolean>(), entered = Promise.withResolvers<void>();
  const jobs = [0, 1].map(index => pairKeys({
    ...f.options,
    responseTimeoutMs: 100,
    endpoint: f.endpoint(),
    identity: f.identities[index]!,
    code: '1234-5678',
    role: index === 0 ? 'initiator' : 'responder',
    verifyPeer: async () => {
      entered.resolve(); return index === 0 ? approval.promise : true;
    },
  }));
  f.jobs.push(...jobs); await entered.promise; await new Promise(resolve => setTimeout(resolve, 180)); approval.resolve(true);
  const [a, b] = await Promise.all(jobs); expect(a!.keys.contextId).toEqual(b!.keys.contextId);
});

it('initial pairing never sends advertisements before both human approvals', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), approval = Promise.withResolvers<boolean>(); let count = 0;
  const publicHandshakeData = new Uint8Array(256).fill(73), handshakeData = new Uint8Array(1024).fill(28);
  const jobs = [0, 1].map(index => pairKeys({
    ...f.options,
    responseTimeoutMs: 200,
    publicHandshakeData,
    handshakeData,
    endpoint: f.endpoint(),
    identity: f.identities[index]!,
    code: '1234-5678',
    role: index === 0 ? 'initiator' : 'responder',
    verifyPeer: async () => {
      if (++count === 2) entered.resolve(); return index === 0 ? true : approval.promise;
    },
  }));
  f.jobs.push(...jobs); for (const job of jobs) void job.catch(error => entered.reject(error));
  await entered.promise; await new Promise(resolve => setTimeout(resolve, 250));
  expect(f.relay.posts.every(post => post.bytes.length <= 110)).toBe(true);
  approval.resolve(true); const [a, b] = await Promise.all(jobs);
  expect(a!.peerPublicHandshakeData).toEqual(publicHandshakeData); expect(b!.peerHandshakeData).toEqual(handshakeData);
  expect(f.relay.posts.some(post => post.bytes.length > 1024)).toBe(true);
});
