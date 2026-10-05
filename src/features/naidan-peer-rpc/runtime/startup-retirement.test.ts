import type { NaidanRpcRegistryAccess } from '@/00-storage/service/naidan-rpc';
import { expect, it, vi } from 'vitest';
import { NaidanPeerManager } from './manager';
import type { RpcLink, RpcManagerDependencies } from './manager';
import { encodePeerKey } from './identity';
import { createInferenceBudget } from '@/features/naidan-peer-rpc/handlers/inference/budget';
import { toNaidanRpcConnectionId, toNaidanRpcPeerId } from '@/01-models/ids';
import type { NaidanRpcConnection } from '@/01-models/naidan-rpc';

const registryAccess: NaidanRpcRegistryAccess = { providerGeneration: 1, registryId: undefined, persistence: 'durable' };

it.each(['connect', 'pair'] as const)('retains cleanup failure of a late %s link and does not return its owner lease', async mode => {
  const local = new Uint8Array(32).fill(1), remote = new Uint8Array(32).fill(2);
  const record: NaidanRpcConnection = { id: toNaidanRpcConnectionId({ raw: 'late-startup-connection' }),
    peerId: toNaidanRpcPeerId({ raw: encodePeerKey({ bytes: remote }) }), autoConnect: 'disabled', localPublicKey: encodePeerKey({ bytes: local }), label: 'Peer',
    transport: { type: 'naidan_piping_duplex', serverUrl: 'https://relay.invalid', headers: [] }, allowedMethods: [], revision: 0 };
  const opening = Promise.withResolvers<RpcLink>(), linkClosed = Promise.withResolvers<void>();
  const open = vi.fn(() => opening.promise), release = vi.fn(), failure = new Error('Unaccepted link cleanup failed');
  const abort = vi.fn(() => {
    throw failure;
  });
  const resourcesDone = Promise.withResolvers<void>(), retireResources = vi.fn(() => resourcesDone.promise);
  const dependencies: RpcManagerDependencies = {
    storage: { readIdentity: async () => undefined, list: async () => ({ access: registryAccess, connections: [record] }), remember: async () => registryAccess, update: async ({ connection }) => connection.revision, remove: async () => {} },
    identity: async () => ({ publicKey: local, privateKey: {} as CryptoKey }), acquireOwner: async () => ({ release }), open,
    inference: { inputBudget: createInferenceBudget({ capacity: 1024 }), deliveryBudget: createInferenceBudget({ capacity: 1024 }),
      resources: { listChatModels: async () => [], listImageModels: async () => [],
        generateChat: async () => ({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' }),
        generateImage: async () => {
          throw new Error('Not used');
        } } },
    retireResources, changed: () => {},
  };
  const manager = new NaidanPeerManager({ dependencies });
  try {
    await manager.setEnabled({ enabled: true }); await manager.reload();
    const start = (() => {
      switch (mode) {
      case 'connect': return manager.connect({ id: record.id });
      case 'pair': return manager.pair({ settings: record.transport, code: '0042', role: 'initiator', verifyPeer: async () => true, signal: new AbortController().signal });
      default: { const exhaustive: never = mode; throw new Error(String(exhaustive)); }
      }
    })();
    void start.catch(() => {});
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    const stopping = manager.setEnabled({ enabled: false }); let settled = false;
    void stopping.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    opening.resolve({ peerIdentity: remote, incomingStreams: { async *[Symbol.asyncIterator]() {} }, closed: linkClosed.promise,
      openStream: async () => {
        throw new Error('Not used');
      }, abort });
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
    expect(settled).toBe(false); expect(retireResources).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
    linkClosed.resolve();
    await vi.waitFor(() => expect(retireResources).toHaveBeenCalledOnce());
    expect(settled).toBe(false); resourcesDone.resolve();
    await expect(stopping).rejects.toBe(failure); await expect(start).rejects.toBeDefined();
    await expect(manager.setEnabled({ enabled: false })).rejects.toBe(failure); expect(release).not.toHaveBeenCalled();
  } finally {
    linkClosed.resolve(); resourcesDone.resolve(); await manager.setEnabled({ enabled: false }).catch(() => {});
  }
});
