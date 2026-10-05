import { afterEach, expect, it, vi } from 'vitest';
import { NaidanPeerManager } from './manager';
import type { RpcLink, RpcManagerDependencies } from './manager';
import { acquireRpcOwner } from './owner';
import { createWebLocksFixture } from './test-support/web-locks';
import { encodePeerKey } from './identity';
import { transportPair } from '@/features/naidan-rpc/test-transport';
import { createInferenceBudget } from '@/features/naidan-peer-rpc/handlers/inference/budget';
import type { NaidanRpcConnection } from '@/01-models/naidan-rpc';
import { toNaidanRpcConnectionId, toNaidanRpcPeerId } from '@/01-models/ids';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  } finally {
    vi.unstubAllGlobals();
  }
});
function endpoint() {
  const local = new Uint8Array(32).fill(1), remote = new Uint8Array(32).fill(2);
  const record: NaidanRpcConnection = {
    id: toNaidanRpcConnectionId({ raw: 'connection-lock-test' }),
    peerId: toNaidanRpcPeerId({ raw: encodePeerKey({ bytes: remote }) }),
    localPublicKey: encodePeerKey({ bytes: local }), label: 'Remote',
    transport: { type: 'naidan_piping_duplex', serverUrl: 'https://relay.invalid', headers: [] }, allowedMethods: [], revision: 0,
  };
  const released = Promise.withResolvers<void>();
  const retireResources = vi.fn(() => released.promise);
  const links: ReturnType<typeof transportPair>[] = [];
  const open = vi.fn<RpcManagerDependencies['open']>(async ({ signal }) => {
    signal.throwIfAborted();
    const pair = transportPair({ capacity: 2, fragmentBytes: 79 }), closed = Promise.withResolvers<void>();
    links.push(pair);
    const abort = () => {
      pair.close(); closed.resolve();
    };
    signal.addEventListener('abort', abort, { once: true });
    return { ...pair.a, closed: closed.promise, peerIdentity: remote, abort } satisfies RpcLink;
  });
  const manager = new NaidanPeerManager({ dependencies: {
    storage: { readIdentity: async () => undefined, list: async () => [record], remember: async () => {}, update: async ({ connection }) => connection.revision, remove: async () => {} },
    // Lock ownership is production code. Identity/native/transport/storage are
    // deliberate fixtures: this is not a multiple-browser integration test.
    identity: async () => ({ publicKey: local, privateKey: {} as CryptoKey }),
    acquireOwner: acquireRpcOwner, open, retireResources, changed: () => {},
    inference: {
      inputBudget: createInferenceBudget({ capacity: 1024 }), deliveryBudget: createInferenceBudget({ capacity: 1024 }),
      resources: { listChatModels: async () => [], listImageModels: async () => [],
        generateChat: async () => ({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' }),
        generateImage: async () => {
          throw new Error('Not used');
        },
      },
    },
  } });
  cleanups.push(async () => {
    released.resolve(); for (const pair of links) pair.close();
    await manager.setEnabled({ enabled: false });
  });
  return { manager, record, open, released, retireResources };
}

it('keeps the real owner lease while resources retire and rejects another conditional manager', async () => {
  const native = createWebLocksFixture(), a = endpoint(), b = endpoint();
  await Promise.all([a.manager.setEnabled({ enabled: true }), b.manager.setEnabled({ enabled: true })]);
  await Promise.all([a.manager.reload(), b.manager.reload()]);
  expect(native.request).not.toHaveBeenCalled();
  const first = a.manager.connect({ id: a.record.id });
  await vi.waitFor(() => expect(native.request).toHaveBeenCalledTimes(1)); native.dispatch(); await first;
  expect(a.open).toHaveBeenCalledOnce(); expect(native.held()).toBe(true);
  const stop = a.manager.setEnabled({ enabled: false });
  await vi.waitFor(() => expect(a.retireResources).toHaveBeenCalledOnce());
  expect(native.held()).toBe(true);
  const blocked = b.manager.connect({ id: b.record.id }); const rejected = expect(blocked).rejects.toThrow('another tab');
  await vi.waitFor(() => expect(native.request).toHaveBeenCalledTimes(2)); native.dispatch(); await rejected;
  expect(b.open).not.toHaveBeenCalled(); expect(native.held()).toBe(true);
  a.released.resolve(); await stop; await vi.waitFor(() => expect(native.held()).toBe(false));
  const next = b.manager.connect({ id: b.record.id });
  await vi.waitFor(() => expect(native.request).toHaveBeenCalledTimes(3)); native.dispatch(); await next;
  expect(b.open).toHaveBeenCalledOnce(); expect(native.held()).toBe(true);
  b.released.resolve(); await b.manager.setEnabled({ enabled: false });
  await vi.waitFor(() => expect(native.held()).toBe(false));
});

it('OFF waits for an abandoned late lock grant without creating a transport', async () => {
  const native = createWebLocksFixture(), a = endpoint();
  a.released.resolve();
  await a.manager.setEnabled({ enabled: true }); await a.manager.reload();
  const start = a.manager.connect({ id: a.record.id }), failed = expect(start).rejects.toBeDefined();
  await vi.waitFor(() => expect(native.request).toHaveBeenCalledOnce());
  const stop = a.manager.setEnabled({ enabled: false }); let stopped = false;
  void stop.then(() => {
    stopped = true;
  });
  await Promise.resolve(); expect(stopped).toBe(false); expect(a.open).not.toHaveBeenCalled();
  native.dispatch(); await failed; await stop;
  expect(a.open).not.toHaveBeenCalled(); expect(a.manager.list()[0]?.phase).toBe('disconnected');
  await vi.waitFor(() => expect(native.held()).toBe(false));
});

export const TEST_ONLY = {
};

it('OFF keeps a granted lease while the awaiting starter and resources retire', async () => {
  const native = createWebLocksFixture(), a = endpoint();
  await a.manager.setEnabled({ enabled: true }); await a.manager.reload();
  const start = a.manager.connect({ id: a.record.id }), failed = expect(start).rejects.toBeDefined();
  await vi.waitFor(() => expect(native.request).toHaveBeenCalledOnce());
  // The lock callback has resolved its lease, but ensureOwner has not resumed.
  native.dispatch();
  const stopped = a.manager.setEnabled({ enabled: false });
  await failed; await vi.waitFor(() => expect(a.retireResources).toHaveBeenCalledOnce());
  expect(native.held()).toBe(true); expect(a.open).not.toHaveBeenCalled();
  a.released.resolve(); await stopped;
  await vi.waitFor(() => expect(native.held()).toBe(false));
});
