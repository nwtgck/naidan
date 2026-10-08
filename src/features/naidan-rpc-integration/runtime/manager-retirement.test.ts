import type { NaidanRpcRegistryAccess } from '@/00-storage/service/naidan-rpc';
import { expect, it, vi } from 'vitest';
import { NaidanPeerManager } from './manager';
import type { RpcLink } from './manager';
import type { NaidanRpcDuplex } from '@/features/naidan-rpc/transport';
import { encodePeerKey } from './identity';
import { transportPair } from '@/features/naidan-rpc/test-transport';
import { createInferenceBudget } from '@/features/naidan-rpc-integration/handlers/inference/budget';
import { toNaidanRpcRegistrationId, toNaidanRpcPeerPublicKey } from '@/01-models/ids';
import type { NaidanRpcRegistration } from '@/01-models/naidan-rpc';

const registryAccess: NaidanRpcRegistryAccess = { providerGeneration: 1, registryId: undefined, persistence: 'durable' };

function fixture({ cleanupFailure, count, incoming, onAbort }: { cleanupFailure: Error | undefined, count: number; incoming?: Promise<NaidanRpcDuplex>; onAbort?: () => void }) {
  const local = new Uint8Array(32).fill(1);
  const records: NaidanRpcRegistration[] = Array.from({ length: count }, (_, index) => ({
    id: toNaidanRpcRegistrationId({ raw: `registration-${index}` }),
    peerPublicKey: toNaidanRpcPeerPublicKey({ raw: encodePeerKey({ bytes: new Uint8Array(32).fill(index + 2) }) }),
    connectOnStartup: 'disabled',
    localPublicKey: encodePeerKey({ bytes: local }),
    label: `Peer ${index}`,
    transport: { type: 'naidan_piping_duplex', serverUrl: 'https://relay.invalid', headers: [] },
    inboundAllowedMethods: [],
    revision: 0,
  }));
  const links: { pair: ReturnType<typeof transportPair>, closed: ReturnType<typeof Promise.withResolvers<void>>, abort: ReturnType<typeof vi.fn<() => void>> }[] = [];
  const release = vi.fn(), retireResources = vi.fn(async () => {});
  const manager = new NaidanPeerManager({
    dependencies: {
      storage: { readIdentity: async () => undefined, list: async () => ({ access: registryAccess, registrations: records }), remember: async () => registryAccess, update: async ({ registration }) => registration.revision, remove: async () => {} },
      identity: async () => ({ privateKey: {} as CryptoKey, publicKey: local }),
      acquireOwner: async () => ({ release }),
      open: async () => {
        const index = links.length, pair = transportPair({ capacity: 2, fragmentBytes: 79 }), closed = Promise.withResolvers<void>();
        const abort = vi.fn(() => {
          pair.close(); onAbort?.();
        });
        links.push({ pair, closed, abort });
        const input = pair.a.incomingStreams[Symbol.asyncIterator](); let delivered = false;
        return {
          ...pair.a,
          closed: closed.promise,
          peerIdentity: new Uint8Array(32).fill(index + 2),
          abort,
          incomingStreams: {
            [Symbol.asyncIterator]() {
              return {
                next: () => {
                  if (incoming && !delivered) {
                    delivered = true; return incoming.then(value => ({ done: false as const, value }));
                  }
                  return input.next();
                },
                async return() {
                  const result = await input.return?.();
                  if (index === 0 && cleanupFailure) throw cleanupFailure;
                  return result ?? { done: true as const, value: undefined };
                },
              };
            },
          },
        } satisfies RpcLink;
      },
      inference: {
        inputBudget: createInferenceBudget({ capacity: 1024 }),
        deliveryBudget: createInferenceBudget({ capacity: 1024 }),
        resources: {
          listChatModels: async () => [],
          listImageModels: async () => [],
          generateChat: async () => ({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' }),
          generateImage: async () => {
            throw new Error('Not executed');
          },
        },
      },
      changed: () => {},
      retireResources,
    },
  });
  return {
    manager,
    records,
    links,
    release,
    retireResources,
    async cleanup() {
      for (const { pair, closed } of links) {
        pair.close(); closed.resolve();
      }
      await manager.setEnabled({ enabled: false }).catch(() => {});
    },
  };
}

it('finishes management teardown after the lower connection ends itself', async () => {
  const state = fixture({ cleanupFailure: undefined, count: 1 });
  try {
    await state.manager.setEnabled({ enabled: true }); await state.manager.reload();
    await state.manager.connect({ id: state.records[0]!.id });
    state.links[0]!.pair.close(); state.links[0]!.closed.resolve();
    await vi.waitFor(() => expect(state.manager.list()[0]?.phase).toBe('disconnected'), { timeout: 300 });
    expect(() => state.manager.client({ id: state.records[0]!.id })).toThrow('Connect explicitly');
  } finally {
    await state.cleanup();
  }
});

it('does not finish disconnect on RPC cleanup failure before the borrowed link is closed', async () => {
  const failure = new Error('Iterator cleanup failed'), state = fixture({ cleanupFailure: failure, count: 1 });
  try {
    await state.manager.setEnabled({ enabled: true }); await state.manager.reload();
    const id = state.records[0]!.id; await state.manager.connect({ id });
    const stopping = state.manager.disconnect({ id }); let settled = false;
    void stopping.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    state.links[0]!.closed.resolve();
    await expect(stopping).rejects.toBe(failure);
    expect(state.manager.list()[0]?.phase).toBe('stopping');
    expect(state.release).not.toHaveBeenCalled();
  } finally {
    await state.cleanup();
  }
});

it('master OFF joins every link and resource before returning a retained cleanup failure', async () => {
  const failure = new Error('First link cleanup failed'), state = fixture({ cleanupFailure: failure, count: 2 });
  const resourceEnd = Promise.withResolvers<void>(); state.retireResources.mockReturnValue(resourceEnd.promise);
  try {
    await state.manager.setEnabled({ enabled: true }); await state.manager.reload();
    for (const registration of state.records) await state.manager.connect({ id: registration.id });
    const stopping = state.manager.setEnabled({ enabled: false }); let settled = false;
    void stopping.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    state.links[0]!.closed.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false); expect(state.retireResources).not.toHaveBeenCalled();
    state.links[1]!.closed.resolve();
    await vi.waitFor(() => expect(state.retireResources).toHaveBeenCalledOnce());
    expect(settled).toBe(false); expect(state.release).not.toHaveBeenCalled();
    resourceEnd.resolve();
    await expect(stopping).rejects.toBe(failure);
    await expect(state.manager.setEnabled({ enabled: false })).rejects.toBe(failure);
    expect(state.release).not.toHaveBeenCalled();
  } finally {
    resourceEnd.resolve(); await state.cleanup();
  }
});

it('publishes one disconnect barrier before synchronous cancellation observers reenter', async () => {
  const state = fixture({ cleanupFailure: undefined, count: 1 });
  try {
    await state.manager.setEnabled({ enabled: true }); await state.manager.reload();
    const id = state.records[0]!.id; await state.manager.connect({ id });
    let reentered: Promise<void> | undefined;
    state.manager.bindClient({ id }).signal.addEventListener('abort', () => {
      reentered = state.manager.disconnect({ id });
    }, { once: true });
    const stopping = state.manager.disconnect({ id });
    expect(reentered).toBe(stopping); expect(state.links[0]!.abort).toHaveBeenCalledOnce();
    state.links[0]!.closed.resolve(); await stopping;
  } finally {
    await state.cleanup();
  }
});

it('a synchronous link abort failure still waits for that link and remains a disconnect failure', async () => {
  const state = fixture({ cleanupFailure: undefined, count: 1 }), failure = new Error('Link abort failed');
  try {
    await state.manager.setEnabled({ enabled: true }); await state.manager.reload();
    const id = state.records[0]!.id; await state.manager.connect({ id });
    state.links[0]!.abort.mockImplementation(() => {
 state.links[0]!.pair.close(); throw failure;
    });
    let stopping: Promise<void> | undefined;
    expect(() => {
      stopping = state.manager.disconnect({ id });
    }).not.toThrow();
    const retiring = stopping!; let settled = false;
    void retiring.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 0)); expect(settled).toBe(false);
    state.links[0]!.closed.resolve(); await expect(retiring).rejects.toBe(failure);
    await expect(state.manager.disconnect({ id })).rejects.toBe(failure);
    expect(state.release).not.toHaveBeenCalled();
  } finally {
    await state.cleanup();
  }
});

