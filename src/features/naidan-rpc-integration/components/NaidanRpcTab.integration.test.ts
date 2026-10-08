// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promiseAllKeyed } from '@/utils/promise';
import { flushPromises, mount } from '@vue/test-utils';
import NaidanRpcTab from './NaidanRpcTab.vue';
import { NaidanPeerManager } from '@/features/naidan-rpc-integration/runtime/manager';
import { openPipingRpc } from '@/features/naidan-rpc-integration/transports/piping';
import { encodePeerKey } from '@/features/naidan-rpc-integration/runtime/identity';
import { createNaidanPipingIdentity } from '@/features/naidan-piping-duplex';
import type { NaidanPipingIdentity } from '@/features/naidan-piping-duplex';
import { createPipingFetchPool } from '@/features/naidan-rpc-integration/runtime/test-support/piping-pool';
import { MemoryRelay } from '@/features/naidan-piping-duplex/memory-relay.test-support';
import type { NaidanRpcRegistration } from '@/01-models/naidan-rpc';
import type { NaidanRpcStorage } from '@/00-storage/service/naidan-rpc';
import { toNaidanRpcRegistrationId, toNaidanRpcPeerPublicKey, toNaidanRpcRegistryId } from '@/01-models/ids';
import { createInferenceBudget } from '@/features/naidan-rpc-integration/handlers/inference/budget';
import { ensureAllStringsForTest } from '@/strings/test-utils';

const bridge = vi.hoisted(() => ({ manager: undefined as NaidanPeerManager | undefined, listeners: new Set<() => void>() }));
// Only inject the app-owned manager. Its state machine, transport adapter,
// encrypted handshake, RPC and the Vue controls all remain production code.
vi.mock('../runtime/feature', () => ({
  getRpcManager: async () => bridge.manager,
  subscribeRpcState: ({ listener }: { listener(): void }) => {
    bridge.listeners.add(listener); return () => bridge.listeners.delete(listener);
  },
}));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: async () => true }) }));
const managers: NaidanPeerManager[] = [];
const wrappers: ReturnType<typeof mount>[] = [];
let relay: MemoryRelay;
let pool: ReturnType<typeof createPipingFetchPool>;

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  // Node TextEncoder/WebCrypto return Node-realm byte buffers inside jsdom. Re-home only
  // those results so the production same-realm/non-shared byte checks still run.
  const encode = TextEncoder.prototype.encode;
  vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: TextEncoder, input) {
    return Uint8Array.from(encode.call(this, input));
  });
  const subtle = crypto.subtle;
  vi.spyOn(crypto, 'subtle', 'get').mockReturnValue(new Proxy(subtle, {
    get(target, key) {
      const member: unknown = Reflect.get(target, key, target);
      if (typeof member !== 'function') return member;
      return async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(member, target, args);
        return Object.prototype.toString.call(result) === '[object ArrayBuffer]'
          ? Uint8Array.from(new Uint8Array(result as ArrayBuffer)).buffer
          : result;
      };
    },
  }));
  relay = new MemoryRelay();
  pool = createPipingFetchPool({ capacity: 6, request: ({ input, init }) => relay.request({ input, init }) });
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => pool.request({ input, init }));
});

afterEach(async () => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  await Promise.all(managers.splice(0).map(manager => manager.setEnabled({ enabled: false })));
  expect(relay.occupied).toBe(0);
  expect(pool.stats).toMatchObject({ active: 0, queued: 0 }); expect(pool.stats.peak).toBeLessThanOrEqual(6);
  for (const [input] of vi.mocked(fetch).mock.calls) expect(new URL(String(input)).searchParams.has('n')).toBe(false);
  bridge.manager = undefined; bridge.listeners.clear(); vi.restoreAllMocks();
});

