import { ResponseUnconfirmedError } from '@/features/naidan-piping-duplex';
import { HandshakeResponseUnconfirmedError } from '@/features/naidan-piping-duplex';
import { createRpcStopControl } from './stop-control';
import type { RpcControlMessage } from './stop-control';
import { afterEach, expect, it, vi } from 'vitest';
import { NaidanPeerManager } from './manager';
import type { RpcManagerDependencies, RpcLink } from './manager';
import { encodePeerKey } from './identity';
import { transportPair } from '@/features/naidan-rpc/test-transport';
import { createInferenceBudget } from '@/features/naidan-rpc-integration/handlers/inference/budget';
import type { NaidanRpcRegistration } from '@/01-models/naidan-rpc';
import type { NaidanRpcStorage, NaidanRpcRegistryAccess, NaidanRpcRegistrySnapshot } from '@/00-storage/service/naidan-rpc';
import { toNaidanRpcRegistrationId, toNaidanRpcPeerPublicKey, toNaidanRpcRegistryId } from '@/01-models/ids';
import type { ReadOnlyInferenceResources } from '@/features/naidan-rpc-integration/handlers/inference/resources';
import { createRpcProtocolAdvertisement, NaidanRpcProtocolError, expose, NaidanRpcPeer } from '@/features/naidan-rpc';
import { describePeerMethods, naidanPeerContract } from '@/features/naidan-rpc-integration/contract';
import { createNaidanPeerImplementation } from '@/features/naidan-rpc-integration/implementation';
import { RpcOwnerBusyError } from './owner';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers(); vi.restoreAllMocks();
});