it('publishes one master OFF barrier before synchronous link abort observers reenter', async () => {
  const state = fixture({ cleanupFailure: undefined, count: 2 });
  const resourceEnd = Promise.withResolvers<void>(); state.retireResources.mockReturnValue(resourceEnd.promise);
  try {
    await state.manager.setEnabled({ enabled: true }); await state.manager.reload();
    for (const registration of state.records) await state.manager.connect({ id: registration.id });
    let reentered: Promise<void> | undefined;
    state.links[0]!.abort.mockImplementation(() => {
      reentered = state.manager.setEnabled({ enabled: false }); state.links[0]!.pair.close();
    });
    const stopping = state.manager.setEnabled({ enabled: false });
    expect(reentered).toBe(stopping);
    for (const link of state.links) link.closed.resolve();
    await vi.waitFor(() => expect(state.retireResources).toHaveBeenCalledOnce());
    expect(state.release).not.toHaveBeenCalled(); resourceEnd.resolve(); await stopping;
    expect(state.release).toHaveBeenCalledOnce();
  } finally {
    resourceEnd.resolve(); await state.cleanup();
  }
});

it('a throwing link abort does not skip the other connection or resources on master OFF', async () => {
  const state = fixture({ cleanupFailure: undefined, count: 2 }), failure = new Error('Link abort failed');
  const resourceEnd = Promise.withResolvers<void>(); state.retireResources.mockReturnValue(resourceEnd.promise);
  try {
    await state.manager.setEnabled({ enabled: true }); await state.manager.reload();
    for (const registration of state.records) await state.manager.connect({ id: registration.id });
    state.links[0]!.abort.mockImplementation(() => {
 state.links[0]!.pair.close(); throw failure;
    });
    let stopping: Promise<void> | undefined;
    expect(() => {
      stopping = state.manager.setEnabled({ enabled: false });
    }).not.toThrow();
    const retiring = stopping!; void retiring.catch(() => {});
    expect(state.links[1]!.abort).toHaveBeenCalledOnce();
    for (const link of state.links) link.closed.resolve();
    await vi.waitFor(() => expect(state.retireResources).toHaveBeenCalledOnce());
    resourceEnd.resolve(); await expect(retiring).rejects.toBe(failure);
    expect(state.release).not.toHaveBeenCalled();
  } finally {
    resourceEnd.resolve(); await state.cleanup();
  }
});