async function peer({ identity, other, startup, connectOnStartup }: { identity: NaidanPipingIdentity, other: NaidanPipingIdentity, startup: 'run' | 'defer', connectOnStartup: NaidanRpcRegistration['connectOnStartup'] }) {
  const id = toNaidanRpcRegistrationId({ raw: encodePeerKey({ bytes: other.publicKey }) });
  let registration: NaidanRpcRegistration = {
    id,
    peerPublicKey: toNaidanRpcPeerPublicKey({ raw: encodePeerKey({ bytes: other.publicKey }) }),
    localPublicKey: encodePeerKey({ bytes: identity.publicKey }),
    label: 'Other device',
    connectOnStartup,
    revision: 0,
    inboundAllowedMethods: [],
    transport: { type: 'naidan_piping_duplex', serverUrl: 'https://relay.invalid', headers: [] },
  };
  const access = { providerGeneration: 1, registryId: toNaidanRpcRegistryId({ raw: 'test-registry' }), persistence: 'durable' as const };
  const storage: NaidanRpcStorage = {
    readIdentity: async () => ({ privateKey: identity.privateKey, publicKey: registration.localPublicKey }),
    list: vi.fn(async () => ({ access, registrations: [registration] })),
    remember: async () => access,
    update: vi.fn(async ({ registration: next }) => {
      registration = next; return next.revision;
    }),
    remove: async () => {},
  };
  const open = vi.fn(openPipingRpc);
  const manager = new NaidanPeerManager({
    dependencies: {
      storage,
      identity: async () => identity,
      acquireOwner: async () => ({ release() {} }),
      open,
      inference: {
        resources: {
          listChatModels: async () => [],
          listImageModels: async () => [],
          generateChat: async () => {
            throw new Error('Inference must not run');
          },
          generateImage: async () => {
            throw new Error('Inference must not run');
          },
        },
        inputBudget: createInferenceBudget({ capacity: 1024 * 1024 }),
        deliveryBudget: createInferenceBudget({ capacity: 1024 * 1024 }),
      },
      retireResources: async () => {},
      changed: () => {
        for (const listener of bridge.listeners) listener();
      },
    },
  });
  managers.push(manager);
  await manager.setEnabled({ enabled: true });
  if (startup === 'run') await manager.startAutomaticConnections();
  return { manager, id, open, storage };
}
async function setup() {
  const a = await createNaidanPipingIdentity(), b = await createNaidanPipingIdentity();
  const local = await peer({ identity: a, other: b, startup: 'run', connectOnStartup: 'disabled' }), remote = await peer({ identity: b, other: a, startup: 'run', connectOnStartup: 'disabled' });
  bridge.manager = local.manager;
  const wrapper = mount(NaidanRpcTab); wrappers.push(wrapper); await flushPromises();
  return { local, remote, wrapper, identities: { a, b } };
}

it('enables a live panel, completes a real encrypted memory-relay connection, and does not duplicate the session', async () => {
  const { local, remote, wrapper } = await setup();
  expect(local.open).not.toHaveBeenCalled(); expect(relay.occupied).toBe(0);
  await wrapper.get('[data-testid="rpc-connect-on-startup"]').setValue(true);
  await vi.waitFor(() => expect(local.open).toHaveBeenCalledOnce());
  expect(local.manager.list()[0]).toMatchObject({ phase: 'connecting', failure: undefined });
  await local.manager.setConnectOnStartup({ id: local.id, connectOnStartup: 'enabled' });
  expect(local.open).toHaveBeenCalledOnce();
  await remote.manager.connect({ id: remote.id });
  await vi.waitFor(() => expect(local.manager.list()[0]?.phase).toBe('connected'));
  // Discovery travels through the genuine RPC byte stream, not a canned reply.
  await vi.waitFor(() => expect(wrapper.find('[data-testid="rpc-peer-chat"]').exists()).toBe(true));
  const token = local.manager.list()[0]?.connectionToken;
  await local.manager.setConnectOnStartup({ id: local.id, connectOnStartup: 'enabled' });
  expect(local.open).toHaveBeenCalledOnce(); expect(local.manager.list()[0]?.connectionToken).toBe(token);
  wrapper.unmount(); await flushPromises();
  expect(local.manager.list()[0]?.phase).toBe('connected');
});

it('keeps Disconnect usable while enable is waiting for a peer and preserves the saved startup policy', async () => {
  const { local, wrapper } = await setup();
  await wrapper.get('[data-testid="rpc-connect-on-startup"]').setValue(true);
  await vi.waitFor(() => expect(relay.occupied).toBeGreaterThan(0));
  await wrapper.get('[data-testid="rpc-disconnect"]').trigger('click');
  await vi.waitFor(() => expect(local.manager.list()[0]).toMatchObject({
    phase: 'disconnected',
    desiredConnection: 'disconnected',
    registration: { connectOnStartup: 'enabled' },
  }));
  expect(relay.occupied).toBe(0);
  await local.manager.reload(); await local.manager.startAutomaticConnections();
  expect(local.open).toHaveBeenCalledOnce();
});