const local = new Uint8Array(32).fill(1), remote = new Uint8Array(32).fill(2);
const transport = { type: 'naidan_piping_duplex' as const, serverUrl: 'https://relay.invalid', headers: [] };
const record: NaidanRpcRegistration = {
  id: toNaidanRpcRegistrationId({ raw: 'registration-1' }),
  peerPublicKey: toNaidanRpcPeerPublicKey({ raw: encodePeerKey({ bytes: remote }) }),
  connectOnStartup: 'disabled',
  localPublicKey: encodePeerKey({ bytes: local }),
  label: 'Peer',
  transport,
  inboundAllowedMethods: [],
  revision: 0,
};
const registryAccess: NaidanRpcRegistryAccess = {
  providerGeneration: 1,
  registryId: toNaidanRpcRegistryId({ raw: 'registry-example' }),
  persistence: 'durable',
};
function snapshot({ registrations }: { registrations: NaidanRpcRegistration[] }): NaidanRpcRegistrySnapshot {
  return { access: registryAccess, registrations };
}
function fixture() {
  const links: ReturnType<typeof transportPair>[] = [];
  const resources: ReadOnlyInferenceResources = {
    listChatModels: vi.fn(async () => [{ ref: 'models/local.gguf', label: 'Local' }]),
    listImageModels: vi.fn(async () => []),
    generateChat: vi.fn(async () => ({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' as const })),
    generateImage: vi.fn(async () => {
      throw new Error('not used');
    }),
  };
  const storage: NaidanRpcStorage = {
    readIdentity: vi.fn(async () => undefined),
    list: vi.fn(async () => snapshot({ registrations: [{ ...record }] })),
    remember: vi.fn(async () => registryAccess),
    update: vi.fn(async ({ registration }) => registration.revision),
    remove: vi.fn(async () => {}),
  };
  const release = vi.fn();
  const dependencies: RpcManagerDependencies = {
    storage,
    identity: vi.fn(async () => ({ privateKey: {} as CryptoKey, publicKey: local })),
    acquireOwner: vi.fn(async () => ({ release })),
    open: vi.fn(async ({ signal }) => {
      const pair = transportPair({ capacity: 8, fragmentBytes: 256 }); links.push(pair);
      const closed = Promise.withResolvers<void>();
      const abort = () => {
        pair.close(); closed.resolve();
      };
      signal.addEventListener('abort', abort, { once: true });
      return { ...pair.a, closed: closed.promise, peerIdentity: remote, abort } satisfies RpcLink;
    }),
    inference: { resources, inputBudget: createInferenceBudget({ capacity: 256 * 1024 * 1024 }), deliveryBudget: createInferenceBudget({ capacity: 128 * 1024 * 1024 }) },
    changed: vi.fn(),
    retireResources: vi.fn(async () => {}),
  };
  const manager = new NaidanPeerManager({ dependencies });
  cleanups.push(async () => {
    for (const pair of links) pair.close(); await manager.setEnabled({ enabled: false });
  });
  return { manager, dependencies, storage, links, release, resources };
}
function automaticFixture() {
  vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const result = fixture(); let stored: NaidanRpcRegistration = { ...record, connectOnStartup: 'enabled' };
  vi.mocked(result.storage.list).mockImplementation(async () => snapshot({ registrations: [stored] }));
  vi.mocked(result.storage.readIdentity).mockResolvedValue({ privateKey: {} as CryptoKey, publicKey: record.localPublicKey });
  vi.mocked(result.storage.update).mockImplementation(async ({ registration }) => {
    stored = registration; return registration.revision;
  });
  return result;
}

it('joins a response-unconfirmed session before automatically reconnecting without replaying inference', async () => {
  const { manager, dependencies, links, resources } = automaticFixture();
  const original = vi.mocked(dependencies.open).getMockImplementation();
  if (!original) throw new Error('Missing opener');
  const retired = Promise.withResolvers<void>(), ended = Promise.withResolvers<{ error: unknown }>(); let aborted = false;
  vi.mocked(dependencies.open).mockImplementationOnce(async args => {
    const link = await original(args);
    return {
      ...link,
      closed: retired.promise,
      ended: ended.promise,
      abort: args => {
        aborted = true; link.abort(args);
      },
    };
  });
  await manager.setEnabled({ enabled: true }); await manager.startAutomaticConnections(); await vi.advanceTimersByTimeAsync(0);
  const binding = manager.bindClient({ id: record.id });
  await vi.advanceTimersByTimeAsync(75_000); expect(aborted).toBe(false);
  ended.resolve({ error: new ResponseUnconfirmedError() }); await vi.advanceTimersByTimeAsync(0);
  expect(aborted).toBe(true); expect(binding.signal.aborted).toBe(true); expect(manager.list()[0]?.phase).toBe('stopping');
  expect(dependencies.open).toHaveBeenCalledTimes(1);
  for (const method of Object.values(resources)) expect(method).not.toHaveBeenCalled();
  retired.resolve(); await vi.advanceTimersByTimeAsync(0); expect(dependencies.open).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(dependencies.open).toHaveBeenCalledTimes(2); expect(links).toHaveLength(2); expect(manager.list()[0]?.phase).toBe('connected');
  expect(manager.bindClient({ id: record.id }).signal).not.toBe(binding.signal);
});

it('keeps the manual page pause when disconnect wins a response-failure retirement race', async () => {
  const { manager, dependencies } = automaticFixture();
  const original = vi.mocked(dependencies.open).getMockImplementation(); if (!original) throw new Error('Missing opener');
  const retired = Promise.withResolvers<void>(), ended = Promise.withResolvers<{ error: unknown }>();
  vi.mocked(dependencies.open).mockImplementationOnce(async args => ({
    ...await original(args),
    closed: retired.promise,
    ended: ended.promise,
  }));
  await manager.setEnabled({ enabled: true }); await manager.startAutomaticConnections(); await vi.advanceTimersByTimeAsync(0);
  ended.resolve({ error: new ResponseUnconfirmedError() }); await vi.advanceTimersByTimeAsync(0); expect(manager.list()[0]?.phase).toBe('stopping');
  const stopped = manager.disconnect({ id: record.id }); retired.resolve(); await stopped;
  await vi.advanceTimersByTimeAsync(120000); expect(dependencies.open).toHaveBeenCalledTimes(1);
  expect(manager.list()[0]).toMatchObject({ phase: 'disconnected', registration: { connectOnStartup: 'enabled' } });
});

it('automatic startup restores a pinned saved identity without providing or replaying inference', async () => {
  const { manager, dependencies, resources } = automaticFixture();
  await manager.setEnabled({ enabled: true }); await manager.startAutomaticConnections(); await vi.advanceTimersByTimeAsync(0);
  expect(manager.list()[0]?.phase).toBe('connected'); expect(dependencies.identity).toHaveBeenCalledOnce();
  expect(manager.list()[0]?.access.effective).toEqual([]); expect(resources.generateChat).not.toHaveBeenCalled(); expect(resources.generateImage).not.toHaveBeenCalled();
});

it('does not generate a replacement identity or retry a missing saved key automatically', async () => {
  const { manager, dependencies, storage } = automaticFixture(); vi.mocked(storage.readIdentity).mockResolvedValue(undefined);
  await manager.setEnabled({ enabled: true }); await manager.startAutomaticConnections(); await vi.advanceTimersByTimeAsync(60000);
  expect(storage.readIdentity).toHaveBeenCalledOnce(); expect(dependencies.identity).not.toHaveBeenCalled(); expect(dependencies.open).not.toHaveBeenCalled();
});

it('does not restart automatic policy after its pending registry read is stopped', async () => {
  const { manager, storage, dependencies } = automaticFixture(); const gate = Promise.withResolvers<NaidanRpcRegistrySnapshot>();
  vi.mocked(storage.list).mockReturnValueOnce(gate.promise);
  await manager.setEnabled({ enabled: true }); const starting = manager.startAutomaticConnections();
  manager.stopAutomaticConnections(); gate.resolve(snapshot({ registrations: [{ ...record, connectOnStartup: 'enabled' }] }));
  await starting; await vi.advanceTimersByTimeAsync(60000); expect(dependencies.identity).not.toHaveBeenCalled(); expect(dependencies.open).not.toHaveBeenCalled();
});

it('does not silently enable automatic policy when its ON save fails', async () => {
  const { manager, storage, dependencies } = automaticFixture();
  vi.mocked(storage.list).mockResolvedValue(snapshot({ registrations: [record] }));
  await manager.setEnabled({ enabled: true }); await manager.startAutomaticConnections();
  vi.mocked(storage.update).mockRejectedValueOnce(new Error('quota'));
  await expect(manager.setConnectOnStartup({ id: record.id, connectOnStartup: 'enabled' })).rejects.toThrow('quota');
  await vi.advanceTimersByTimeAsync(60000); expect(manager.list()[0]?.registration.connectOnStartup).toBe('disabled'); expect(dependencies.open).not.toHaveBeenCalled();
});

it('waits for another tab owner and retries conditionally without opening an unowned transport', async () => {
  const { manager, dependencies } = automaticFixture();
  vi.mocked(dependencies.acquireOwner).mockRejectedValueOnce(new RpcOwnerBusyError());
  await manager.setEnabled({ enabled: true }); await manager.startAutomaticConnections(); await vi.advanceTimersByTimeAsync(0);
  expect(manager.list()[0]?.failure).toBeUndefined(); expect(dependencies.open).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(999); expect(dependencies.acquireOwner).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(dependencies.acquireOwner).toHaveBeenCalledTimes(2); expect(manager.list()[0]?.phase).toBe('connected');
});

it('reconnects after physical closure and never changes a caller binding to the new session', async () => {
  const { manager, dependencies, links } = automaticFixture();
  await manager.setEnabled({ enabled: true }); await manager.startAutomaticConnections(); await vi.advanceTimersByTimeAsync(0);
  const binding = manager.bindClient({ id: record.id }); links[0]!.close(); await vi.advanceTimersByTimeAsync(1000);
  expect(binding.signal.aborted).toBe(true); expect(dependencies.open).toHaveBeenCalledTimes(2);
  const next = manager.bindClient({ id: record.id }); expect(next.signal).not.toBe(binding.signal); expect(next.signal.aborted).toBe(false);
});

it('manual disconnect pauses this page but retains the startup setting for the next reload', async () => {
  const { manager, dependencies } = automaticFixture();
  await manager.setEnabled({ enabled: true }); await manager.startAutomaticConnections(); await vi.advanceTimersByTimeAsync(0);
  await manager.disconnect({ id: record.id }); await manager.startAutomaticConnections(); await vi.advanceTimersByTimeAsync(60000);
  expect(manager.list()[0]?.registration.connectOnStartup).toBe('enabled'); expect(dependencies.open).toHaveBeenCalledOnce();
  await manager.connect({ id: record.id }); expect(dependencies.open).toHaveBeenCalledTimes(2);
});

it('stops automatic retries on unknown failures rather than matching native error text', async () => {
  const { manager, dependencies } = automaticFixture(); vi.mocked(dependencies.open).mockRejectedValue(new Error('transient network identity mismatch'));
  await manager.setEnabled({ enabled: true }); await manager.startAutomaticConnections(); await vi.advanceTimersByTimeAsync(60000);
  expect(dependencies.open).toHaveBeenCalledOnce(); expect(manager.list()[0]?.failure).toBe('RPC connection could not be established');
});

it('a failed startup preference save does not clear current connection desire', async () => {
  const { manager, storage, dependencies, links } = automaticFixture();
  await manager.setEnabled({ enabled: true }); await manager.startAutomaticConnections(); await vi.advanceTimersByTimeAsync(0);
  vi.mocked(storage.update).mockRejectedValueOnce(new Error('quota'));
  await expect(manager.setConnectOnStartup({ id: record.id, connectOnStartup: 'disabled' })).rejects.toThrow('quota');
  expect(manager.list()[0]?.registration.connectOnStartup).toBe('enabled'); expect(manager.list()[0]?.phase).toBe('connected');
  links[0]!.close(); await vi.advanceTimersByTimeAsync(60000); expect(dependencies.open).toHaveBeenCalledTimes(2);
  expect(manager.list()[0]?.desiredConnection).toBe('connected');
});

it('bounds concurrent automatic attempts independently of the maximum saved record count', async () => {
  const { manager, dependencies, storage } = automaticFixture();
  const records = Array.from({ length: 6 }, (_, index) => ({
    ...record,
    connectOnStartup: 'enabled' as const,
    id: toNaidanRpcRegistrationId({ raw: `automatic-record-${index}` }),
    transport: { ...transport, serverUrl: `https://piping-${index}.example` },
  }));
  vi.mocked(storage.list).mockResolvedValue(snapshot({ registrations: records }));
  vi.mocked(dependencies.open).mockImplementation(({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await manager.setEnabled({ enabled: true }); await manager.startAutomaticConnections(); await vi.advanceTimersByTimeAsync(60000);
  expect(dependencies.open).toHaveBeenCalledTimes(4);
  await manager.setEnabled({ enabled: false }); await vi.advanceTimersByTimeAsync(60000); expect(dependencies.open).toHaveBeenCalledTimes(4);
});

it('adopts external display metadata without closing a live session or confirming a failed restriction', async () => {
  const { manager, storage } = fixture(); const initial = { ...record, inboundAllowedMethods: ['generateChat'] };
  vi.mocked(storage.list).mockResolvedValue(snapshot({ registrations: [initial] }));
  await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const binding = manager.bindClient({ id: record.id }); vi.mocked(storage.update).mockRejectedValueOnce(new Error('quota'));
  await expect(manager.updateInboundAllowedMethods({ id: record.id, inboundAllowedMethods: [] })).rejects.toThrow('quota');
  vi.mocked(storage.list).mockResolvedValue(snapshot({ registrations: [{ ...initial, label: 'New name', revision: 1 }] }));
  await manager.revalidate(); expect(binding.signal.aborted).toBe(false);
  expect(manager.list()[0]).toMatchObject({ phase: 'connected', registration: { label: 'New name', revision: 1 }, access: { effective: [], saved: ['generateChat'], persistence: 'failed', revision: 1 } });
});

it('retires a live session when its registry is replaced even if the record and revision are identical', async () => {
  const { manager, storage } = fixture();
  await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const binding = manager.bindClient({ id: record.id });
  const replacedAccess = { ...registryAccess, registryId: toNaidanRpcRegistryId({ raw: 'replacement-registry' }) };
  vi.mocked(storage.list).mockResolvedValue({ access: replacedAccess, registrations: [record] });
  await manager.revalidate(); expect(binding.signal.aborted).toBe(true);
  await vi.waitFor(() => expect(manager.list()[0]?.phase).toBe('disconnected'));
  await manager.reload(); await manager.rename({ id: record.id, label: 'New store' });
  expect(storage.update).toHaveBeenLastCalledWith(expect.objectContaining({ access: replacedAccess }));
});

it('loading records and enabling the feature never creates an identity or a connection', async () => {
  const { manager, dependencies } = fixture();
  await manager.reload(); await manager.setEnabled({ enabled: true });
  expect(manager.list()).toHaveLength(1); expect(dependencies.identity).not.toHaveBeenCalled(); expect(dependencies.open).not.toHaveBeenCalled();
  expect(() => manager.client({ id: record.id })).toThrow('Connect explicitly');
});

it('caller-only registrations start with no inbound authority', async () => {
  const { manager, resources, links } = fixture();
  await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const other = new NaidanRpcPeer({ transport: links[0]!.b, exports: [], limits: { maxCalls: 4, maxCallTimeoutMs: 1000 }, signal: new AbortController().signal });
  const denied = other.client({ contract: naidanPeerContract }).listChatModels({ input: {}, on: {}, signal: undefined, timeoutMs: 1000 });
  await expect(denied.result).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
  await expect(denied.closed).rejects.toBeDefined(); expect(resources.listChatModels).not.toHaveBeenCalled();
  await manager.updateInboundAllowedMethods({ id: record.id, inboundAllowedMethods: ['listChatModels'] });
  const accepted = other.client({ contract: naidanPeerContract }).listChatModels({ input: {}, on: {}, signal: undefined, timeoutMs: 1000 });
  const reader = (await accepted.result).getReader(); expect((await reader.read()).value?.ref).toBe('models/local.gguf');
  expect((await reader.read()).done).toBe(true); await accepted.closed; other.dispose();
});

it('repeated Connect coalesces without creating a second transport', async () => {
  const { manager, dependencies } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload();
  const first = manager.connect({ id: record.id });
  await expect(manager.connect({ id: record.id })).resolves.toBeUndefined(); await first;
  expect(dependencies.open).toHaveBeenCalledOnce();
});

it('a late identity load after OFF cannot publish or open a connection', async () => {
  const { manager, dependencies } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload();
  const gate = Promise.withResolvers<Awaited<ReturnType<RpcManagerDependencies['identity']>>>();
  vi.mocked(dependencies.identity).mockReturnValue(gate.promise);
  const start = manager.connect({ id: record.id }); const rejected = expect(start).rejects.toBeDefined();
  await vi.waitFor(() => expect(dependencies.identity).toHaveBeenCalledOnce());
  const stop = manager.setEnabled({ enabled: false }); gate.resolve({ privateKey: {} as CryptoKey, publicKey: local });
  await rejected; await stop; expect(dependencies.open).not.toHaveBeenCalled();
  expect(manager.list()[0]?.phase).toBe('disconnected');
});

it('successful pairing does not save trust, and closing the initiating UI does not disconnect it', async () => {
  const { manager, storage } = fixture(); await manager.setEnabled({ enabled: true });
  const ui = new AbortController();
  const id = await manager.pair({ settings: transport, code: '1234', verifyPeer: async () => true, signal: ui.signal });
  ui.abort(); expect(manager.list()[0]?.phase).toBe('connected');
  expect(storage.remember).not.toHaveBeenCalled(); expect(manager.list()[0]?.access.effective).toEqual([]);
  await manager.updateInboundAllowedMethods({ id, inboundAllowedMethods: ['generateChat'] });
  expect(storage.update).not.toHaveBeenCalled();
  await manager.remember({ id, label: undefined });
  expect(storage.remember).toHaveBeenCalledOnce(); expect(manager.list()[0]?.persistence).toBe('saved');
  await manager.disconnect({ id }); expect(manager.list()[0]?.phase).toBe('disconnected');
});

it('a temporary disconnected peer is not silently promoted to a remembered record', async () => {
  const { manager, storage } = fixture(); await manager.setEnabled({ enabled: true });
  const id = await manager.pair({ settings: transport, code: '1234', verifyPeer: async () => true, signal: new AbortController().signal });
  await manager.disconnect({ id }); expect(manager.list()).toEqual([]); expect(storage.remember).not.toHaveBeenCalled();
});

it('a failed trust save leaves the verified temporary registration usable', async () => {
  const { manager, storage } = fixture(); await manager.setEnabled({ enabled: true });
  const id = await manager.pair({ settings: transport, code: '1234', verifyPeer: async () => true, signal: new AbortController().signal });
  vi.mocked(storage.remember).mockRejectedValueOnce(new Error('quota'));
  await expect(manager.remember({ id, label: undefined })).rejects.toThrow('quota');
  expect(manager.list()[0]).toMatchObject({ phase: 'connected', persistence: 'temporary' });
  expect(() => manager.client({ id })).not.toThrow();
});

it('provides discovery with no inference grants and reports effective restrictions after a failed save', async () => {
  const { manager, storage, resources, links, dependencies } = fixture();
  vi.mocked(storage.list).mockResolvedValue(snapshot({ registrations: [{ ...record, inboundAllowedMethods: ['listChatModels'] }] }));
  await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const other = new NaidanRpcPeer({
    transport: links[0]!.b,
    exports: [expose({
      contract: naidanPeerContract,
      allowedMethods: ['getProvidedMethods'],
      implementation: createNaidanPeerImplementation({
        inference: dependencies.inference,
        providedMethods: () => ({ status: 'ready', methods: describePeerMethods({ names: ['listImageModels', 'generateImage'] }) }),
      }),
    })],
    limits: { maxCalls: 4, maxCallTimeoutMs: 1000 },
    signal: new AbortController().signal,
  });
  try {
    expect(await manager.getPeerProvidedMethods({ id: record.id, signal: new AbortController().signal })).toEqual({ status: 'ready', methods: describePeerMethods({ names: ['listImageModels', 'generateImage'] }) });
    vi.mocked(storage.update).mockRejectedValueOnce(new Error('quota'));
    await expect(manager.updateInboundAllowedMethods({ id: record.id, inboundAllowedMethods: [] })).rejects.toThrow('quota');
    expect(manager.list()[0]?.access.saved).toEqual(['listChatModels']);
    const discovery = other.client({ contract: naidanPeerContract }).getProvidedMethods({ input: {}, on: {}, signal: undefined, timeoutMs: 1000 });
    expect(await discovery.result).toEqual({ status: 'ready', methods: [] }); await discovery.closed;
    const checking = Promise.withResolvers<NaidanRpcRegistrySnapshot>(); vi.mocked(storage.list).mockReturnValueOnce(checking.promise);
    const validated = manager.revalidate();
    try {
      expect(() => manager.client({ id: record.id })).toThrow('verification');
      expect(await manager.getPeerProvidedMethods({ id: record.id, signal: new AbortController().signal })).toEqual({ status: 'ready', methods: describePeerMethods({ names: ['listImageModels', 'generateImage'] }) });
    } finally {
      checking.resolve(snapshot({ registrations: [{ ...record, inboundAllowedMethods: ['listChatModels'] }] })); await validated;
    }
    for (const resource of Object.values(resources)) expect(resource).not.toHaveBeenCalled();
    await manager.disconnect({ id: record.id });
    await expect(manager.getPeerProvidedMethods({ id: record.id, signal: new AbortController().signal })).rejects.toThrow();
  } finally {
    other.dispose();
  }
});

it('failed restriction persistence remains restricted on explicit reconnection', async () => {
  const { manager, storage } = fixture();
  vi.mocked(storage.list).mockResolvedValue(snapshot({ registrations: [{ ...record, inboundAllowedMethods: ['generateChat'] }] }));
  await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  vi.mocked(storage.update).mockRejectedValue(new Error('quota'));
  await expect(manager.updateInboundAllowedMethods({ id: record.id, inboundAllowedMethods: [] })).rejects.toThrow();
  await manager.disconnect({ id: record.id }); await manager.connect({ id: record.id });
  expect(manager.list()[0]?.access.effective).toEqual([]);
});

it('remembering and disconnecting concurrently preserves only the explicitly saved record', async () => {
  const { manager, storage } = fixture(); await manager.setEnabled({ enabled: true });
  const id = await manager.pair({ settings: transport, code: '1234', verifyPeer: async () => true, signal: new AbortController().signal });
  const gate = Promise.withResolvers<NaidanRpcRegistryAccess>(); vi.mocked(storage.remember).mockReturnValue(gate.promise);
  const save = manager.remember({ id, label: 'Saved' }); await vi.waitFor(() => expect(storage.remember).toHaveBeenCalledOnce());
  const stop = manager.disconnect({ id }); gate.resolve(registryAccess); await save; await stop;
  expect(manager.list()[0]).toMatchObject({ phase: 'disconnected', persistence: 'saved' });
});

it('same-peer same-origin duplicate registrations fail even with different header values', async () => {
  const { manager, dependencies, storage } = fixture();
  const other = { ...record, id: toNaidanRpcRegistrationId({ raw: 'registration-2' }), transport: { ...transport, headers: [{ name: 'X-Test', value: 'different' }] } };
  vi.mocked(storage.list).mockResolvedValue(snapshot({ registrations: [record, other] })); await manager.setEnabled({ enabled: true }); await manager.reload();
  await manager.connect({ id: record.id }); await expect(manager.connect({ id: other.id })).rejects.toThrow('already have');
  expect(dependencies.open).toHaveBeenCalledOnce();
});

it('unknown stored methods fail closed instead of becoming wildcard authority', async () => {
  const { manager, storage } = fixture(); vi.mocked(storage.list).mockResolvedValue(snapshot({ registrations: [{ ...record, inboundAllowedMethods: ['futureMethod'] }] }));
  await manager.reload(); expect(manager.list()[0]?.access.effective).toEqual([]); expect(manager.list()[0]?.failure).toContain('not supported');
});

it('transport key mismatch is rejected before publishing a connected row', async () => {
  const { manager, storage } = fixture(); vi.mocked(storage.list).mockResolvedValue(snapshot({ registrations: [{ ...record, peerPublicKey: toNaidanRpcPeerPublicKey({ raw: encodePeerKey({ bytes: new Uint8Array(32).fill(3) }) }) }] }));
  await manager.setEnabled({ enabled: true }); await manager.reload(); await expect(manager.connect({ id: record.id })).rejects.toThrow('identity changed');
  expect(manager.list()[0]?.phase).toBe('disconnected');
});

it('master OFF cancels calls and retains the owner until callee work actually retires', async () => {
  const { manager, release, links, dependencies } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const started = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
  vi.mocked(dependencies.inference.resources.listChatModels).mockImplementation(async () => {
    started.resolve(); await finished.promise; return [];
  });
  await manager.updateInboundAllowedMethods({ id: record.id, inboundAllowedMethods: ['listChatModels'] });
  const other = new NaidanRpcPeer({ transport: links[0]!.b, exports: [expose({ contract: naidanPeerContract, allowedMethods: [], implementation: createNaidanPeerImplementation({ providedMethods: () => ({ status: 'ready', methods: [] }), inference: dependencies.inference }) })], limits: { maxCalls: 4, maxCallTimeoutMs: undefined }, signal: new AbortController().signal });
  const call = other.client({ contract: naidanPeerContract }).listChatModels({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  const result = await call.result; const reader = result.getReader(); const reading = reader.read(); void reading.catch(() => {});
  await started.promise; const stopping = manager.setEnabled({ enabled: false });
  await Promise.resolve(); expect(release).not.toHaveBeenCalled();
  finished.resolve(); await stopping; expect(release).toHaveBeenCalledOnce();
  await expect(call.closed).rejects.toBeDefined(); other.dispose();
});

it('reserves a forgetting registration until the persistent deletion finishes', async () => {
  const { manager, storage, dependencies } = fixture();
  await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const deletion = Promise.withResolvers<void>();
  vi.mocked(storage.remove).mockReturnValue(deletion.promise);
  const forgetting = manager.forget({ id: record.id });
  try {
    await vi.waitFor(() => expect(storage.remove).toHaveBeenCalledOnce());
    await expect(manager.connect({ id: record.id })).rejects.toThrow();
    await expect(manager.edit({ id: record.id, label: 'Other', transport })).rejects.toThrow();
    await expect(manager.updateInboundAllowedMethods({ id: record.id, inboundAllowedMethods: ['generateImage'] })).rejects.toThrow();
    await expect(manager.forget({ id: record.id })).rejects.toThrow();
    expect(dependencies.open).toHaveBeenCalledOnce();
  } finally {
    deletion.resolve(); await forgetting;
  }
  expect(manager.list()).toEqual([]);
});

it('does not resurrect a forgotten registration from a read started before deletion', async () => {
  const { manager, storage } = fixture();
  await manager.setEnabled({ enabled: true }); await manager.reload();
  const read = Promise.withResolvers<NaidanRpcRegistrySnapshot>(); vi.mocked(storage.list).mockReturnValue(read.promise);
  const reload = manager.reload();
  await manager.forget({ id: record.id }); read.resolve(snapshot({ registrations: [record] })); await reload;
  expect(manager.list()).toEqual([]);
});

it('also invalidates a stale read started while persistent deletion is pending', async () => {
  const { manager, storage } = fixture();
  await manager.setEnabled({ enabled: true }); await manager.reload();
  const deletion = Promise.withResolvers<void>(); vi.mocked(storage.remove).mockReturnValue(deletion.promise);
  const forgetting = manager.forget({ id: record.id }); await vi.waitFor(() => expect(storage.remove).toHaveBeenCalledOnce());
  const read = Promise.withResolvers<NaidanRpcRegistrySnapshot>(); vi.mocked(storage.list).mockReturnValue(read.promise);
  const reload = manager.reload(); deletion.resolve(); await forgetting; read.resolve(snapshot({ registrations: [record] })); await reload;
  expect(manager.list()).toEqual([]);
});

it('only the latest concurrent catalogue request may add records', async () => {
  const { manager, storage } = fixture();
  const first = Promise.withResolvers<NaidanRpcRegistrySnapshot>(), second = Promise.withResolvers<NaidanRpcRegistrySnapshot>();
  vi.mocked(storage.list).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const older = manager.reload(), newer = manager.reload(); second.resolve(snapshot({ registrations: [] })); await newer; first.resolve(snapshot({ registrations: [record] })); await older;
  expect(manager.list()).toEqual([]);
});

it('failed deletion keeps a disconnected record and permits an explicit retry', async () => {
  const { manager, storage } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload();
  vi.mocked(storage.remove).mockRejectedValueOnce(new Error('Storage blocked'));
  await expect(manager.forget({ id: record.id })).rejects.toThrow('Storage blocked');
  expect(manager.list()[0]?.phase).toBe('disconnected');
  await manager.forget({ id: record.id }); expect(manager.list()).toEqual([]);
});

it('deletion waits for an already submitted grant write even on a disconnected record', async () => {
  const { manager, storage } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload();
  const written = Promise.withResolvers<number>(); vi.mocked(storage.update).mockReturnValue(written.promise);
  const changing = manager.updateInboundAllowedMethods({ id: record.id, inboundAllowedMethods: ['generateChat'] });
  await vi.waitFor(() => expect(storage.update).toHaveBeenCalledOnce());
  const forgetting = manager.forget({ id: record.id });
  try {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(storage.remove).not.toHaveBeenCalled();
  } finally {
    written.resolve(1); await changing; await forgetting;
  }
  expect(storage.remove).toHaveBeenCalledWith({ access: registryAccess, id: record.id, expectedRevision: 1 });
});

it('forgetting an active temporary registration does not wait for its own deletion', async () => {
  const { manager, storage } = fixture(); await manager.setEnabled({ enabled: true });
  const id = await manager.pair({ settings: transport, code: '1234', verifyPeer: async () => true, signal: new AbortController().signal });
  await manager.forget({ id }); expect(manager.list()).toEqual([]); expect(storage.remove).not.toHaveBeenCalled();
});

it('master OFF retains ownership until pending registry deletion settles', async () => {
  const { manager, storage, release } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload();
  const deletion = Promise.withResolvers<void>(); vi.mocked(storage.remove).mockReturnValue(deletion.promise);
  const forgetting = manager.forget({ id: record.id }); await vi.waitFor(() => expect(storage.remove).toHaveBeenCalledOnce());
  const stopping = manager.setEnabled({ enabled: false });
  try {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(release).not.toHaveBeenCalled();
  } finally {
    deletion.resolve(); await forgetting; await stopping;
  }
  expect(release).toHaveBeenCalledOnce();
});

it('master OFF retains ownership until a disconnected settings edit settles', async () => {
  const { manager, storage, release } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload();
  const written = Promise.withResolvers<number>(); vi.mocked(storage.update).mockReturnValue(written.promise);
  const editing = manager.edit({ id: record.id, label: 'Updated', transport }); await vi.waitFor(() => expect(storage.update).toHaveBeenCalledOnce());
  const stopping = manager.setEnabled({ enabled: false });
  try {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(release).not.toHaveBeenCalled();
  } finally {
    written.resolve(1); await editing; await stopping;
  }
  expect(release).toHaveBeenCalledOnce();
});

it('pins caller identity and lifetime to the original session across reconnect', async () => {
  const { manager } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const binding = manager.bindClient({ id: record.id }); expect(binding.registration).toEqual({ id: record.id, peerPublicKey: record.peerPublicKey, label: record.label });
  expect(Object.isFrozen(binding.registration)).toBe(true); await manager.disconnect({ id: record.id });
  expect(binding.signal.aborted).toBe(true); await manager.connect({ id: record.id });
  const current = manager.bindClient({ id: record.id }); expect(current.signal).not.toBe(binding.signal); expect(current.signal.aborted).toBe(false);
});

it('renames a connected peer without changing its transport, identity or live allowance', async () => {
  const { manager, storage, dependencies } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload();
  await manager.connect({ id: record.id }); await manager.updateInboundAllowedMethods({ id: record.id, inboundAllowedMethods: ['generateChat'] });
  const binding = manager.bindClient({ id: record.id }); await manager.rename({ id: record.id, label: 'Desk' });
  const view = manager.list()[0]!; expect(view.registration).toMatchObject({ label: 'Desk', peerPublicKey: record.peerPublicKey, transport, inboundAllowedMethods: ['generateChat'] });
  expect(view.phase).toBe('connected'); expect(view.access.effective).toEqual(['generateChat']); expect(binding.signal.aborted).toBe(false);
  expect(dependencies.open).toHaveBeenCalledOnce(); expect(storage.update).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 1 }));
  await manager.updateInboundAllowedMethods({ id: record.id, inboundAllowedMethods: [] });
  expect(storage.update).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 2 }));
});

it('a failed rename does not change the displayed name or disconnect the peer', async () => {
  const { manager, storage } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  vi.mocked(storage.update).mockRejectedValueOnce(new Error('quota'));
  await expect(manager.rename({ id: record.id, label: 'Desk' })).rejects.toThrow('quota');
  expect(manager.list()[0]).toMatchObject({ phase: 'connected', registration: { label: record.label } });
  await manager.rename({ id: record.id, label: 'Desk' }); expect(manager.list()[0]?.registration.label).toBe('Desk');
});

it('temporary names do not imply remembered trust and blank names keep the automatic label', async () => {
  const { manager, storage } = fixture(); await manager.setEnabled({ enabled: true });
  const id = await manager.pair({ settings: transport, code: '1234', verifyPeer: async () => true, signal: new AbortController().signal });
  const before = manager.list()[0]!.registration.label;
  await manager.rename({ id, label: '  ' }); expect(manager.list()[0]?.registration.label).toBe(before);
  await manager.rename({ id, label: 'Desk' }); expect(manager.list()[0]).toMatchObject({ persistence: 'temporary', registration: { label: 'Desk' } });
  expect(storage.update).not.toHaveBeenCalled(); expect(storage.remember).not.toHaveBeenCalled();
});

it('a concurrent disconnect waits for a rename but does not adopt a late grant expansion', async () => {
  const { manager, storage } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const write = Promise.withResolvers<number>(); vi.mocked(storage.update).mockReturnValueOnce(write.promise);
  const naming = manager.rename({ id: record.id, label: 'Desk' }); await vi.waitFor(() => expect(storage.update).toHaveBeenCalledOnce());
  const stopping = manager.disconnect({ id: record.id }); write.resolve(1); await naming; await stopping;
  expect(manager.list()[0]).toMatchObject({ phase: 'disconnected', registration: { label: 'Desk' }, access: { effective: [] } });
  vi.mocked(storage.list).mockResolvedValue(snapshot({ registrations: [manager.list()[0]!.registration] }));
  await manager.connect({ id: record.id }); expect(manager.list()[0]?.access.effective).toEqual([]);
});

it('keeps ownership until native resources retire and prevents a new ON racing retirement', async () => {
  const { manager, dependencies, release } = fixture();
  await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const gate = Promise.withResolvers<void>(); vi.mocked(dependencies.retireResources).mockReturnValueOnce(gate.promise);
  const off = manager.setEnabled({ enabled: false });
  await vi.waitFor(() => expect(dependencies.retireResources).toHaveBeenCalledOnce());
  expect(release).not.toHaveBeenCalled();
  const on = manager.setEnabled({ enabled: true });
  const connect = manager.connect({ id: record.id });
  await Promise.resolve(); expect(dependencies.open).toHaveBeenCalledTimes(1);
  gate.resolve(); await Promise.all([off, on, connect]);
  expect(release).toHaveBeenCalledOnce(); expect(dependencies.open).toHaveBeenCalledTimes(2);
});

it('turning off an unused manager retires its lazy resource owner without opening a transport', async () => {
  const { manager, dependencies } = fixture();
  await manager.setEnabled({ enabled: true }); await manager.setEnabled({ enabled: false });
  expect(dependencies.retireResources).toHaveBeenCalledOnce(); expect(dependencies.open).not.toHaveBeenCalled();
});

it('suspends inbound admission while checking storage without connecting or scanning models', async () => {
  const { manager, storage, resources, links } = fixture();
  await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  await manager.updateInboundAllowedMethods({ id: record.id, inboundAllowedMethods: ['listChatModels'] });
  const current = manager.list()[0]!.registration;
  const gate = Promise.withResolvers<NaidanRpcRegistrySnapshot>(); vi.mocked(storage.list).mockReturnValueOnce(gate.promise);
  const checking = manager.revalidate();
  const peer = new NaidanRpcPeer({ transport: links[0]!.b, exports: [], limits: { maxCalls: 4, maxCallTimeoutMs: 1000 }, signal: new AbortController().signal });
  try {
    const discovery = peer.client({ contract: naidanPeerContract }).getProvidedMethods({ input: {}, on: {}, signal: undefined, timeoutMs: 1000 });
    expect(await discovery.result).toEqual({ status: 'checking', methods: [] }); await discovery.closed;
    const rejected = peer.client({ contract: naidanPeerContract }).listChatModels({ input: {}, on: {}, signal: undefined, timeoutMs: 1000 });
    await expect(rejected.result).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
    await expect(rejected.closed).rejects.toBeDefined(); expect(resources.listChatModels).not.toHaveBeenCalled();
    gate.resolve(snapshot({ registrations: [current] })); await checking;
    expect(manager.list()[0]?.phase).toBe('connected');
    const confirmed = peer.client({ contract: naidanPeerContract }).getProvidedMethods({ input: {}, on: {}, signal: undefined, timeoutMs: 1000 });
    expect(await confirmed.result).toEqual({ status: 'ready', methods: describePeerMethods({ names: ['listChatModels'] }) }); await confirmed.closed;
    const accepted = peer.client({ contract: naidanPeerContract }).listChatModels({ input: {}, on: {}, signal: undefined, timeoutMs: 1000 });
    const reader = (await accepted.result).getReader(); expect((await reader.read()).value?.ref).toBe('models/local.gguf');
    expect((await reader.read()).done).toBe(true); await accepted.closed;
  } finally {
    gate.resolve(snapshot({ registrations: [current] })); peer.dispose();
  }
});

it('an external expansion disconnects instead of expanding live access or reconnecting', async () => {
  const { manager, storage, dependencies } = fixture();
  await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const binding = manager.bindClient({ id: record.id });
  vi.mocked(storage.list).mockResolvedValue(snapshot({ registrations: [{ ...record, revision: 1, inboundAllowedMethods: ['generateImage'] }] }));
  await manager.revalidate(); expect(binding.signal.aborted).toBe(true);
  expect(manager.list()[0]?.access.effective).toEqual([]);
  await expect(manager.connect({ id: record.id })).rejects.toThrow('Reload');
  await vi.waitFor(() => expect(manager.list()[0]?.phase).toBe('disconnected'));
  await manager.reload(); await manager.connect({ id: record.id });
  expect(manager.list()[0]?.access.effective).toEqual([]); expect(dependencies.open).toHaveBeenCalledTimes(2);
});

it('a failed storage check closes saved sessions and requires explicit reload', async () => {
  const { manager, storage } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const binding = manager.bindClient({ id: record.id }); vi.mocked(storage.list).mockRejectedValueOnce(new Error('unavailable'));
  await expect(manager.revalidate()).rejects.toThrow('unavailable'); expect(binding.signal.aborted).toBe(true);
  await vi.waitFor(() => expect(manager.list()[0]?.phase).toBe('disconnected'));
  await expect(manager.connect({ id: record.id })).rejects.toThrow('Reload');
  await manager.reload(); await manager.connect({ id: record.id }); expect(manager.list()[0]?.phase).toBe('connected');
});

it('a late check after OFF does not restore inbound authority or delete saved rows', async () => {
  const { manager, storage } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const gate = Promise.withResolvers<NaidanRpcRegistrySnapshot>(); vi.mocked(storage.list).mockReturnValueOnce(gate.promise);
  const checking = manager.revalidate(); await vi.waitFor(() => expect(storage.list).toHaveBeenCalledTimes(3));
  await manager.setEnabled({ enabled: false }); gate.resolve(snapshot({ registrations: [] })); await checking;
  expect(manager.list()).toHaveLength(1); expect(manager.list()[0]?.phase).toBe('disconnected');
});

it('detects a changed saved transport before opening the first transport', async () => {
  const { manager, storage, dependencies } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload();
  vi.mocked(storage.list).mockResolvedValue(snapshot({ registrations: [{ ...record, revision: 1, label: 'Changed elsewhere', transport: { ...transport, serverUrl: 'https://changed.invalid' } }] }));
  await expect(manager.connect({ id: record.id })).rejects.toBeDefined(); expect(dependencies.open).not.toHaveBeenCalled();
  await manager.reload(); await manager.connect({ id: record.id }); expect(manager.list()[0]?.registration.label).toBe('Changed elsewhere');
});

it('deleting a persisted registration elsewhere stops it and removes the stale row', async () => {
  const { manager, storage } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const binding = manager.bindClient({ id: record.id }); vi.mocked(storage.list).mockResolvedValue(snapshot({ registrations: [] }));
  await manager.revalidate(); expect(binding.signal.aborted).toBe(true); await vi.waitFor(() => expect(manager.list()).toEqual([]));
});

it('never silently rebinds an existing registration ID to another peer identity', async () => {
  const { manager, storage } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  vi.mocked(storage.list).mockResolvedValue(snapshot({ registrations: [{ ...record, revision: 1, peerPublicKey: toNaidanRpcPeerPublicKey({ raw: encodePeerKey({ bytes: new Uint8Array(32).fill(3) }) }) }] }));
  await manager.revalidate(); await manager.reload();
  expect(manager.list()[0]?.registration.peerPublicKey).toBe(record.peerPublicKey); await expect(manager.connect({ id: record.id })).rejects.toThrow('Reload');
});

it('temporary-only registrations do not require storage to revalidate on focus', async () => {
  const { manager, storage } = fixture(); await manager.setEnabled({ enabled: true });
  const id = await manager.pair({ settings: transport, code: '1234', verifyPeer: async () => true, signal: new AbortController().signal });
  expect(storage.list).toHaveBeenCalledTimes(1); vi.mocked(storage.list).mockClear();
  vi.mocked(storage.list).mockRejectedValue(new Error('storage unavailable')); await manager.revalidate();
  expect(manager.bindClient({ id }).signal.aborted).toBe(false); expect(storage.list).not.toHaveBeenCalled();
});

it('a second invalidation during a slow read is checked before reopening admission', async () => {
  const { manager, storage } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const first = Promise.withResolvers<NaidanRpcRegistrySnapshot>(); vi.mocked(storage.list).mockReturnValueOnce(first.promise).mockResolvedValueOnce(snapshot({ registrations: [] }));
  const checking = manager.revalidate(); await vi.waitFor(() => expect(storage.list).toHaveBeenCalledTimes(3));
  const newer = manager.revalidate(); expect(newer).toBe(checking); first.resolve(snapshot({ registrations: [record] }));
  await checking; expect(storage.list).toHaveBeenCalledTimes(4); await vi.waitFor(() => expect(manager.list()).toEqual([]));
});

it('a cross-tab stop closes actual manager admission before acknowledging native retirement', async () => {
  const { manager, dependencies, release } = fixture();
  const queue: { side: number, message: RpcControlMessage }[] = [];
  const make = ({ side }: { side: number }) => createRpcStopControl({
    nextId: () => `request-${side}`,
    send: ({ message }) => queue.push({ side, message }),
    changed: () => {},
    registryChanged: () => {},
    timeoutMs: 100,
  });
  const localControl = make({ side: 0 }), otherControl = make({ side: 1 });
  const drain = () => {
    while (queue.length) {
      const item = queue.shift()!; (item.side === 0 ? otherControl : localControl).receive({ value: item.message });
    }
  };
  const retire = Promise.withResolvers<void>();
  vi.mocked(dependencies.acquireOwner).mockImplementation(async () => {
    const unregister = localControl.registerOwner({ ownerId: 'actual-owner', stop: () => manager.setEnabled({ enabled: false }) });
    return {
      release: () => {
        unregister(); release();
      },
    };
  });
  try {
    await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
    const binding = manager.bindClient({ id: record.id }); vi.mocked(dependencies.retireResources).mockReturnValueOnce(retire.promise);
    otherControl.requestStop(); drain();
    expect(manager.isEnabled()).toBe(false); expect(binding.signal.aborted).toBe(true);
    expect(otherControl.status()).toBe('applied'); expect(release).not.toHaveBeenCalled();
    retire.resolve(); await manager.setEnabled({ enabled: false }); await Promise.resolve(); drain();
    expect(otherControl.status()).toBe('retired'); expect(release).toHaveBeenCalledOnce();
  } finally {
    retire.resolve(); localControl.dispose(); otherControl.dispose();
  }
});

it('a record deleted before connection startup is removed after that startup retires without self-waiting', async () => {
  const { manager, storage, dependencies } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload();
  vi.mocked(storage.list).mockResolvedValue(snapshot({ registrations: [] }));
  await expect(manager.connect({ id: record.id })).rejects.toBeDefined();
  expect(manager.list()).toEqual([]); expect(dependencies.open).not.toHaveBeenCalled();
});

it('unchanged persisted grants cannot undo a failed local restriction when the page resumes', async () => {
  const { manager, storage } = fixture();
  const saved = { ...record, inboundAllowedMethods: ['generateChat'] };
  vi.mocked(storage.list).mockResolvedValue(snapshot({ registrations: [saved] })); await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  vi.mocked(storage.update).mockRejectedValueOnce(new Error('quota'));
  await expect(manager.updateInboundAllowedMethods({ id: record.id, inboundAllowedMethods: [] })).rejects.toThrow('quota');
  await manager.revalidate(); expect(manager.list()[0]?.phase).toBe('connected'); expect(manager.list()[0]?.access.effective).toEqual([]);
  expect(manager.list()[0]?.access.persistence).toBe('failed');
});

it('repeated invalidations have a bounded read budget and fail closed instead of retrying forever', async () => {
  const { manager, storage } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const before = vi.mocked(storage.list).mock.calls.length;
  vi.mocked(storage.list).mockImplementation(async () => {
    void manager.revalidate().catch(() => {}); return snapshot({ registrations: [record] });
  });
  await expect(manager.revalidate()).rejects.toThrow('repeatedly');
  await vi.waitFor(() => expect(manager.list()[0]?.phase).toBe('disconnected'));
  expect(vi.mocked(storage.list).mock.calls.length - before).toBe(4);
});

it('a confirmed stop is bound to the original session rather than a reused registration ID', async () => {
  const { manager, dependencies } = fixture();
  await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const original = manager.bindClient({ id: record.id });
  const stopOriginal = manager.prepareDisconnect({ id: record.id });
  await manager.disconnect({ id: record.id }); await manager.connect({ id: record.id });
  const next = manager.bindClient({ id: record.id });
  await expect(stopOriginal()).rejects.toThrow('session changed');
  expect(original.signal.aborted).toBe(true); expect(next.signal.aborted).toBe(false);
  expect(manager.list()[0]?.phase).toBe('connected'); expect(dependencies.open).toHaveBeenCalledTimes(2);
});

it('a stop captured during connection startup still cancels that exact startup', async () => {
  const { manager, dependencies } = fixture();
  await manager.setEnabled({ enabled: true }); await manager.reload();
  const gate = Promise.withResolvers<Awaited<ReturnType<RpcManagerDependencies['identity']>>>();
  vi.mocked(dependencies.identity).mockReturnValueOnce(gate.promise);
  const connecting = manager.connect({ id: record.id });
  const rejected = expect(connecting).rejects.toBeDefined();
  await vi.waitFor(() => expect(dependencies.identity).toHaveBeenCalledOnce());
  const stopThisStartup = manager.prepareDisconnect({ id: record.id });
  const stopped = stopThisStartup(); gate.resolve({ privateKey: {} as CryptoKey, publicKey: local });
  await stopped; await rejected;
  expect(dependencies.open).not.toHaveBeenCalled(); expect(manager.list()[0]?.phase).toBe('disconnected');
});

it('a captured stop can finish an already stopping session but cannot resurrect a removed temporary row', async () => {
  const { manager } = fixture();
  await manager.setEnabled({ enabled: true });
  const id = await manager.pair({ settings: transport, code: '1234', verifyPeer: async () => true, signal: new AbortController().signal });
  const stopThisSession = manager.prepareDisconnect({ id });
  await stopThisSession();
  await expect(stopThisSession()).rejects.toThrow('session changed');
  expect(manager.list()).toEqual([]);
});

it('a saved session established during revalidation stays suspended until the read settles', async () => {
  const { manager, dependencies, storage, resources, links } = fixture();
  const saved = { ...record, inboundAllowedMethods: ['listChatModels'] };
  vi.mocked(storage.list).mockResolvedValue(snapshot({ registrations: [saved] }));
  await manager.setEnabled({ enabled: true }); await manager.reload();
  const opened = Promise.withResolvers<void>();
  const original = dependencies.open;
  dependencies.open = vi.fn(async args => {
    await opened.promise; return original(args);
  });
  const connecting = manager.connect({ id: record.id });
  await vi.waitFor(() => expect(dependencies.open).toHaveBeenCalledOnce());
  const read = Promise.withResolvers<NaidanRpcRegistrySnapshot>();
  vi.mocked(storage.list).mockReturnValueOnce(read.promise);
  const validated = manager.revalidate();
  opened.resolve(); await connecting;
  const other = new NaidanRpcPeer({ transport: links[0]!.b, exports: [], limits: { maxCalls: 4, maxCallTimeoutMs: 1000 }, signal: new AbortController().signal });
  const call = other.client({ contract: naidanPeerContract }).listChatModels({ input: {}, on: {}, signal: undefined, timeoutMs: 1000 });
  // Always settle the in-flight read, including when the old implementation leaks a result.
  try {
    await expect(call.result).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
    expect(resources.listChatModels).not.toHaveBeenCalled();
  } finally {
    call.cancel({ reason: 'Test complete' }); read.resolve(snapshot({ registrations: [saved] })); await validated;
  }
  const accepted = other.client({ contract: naidanPeerContract }).listChatModels({ input: {}, on: {}, signal: undefined, timeoutMs: 1000 });
  const reader = (await accepted.result).getReader();
  expect((await reader.read()).value?.ref).toBe('models/local.gguf'); expect((await reader.read()).done).toBe(true);
  reader.releaseLock(); await accepted.closed; other.dispose();
});

it('a synchronous disconnect during live method revocation retains the restricted reconnect policy', async () => {
  const { manager, storage, resources, links } = fixture();
  let stored = { ...record, inboundAllowedMethods: ['listChatModels'] };
  vi.mocked(storage.list).mockImplementation(async () => snapshot({ registrations: [stored] }));
  vi.mocked(storage.update).mockImplementation(async ({ registration }) => {
    stored = { ...registration, inboundAllowedMethods: [...registration.inboundAllowedMethods] }; return registration.revision;
  });
  await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  let stopped: Promise<void> | undefined;
  vi.mocked(resources.listChatModels).mockImplementation(async ({ signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => {
      stopped = manager.disconnect({ id: record.id }); resolve([]);
    }, { once: true });
  }));
  const other = new NaidanRpcPeer({ transport: links[0]!.b, exports: [], limits: { maxCalls: 4, maxCallTimeoutMs: 1000 }, signal: new AbortController().signal });
  const call = other.client({ contract: naidanPeerContract }).listChatModels({ input: {}, on: {}, signal: undefined, timeoutMs: 1000 });
  const reader = (await call.result).getReader(); const reading = reader.read().catch(() => undefined);
  await vi.waitFor(() => expect(resources.listChatModels).toHaveBeenCalledOnce());
  await manager.updateInboundAllowedMethods({ id: record.id, inboundAllowedMethods: [] }); await stopped; await reading;
  expect(manager.list()[0]?.access.effective).toEqual([]);
  await manager.connect({ id: record.id }); expect(manager.list()[0]?.access.effective).toEqual([]);
  reader.releaseLock(); other.dispose();
});

it('does not label an unsaved restriction as saved after disconnect and reconnect', async () => {
  const { manager, storage } = fixture();
  let stored: NaidanRpcRegistration = { ...record, inboundAllowedMethods: ['generateChat'] };
  vi.mocked(storage.list).mockImplementation(async () => snapshot({ registrations: [stored] }));
  vi.mocked(storage.update).mockRejectedValueOnce(new Error('quota'));
  await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  await expect(manager.updateInboundAllowedMethods({ id: record.id, inboundAllowedMethods: [] })).rejects.toThrow('quota');
  await manager.disconnect({ id: record.id }); await manager.connect({ id: record.id });
  expect(manager.list()[0]?.access).toMatchObject({ effective: [], desired: [], saved: ['generateChat'], persistence: 'failed' });
  vi.mocked(storage.update).mockImplementation(async ({ registration }) => {
    stored = registration; return registration.revision;
  });
  await manager.updateInboundAllowedMethods({ id: record.id, inboundAllowedMethods: [] });
  expect(manager.list()[0]?.access).toMatchObject({ effective: [], desired: [], saved: [], persistence: 'saved' });
});

it('retries a typed local handshake response timeout through the existing eligible automatic policy', async () => {
  const { manager, dependencies } = automaticFixture();
  vi.mocked(dependencies.open).mockRejectedValueOnce(new HandshakeResponseUnconfirmedError({ stage: 'status' }));
  await manager.setEnabled({ enabled: true }); await manager.startAutomaticConnections(); await vi.advanceTimersByTimeAsync(0);
  expect(dependencies.open).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(dependencies.open).toHaveBeenCalledTimes(2); expect(manager.list()[0]?.phase).toBe('connected');
});

it('does not interpret a peer-like response timeout string as a local retriable deadline', async () => {
  const { manager, dependencies } = automaticFixture();
  vi.mocked(dependencies.open).mockRejectedValue(new Error('Handshake response unconfirmed: status'));
  await manager.setEnabled({ enabled: true }); await manager.startAutomaticConnections(); await vi.advanceTimersByTimeAsync(60000);
  expect(dependencies.open).toHaveBeenCalledOnce();
});

it('startup OFF still maintains a manual connection after loss without replaying its old call', async () => {
  const { manager, dependencies, links } = automaticFixture();
  await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.setConnectOnStartup({ id: record.id, connectOnStartup: 'disabled' });
  await manager.connect({ id: record.id }); const binding = manager.bindClient({ id: record.id });
  const call = binding.client.getProvidedMethods({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  void call.result.catch(() => {}); void call.closed.catch(() => {}); await vi.advanceTimersByTimeAsync(0);
  expect(links[0]!.stats().total).toBe(1); links[0]!.close(); await vi.advanceTimersByTimeAsync(0);
  expect(binding.signal.aborted).toBe(true); await expect(call.result).rejects.toBeDefined();
  await vi.advanceTimersByTimeAsync(1000); expect(dependencies.open).toHaveBeenCalledTimes(2);
  expect(manager.list()[0]).toMatchObject({ desiredConnection: 'connected', phase: 'connected', registration: { connectOnStartup: 'disabled' } });
  expect(manager.bindClient({ id: record.id }).signal).not.toBe(binding.signal); expect(links[1]!.stats().total).toBe(0);
});

it('temporary pairing retains desire and its approved identity for pinned retries', async () => {
  vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5); const { manager, dependencies, links } = fixture();
  await manager.setEnabled({ enabled: true });
  const id = await manager.pair({ settings: transport, code: '0042', verifyPeer: async () => true, signal: new AbortController().signal });
  const firstIdentity = vi.mocked(dependencies.open).mock.calls[0]![0].identity;
  links[0]!.close(); await vi.advanceTimersByTimeAsync(0);
  expect(manager.list()[0]).toMatchObject({ persistence: 'temporary', desiredConnection: 'connected', phase: 'disconnected' });
  await vi.advanceTimersByTimeAsync(1000); expect(dependencies.open).toHaveBeenCalledTimes(2); expect(dependencies.identity).toHaveBeenCalledOnce();
  expect(vi.mocked(dependencies.open).mock.calls[1]![0]).toMatchObject({ identity: firstIdentity, peerKey: record.peerPublicKey, verifyPeer: undefined });
  expect(manager.bindClient({ id }).signal.aborted).toBe(false);
});

it.each(['retry', 'blocked'] as const)('manual stop removes a temporary %s row only after retirement', async kind => {
  vi.useFakeTimers(); const { manager, dependencies } = fixture(), ended = Promise.withResolvers<{ error: unknown }>();
  const original = vi.mocked(dependencies.open).getMockImplementation()!;
  vi.mocked(dependencies.open).mockImplementationOnce(async args => ({ ...await original(args), ended: ended.promise }));
  await manager.setEnabled({ enabled: true }); const id = await manager.pair({ settings: transport, code: '0042', verifyPeer: async () => true, signal: new AbortController().signal });
  ended.resolve({ error: kind === 'retry' ? new ResponseUnconfirmedError() : new Error('Fatal authenticated failure') }); await vi.advanceTimersByTimeAsync(0);
  expect(manager.list()[0]).toMatchObject({ phase: 'disconnected', desiredConnection: 'connected' });
  await manager.disconnect({ id }); expect(manager.list()).toEqual([]); await vi.advanceTimersByTimeAsync(60000); expect(dependencies.open).toHaveBeenCalledOnce();
});

it('master OFF removes an already-retired temporary row and ON does not resurrect it', async () => {
  vi.useFakeTimers(); const { manager, links, dependencies } = fixture(); await manager.setEnabled({ enabled: true });
  await manager.pair({ settings: transport, code: '0042', verifyPeer: async () => true, signal: new AbortController().signal });
  links[0]!.close(); await vi.advanceTimersByTimeAsync(0); expect(manager.list()).toHaveLength(1);
  await manager.setEnabled({ enabled: false }); expect(manager.list()).toEqual([]);
  await manager.setEnabled({ enabled: true }); await manager.startAutomaticConnections(); await vi.advanceTimersByTimeAsync(60000);
  expect(dependencies.open).toHaveBeenCalledOnce();
});

it('an old temporary stop continuation cannot delete a newer Connect intent', async () => {
  vi.useFakeTimers(); const { manager, links, dependencies } = fixture(); await manager.setEnabled({ enabled: true });
  const id = await manager.pair({ settings: transport, code: '0042', verifyPeer: async () => true, signal: new AbortController().signal });
  links[0]!.close(); await vi.advanceTimersByTimeAsync(0);
  const stopped = manager.disconnect({ id }), restarting = manager.connect({ id });
  await stopped; await restarting; expect(manager.list()[0]).toMatchObject({ phase: 'connected', desiredConnection: 'connected' });
  expect(dependencies.open).toHaveBeenCalledTimes(2);
});

it('manual stop during an initial startup read cannot be overwritten by its late seed', async () => {
  const { manager, storage, dependencies } = automaticFixture(), listed = Promise.withResolvers<NaidanRpcRegistrySnapshot>();
  vi.mocked(storage.list).mockReturnValueOnce(listed.promise); await manager.setEnabled({ enabled: true });
  const starting = manager.startAutomaticConnections(); await Promise.resolve(); await manager.disconnect({ id: record.id });
  listed.resolve(snapshot({ registrations: [{ ...record, connectOnStartup: 'enabled' }] })); await starting; await vi.advanceTimersByTimeAsync(60000);
  expect(manager.list()[0]?.desiredConnection).toBe('disconnected'); expect(dependencies.open).not.toHaveBeenCalled(); expect(dependencies.acquireOwner).not.toHaveBeenCalled();
});

it('changing the startup preference during an opening keeps the same live attempt', async () => {
  const { manager, dependencies } = automaticFixture(), opened = Promise.withResolvers<void>();
  const original = vi.mocked(dependencies.open).getMockImplementation()!;
  vi.mocked(dependencies.open).mockImplementationOnce(async args => {
    await opened.promise; return original(args);
  });
  await manager.setEnabled({ enabled: true }); await manager.reload(); const connecting = manager.connect({ id: record.id });
  await vi.advanceTimersByTimeAsync(0); const signal = vi.mocked(dependencies.open).mock.calls[0]![0].signal;
  await manager.setConnectOnStartup({ id: record.id, connectOnStartup: 'disabled' });
  expect(signal.aborted).toBe(false); expect(manager.list()[0]?.desiredConnection).toBe('connected');
  opened.resolve(); await connecting; expect(dependencies.open).toHaveBeenCalledOnce();
});

it('changing the startup preference during backoff neither cancels nor accelerates recovery', async () => {
  const { manager, dependencies, links } = automaticFixture();
  await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  links[0]!.close(); await vi.advanceTimersByTimeAsync(0);
  await manager.setConnectOnStartup({ id: record.id, connectOnStartup: 'disabled' });
  expect(manager.list()[0]?.desiredConnection).toBe('connected');
  await vi.advanceTimersByTimeAsync(999); expect(dependencies.open).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(dependencies.open).toHaveBeenCalledTimes(2);
});

it('an admitted queued background attempt cannot join its own route edit mutation', async () => {
  const { manager, dependencies, storage } = automaticFixture();
  const records = Array.from({ length: 5 }, (_, index) => ({
    ...record,
    connectOnStartup: 'enabled' as const,
    id: toNaidanRpcRegistrationId({ raw: `edited-record-${index}` }),
    transport: { ...transport, serverUrl: `https://piping-${index}.example` },
  }));
  vi.mocked(storage.list).mockResolvedValue(snapshot({ registrations: records }));
  vi.mocked(dependencies.open).mockImplementation(({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await manager.setEnabled({ enabled: true }); await manager.startAutomaticConnections(); await vi.advanceTimersByTimeAsync(0);
  expect(dependencies.open).toHaveBeenCalledTimes(4);
  const written = Promise.withResolvers<number>(); vi.mocked(storage.update).mockReturnValueOnce(written.promise);
  const target = records[4]!, editing = manager.edit({ id: target.id, label: 'Edited', transport: { ...transport, serverUrl: 'https://changed.example' } });
  await vi.advanceTimersByTimeAsync(0); expect(storage.update).toHaveBeenCalledOnce();
  await manager.disconnect({ id: records[0]!.id }); await vi.advanceTimersByTimeAsync(0);
  expect(dependencies.open).toHaveBeenCalledTimes(4);
  written.resolve(1); await editing;
  expect(manager.list().find(view => view.registration.id === target.id)).toMatchObject({ desiredConnection: 'connected', recoveryStatus: 'blocked', registration: { transport: { serverUrl: 'https://changed.example' } } });
});

it('a complete current-engine RPC header mismatch is understandable and blocks automatic retry', async () => {
  const { manager, dependencies, links } = automaticFixture();
  await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const raw = await links[0]!.b.openStream({ signal: undefined }), reader = raw.readable.getReader(), writer = raw.writable.getWriter();
  const reading = (async () => {
    try {
      while (!(await reader.read()).done) { /* Drain own preamble. */ }
    } catch { /* Rejected stream. */ }
  })();
  const bytes = createRpcProtocolAdvertisement(); new DataView(bytes.buffer).setUint32(9, 0x80000002, true);
  await writer.write(bytes).catch(() => {}); await reading; reader.releaseLock(); writer.releaseLock();
  await vi.advanceTimersByTimeAsync(0);
  expect(manager.list()[0]).toMatchObject({ phase: 'disconnected', desiredConnection: 'connected', recoveryStatus: 'blocked' });
  expect(manager.list()[0]?.failure).toContain('Incompatible RPC version: received experimental revision 2');
  await vi.advanceTimersByTimeAsync(60000); expect(dependencies.open).toHaveBeenCalledOnce();
});

it('transport-supplied protocolError fields cannot forge current-engine compatibility diagnostics', async () => {
  const { manager, dependencies } = automaticFixture(), ended = Promise.withResolvers<{ error: unknown; protocolError: NaidanRpcProtocolError }>();
  const original = vi.mocked(dependencies.open).getMockImplementation()!;
  vi.mocked(dependencies.open).mockImplementationOnce(async args => ({ ...await original(args), ended: ended.promise }));
  await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const lookalike = new NaidanRpcProtocolError({ diagnostic: { kind: 'unsupported-protocol-version', version: 1 } });
  ended.resolve({ error: lookalike, protocolError: lookalike }); await vi.advanceTimersByTimeAsync(0);
  expect(manager.list()[0]?.failure).toBe('RPC connection interrupted');
});

it('ordinary method discovery works without optional encrypted method metadata', async () => {
  const { manager, links } = fixture(); await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const remote = new NaidanRpcPeer({ transport: links[0]!.b, exports: [], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: new AbortController().signal });
  const call = remote.client({ contract: naidanPeerContract }).getProvidedMethods({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  await expect(call.result).resolves.toMatchObject({ status: 'ready', methods: [] }); await call.closed; remote.dispose(); await remote.retire();
});

it.each([
  new Error('Unsupported RPC registry'),
  new Error('RPC registry could not be read'),
])('rejects unreadable stored authority before pairing side effects: %s', async error => {
  const { manager, dependencies, storage } = fixture();
  vi.mocked(storage.list).mockRejectedValue(error);
  await manager.setEnabled({ enabled: true });
  await expect(manager.pair({ settings: transport, code: '1234', verifyPeer: async () => true, signal: new AbortController().signal })).rejects.toThrow();
  expect(dependencies.identity).not.toHaveBeenCalled();
  expect(dependencies.acquireOwner).not.toHaveBeenCalled();
  expect(dependencies.open).not.toHaveBeenCalled();
  expect(storage.remember).not.toHaveBeenCalled();
  expect(manager.list()).toEqual([]);
});