export const TEST_ONLY = {
};

it('RPC logical end starts manager transport abort before held raw cleanup can retire', async () => {
  const incoming = Promise.withResolvers<NaidanRpcDuplex>(), releaseAbort = Promise.withResolvers<void>();
  const abortStarted = Promise.withResolvers<void>(), cleanupFailed = new Error('Incoming cancel failed');
  const state = fixture({
    cleanupFailure: undefined,
    count: 1,
    incoming: incoming.promise,
    onAbort() {
      abortStarted.resolve(); releaseAbort.resolve();
    },
  });
  const readable = new ReadableStream<Uint8Array>({
    cancel() {
      throw cleanupFailed;
    },
  });
  const getReader = readable.getReader.bind(readable);
  vi.spyOn(readable, 'getReader').mockImplementationOnce(() => {
    throw new TypeError('Adoption rejected');
  }).mockImplementation(getReader);
  const writable = new WritableStream<Uint8Array>({
    abort() {
      return releaseAbort.promise;
    },
  });
  try {
    await state.manager.setEnabled({ enabled: true }); await state.manager.reload();
    const id = state.records[0]!.id; await state.manager.connect({ id });
    incoming.resolve({ readable, writable, closed: new Promise(() => {}), abort() {} });
    // Only manager transport abort opens releaseAbort; waiting on the old
    // receive-loop closed promise would deadlock before this signal.
    await abortStarted.promise;
    expect(state.links[0]!.abort).toHaveBeenCalledOnce();
    const retiring = state.manager.disconnect({ id });
    state.links[0]!.closed.resolve();
    await expect(retiring).rejects.toBe(cleanupFailed);
    expect(readable.locked).toBe(false); expect(writable.locked).toBe(false);
    expect(state.release).not.toHaveBeenCalled();
  } finally {
    releaseAbort.resolve(); await state.cleanup();
  }
});