it('does not open a transport or leave the switch enabled when saving the policy fails', async () => {
  const { local, wrapper } = await setup();
  vi.mocked(local.storage.update).mockRejectedValueOnce(new Error('Storage unavailable'));
  await wrapper.get('[data-testid="rpc-connect-on-startup"]').setValue(true); await flushPromises();
  expect(wrapper.get('[data-testid="rpc-connect-on-startup"]').element).toHaveProperty('checked', false);
  expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  expect(local.open).not.toHaveBeenCalled(); expect(relay.occupied).toBe(0);
});

// The Settings panel's onMounted reload can supersede the app-ready read.
// Both completion orders must adopt the published registry before seeding intent.
it.each(['startup-first', 'panel-first'] as const)('connects on startup with Settings already opening (%s)', async order => {
  const a = await createNaidanPipingIdentity(), b = await createNaidanPipingIdentity();
  const local = await peer({ identity: a, other: b, startup: 'defer', connectOnStartup: 'enabled' });
  const snapshot = await local.storage.list();
  const startupRead = Promise.withResolvers<typeof snapshot>(), panelRead = Promise.withResolvers<typeof snapshot>();
  vi.mocked(local.storage.list).mockClear().mockImplementationOnce(() => startupRead.promise).mockImplementationOnce(() => panelRead.promise);
  const starting = local.manager.startAutomaticConnections();
  bridge.manager = local.manager;
  const wrapper = mount(NaidanRpcTab); wrappers.push(wrapper); await flushPromises();
  expect(local.storage.list).toHaveBeenCalledTimes(2);
  if (order === 'startup-first') {
    startupRead.resolve(snapshot); await flushPromises();
    expect(local.open).not.toHaveBeenCalled();
    panelRead.resolve(snapshot);
  } else {
    panelRead.resolve(snapshot);
    try {
      // The authoritative panel snapshot must not wait for an obsolete read.
      await vi.waitFor(() => expect(local.open).toHaveBeenCalledOnce());
    } finally {
      startupRead.resolve(snapshot);
    }
  }
  await starting;
  await vi.waitFor(() => expect(relay.occupied).toBeGreaterThan(0));
  expect(local.open).toHaveBeenCalledOnce();
  expect(local.manager.list()[0]?.desiredConnection).toBe('connected');
  await wrapper.get('[data-testid="rpc-disconnect"]').trigger('click');
  await vi.waitFor(() => expect(local.manager.list()[0]?.phase).toBe('disconnected'));
});

it('reconnects after only p2 restarts on the same stable paths, without replacing p1 physical owner or replaying its RPC binding', async () => {
  const { local, remote, identities } = await setup();
  await Promise.all([local.manager.connect({ id: local.id }), remote.manager.connect({ id: remote.id })]);
  const oldToken = local.manager.list()[0]?.connectionToken, oldBinding = local.manager.bindClient({ id: local.id });
  const paths = [...new Set(vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input)).pathname))].sort();
  const remoteLink = await remote.open.mock.results[0]!.value;
  if (!remoteLink.persistent) throw new Error('Expected the production persistent endpoint');
  // Abrupt endpoint loss precedes app disposal, so no graceful CLOSE is sent.
  const abrupt = remoteLink.persistent.owner.stop({ reason: 'Simulated page reload', notice: 'abort' });
  await remote.manager.setEnabled({ enabled: false }); await abrupt;
  const restarted = await peer({ identity: identities.b, other: identities.a, startup: 'run', connectOnStartup: 'enabled' });
  await vi.waitFor(() => {
    expect(restarted.manager.list()[0]?.phase).toBe('connected');
    expect(local.manager.list()[0]?.phase).toBe('connected');
    expect(local.manager.list()[0]?.connectionToken).not.toBe(oldToken);
  });
  expect(oldBinding.signal.aborted).toBe(true); expect(local.open).toHaveBeenCalledOnce(); expect(restarted.open).toHaveBeenCalledOnce();
  expect([...new Set(vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input)).pathname))].sort()).toEqual(paths);
  await expect(local.manager.getPeerProvidedMethods({ id: local.id, signal: new AbortController().signal })).resolves.toBeDefined();
});

it('keeps manual stop final, lets the peer wait, and reconnects only after explicit actions', async () => {
  const { local, remote } = await setup();
  const first = Promise.all([local.manager.connect({ id: local.id }), remote.manager.connect({ id: remote.id })]); void first.catch(() => {});
  await vi.waitFor(() => expect({ local: local.manager.list()[0]?.phase, remote: remote.manager.list()[0]?.phase }, 'initial').toEqual({ local: 'connected', remote: 'connected' })); await first;
  const stopped = local.manager.disconnect({ id: local.id }); void stopped.catch(() => {});
  await vi.waitFor(() => expect(local.manager.list()[0]?.phase, 'manual stop').toBe('disconnected')); await stopped;
  await vi.waitFor(() => expect(remote.manager.list()[0]?.recoveryStatus).toBe('waiting-peer'));
  expect(local.manager.list()[0]?.desiredConnection).toBe('disconnected');
  expect(remote.manager.list()[0]?.desiredConnection).toBe('connected'); expect(remote.open).toHaveBeenCalledOnce();
  const resumed = remote.manager.connect({ id: remote.id });
  await flushPromises(); expect(local.manager.list()[0]?.phase).toBe('disconnected');
  const reconnecting = local.manager.connect({ id: local.id }); void reconnecting.catch(() => {}); void resumed.catch(() => {});
  // The receiver owns a bounded two-second CLOSE_ACK drain before reactivation.
  // This condition budget remains inside the unchanged five-second test budget.
  await vi.waitFor(() => expect({ local: local.manager.list()[0]?.phase, remote: remote.manager.list()[0]?.phase }).toEqual({ local: 'connected', remote: 'connected' }), { timeout: 3000 });
  await reconnecting; await resumed;
  expect(local.manager.list()[0]?.phase).toBe('connected'); expect(remote.manager.list()[0]?.phase).toBe('connected');
  expect(local.open).toHaveBeenCalledTimes(2); expect(remote.open).toHaveBeenCalledOnce();
});

it('hands a human-verified first pairing to the pinned endpoint before exposing RPC under six shared fetch slots', async () => {
  const a = await createNaidanPipingIdentity(), b = await createNaidanPipingIdentity();
  const local = await peer({ identity: a, other: b, startup: 'run', connectOnStartup: 'disabled' });
  const remote = await peer({ identity: b, other: a, startup: 'run', connectOnStartup: 'disabled' });
  for (const side of [local, remote]) {
    const saved = await side.storage.list();
    vi.mocked(side.storage.list).mockResolvedValue({ ...saved, registrations: [] });
    await side.manager.revalidate(); await vi.waitFor(() => expect(side.manager.list()).toHaveLength(0));
  }
  const consent = Promise.withResolvers<boolean>();
  const verifyLocal = vi.fn(async () => true), verifyRemote = vi.fn(() => consent.promise);
  const signal = new AbortController().signal;
  const settings = { type: 'naidan_piping_duplex' as const, serverUrl: 'https://relay.invalid', headers: [] };
  const pairing = promiseAllKeyed({
    localId: local.manager.pair({ settings, code: 'handoff-example', verifyPeer: verifyLocal, signal }),
    remoteId: remote.manager.pair({ settings, code: 'handoff-example', verifyPeer: verifyRemote, signal }),
  });
  void pairing.catch(() => {});
  try {
    await vi.waitFor(() => expect(verifyRemote).toHaveBeenCalledOnce());
    expect(local.manager.list().some(view => view.phase === 'connected')).toBe(false);
    expect(remote.manager.list().some(view => view.phase === 'connected')).toBe(false);
    consent.resolve(true);
  } finally {
    consent.resolve(false);
  }
  const { localId, remoteId } = await pairing;
  expect(verifyLocal).toHaveBeenCalledOnce(); expect(verifyRemote).toHaveBeenCalledOnce();
  const localView = local.manager.list().find(view => view.registration.id === localId);
  const remoteView = remote.manager.list().find(view => view.registration.id === remoteId);
  expect(localView).toMatchObject({ phase: 'connected', persistence: 'temporary', health: { state: 'healthy' } });
  expect(remoteView).toMatchObject({ phase: 'connected', persistence: 'temporary', health: { state: 'healthy' } });
  const opened = await local.open.mock.results[0]!.value;
  expect(opened.persistent).toBeDefined();
  await expect(local.manager.getPeerProvidedMethods({ id: localId, signal })).resolves.toBeDefined();
  expect(pool.stats.peak).toBeLessThanOrEqual(6);
});
