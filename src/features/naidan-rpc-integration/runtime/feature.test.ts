import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Settings } from '@/01-models/types';
import type { createRpcStopControl } from './stop-control';
import type { NaidanRpcRegistrySnapshot } from '@/00-storage/service/naidan-rpc';
import { toNaidanRpcRegistrationId, toNaidanRpcPeerPublicKey } from '@/01-models/ids';

const fixture = vi.hoisted(() => ({
  create: vi.fn(),
  setEnabled: vi.fn(async () => {}),
  revalidate: vi.fn(async () => {}),
  startAutomaticConnections: vi.fn(async () => {}),
  stopAutomaticConnections: vi.fn(),
  wakeDesiredConnections: vi.fn(),
  list: vi.fn<() => Promise<NaidanRpcRegistrySnapshot>>(),
  registryListeners: new Set<() => void>(),
}));
vi.mock('./state', () => ({ createRpcManager: fixture.create }));
vi.mock('@/00-storage/service/naidan-rpc', () => ({ naidanRpcStorage: { list: fixture.list } }));
vi.mock('@/00-storage/service', () => ({
  storageService: {
    subscribeNaidanRpcRegistryChanges: ({ listener }: { listener(): void }) => {
      fixture.registryListeners.add(listener); return () => fixture.registryListeners.delete(listener);
    },
  },
}));
const automaticDisposers: (() => void)[] = [];

function automaticRegistry(): NaidanRpcRegistrySnapshot {
  return {
    access: { providerGeneration: 1, registryId: undefined, persistence: 'durable' },
    registrations: [{
      id: toNaidanRpcRegistrationId({ raw: 'automatic-registration' }),
      peerPublicKey: toNaidanRpcPeerPublicKey({ raw: 'B'.repeat(43) }),
      localPublicKey: 'A'.repeat(43),
      label: 'Peer',
      transport: { type: 'naidan_piping_duplex', serverUrl: 'https://piping.example', headers: [] },
      inboundAllowedMethods: [],
      connectOnStartup: 'enabled',
      revision: 0,
    }],
  };
}

let control: ReturnType<typeof createRpcStopControl> | undefined;
const channels: { onmessage: ((event: { data: unknown }) => void) | undefined, postMessage: ReturnType<typeof vi.fn> }[] = [];

const settings = () => ({ experimental: { naidanRpc: 'enabled' } }) as Settings;

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); channels.length = 0;
  fixture.registryListeners.clear(); fixture.list.mockResolvedValue({ access: { providerGeneration: 1, registryId: undefined, persistence: 'durable' }, registrations: [] });
  vi.stubGlobal('BroadcastChannel', class {
    onmessage: ((event: { data: unknown }) => void) | undefined;
    postMessage = vi.fn();

    constructor() {
      channels.push(this);
    }
  });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  fixture.create.mockImplementation(({ control: created }: { control: ReturnType<typeof createRpcStopControl> }) => {
    control = created; return {
      setEnabled: fixture.setEnabled,
      revalidate: fixture.revalidate,
      startAutomaticConnections: fixture.startAutomaticConnections,
      stopAutomaticConnections: fixture.stopAutomaticConnections,
      wakeDesiredConnections: fixture.wakeDesiredConnections,
    };
  });
});

afterEach(() => {
  for (const dispose of automaticDisposers.splice(0)) dispose();
  control?.dispose(); control = undefined; vi.unstubAllGlobals(); vi.useRealTimers();
});

it('starts saved automatic policy only after app-ready and keeps an empty registry runtime-free', async () => {
  vi.useFakeTimers(); const feature = await import('./feature');
  fixture.list.mockResolvedValue(automaticRegistry());
  await feature.configureRpcFeature({ status: 'enabled', settings });
  await vi.advanceTimersByTimeAsync(1000); expect(fixture.list).not.toHaveBeenCalled();
  automaticDisposers.push(feature.startRpcAutomaticConnections());
  await vi.advanceTimersByTimeAsync(100);
  expect(fixture.startAutomaticConnections).toHaveBeenCalledOnce();
  expect(fixture.create).toHaveBeenCalledOnce();
});

it.each(['empty', 'disabled', 'session'] as const)('does not load a manager for an automatic %s registry', async variant => {
  vi.useFakeTimers(); const feature = await import('./feature'); const value = automaticRegistry();
  switch (variant) {
  case 'empty': value.registrations = []; break;
  case 'disabled': value.registrations[0]!.connectOnStartup = 'disabled'; break;
  case 'session': value.access = { ...value.access, persistence: 'session' }; break;
  default: { const exhaustive: never = variant; throw new Error(String(exhaustive)); }
  }
  fixture.list.mockResolvedValue(value);
  await feature.configureRpcFeature({ status: 'enabled', settings }); automaticDisposers.push(feature.startRpcAutomaticConnections());
  await vi.advanceTimersByTimeAsync(1000); expect(fixture.list).toHaveBeenCalledOnce();
  expect(fixture.create).not.toHaveBeenCalled(); expect(channels).toHaveLength(0);
});

it('fences an automatic registry read that finishes after feature OFF', async () => {
  vi.useFakeTimers(); const feature = await import('./feature'); const gate = Promise.withResolvers<NaidanRpcRegistrySnapshot>();
  fixture.list.mockReturnValueOnce(gate.promise);
  await feature.configureRpcFeature({ status: 'enabled', settings }); automaticDisposers.push(feature.startRpcAutomaticConnections());
  await vi.advanceTimersByTimeAsync(100); await feature.configureRpcFeature({ status: 'disabled', settings });
  gate.resolve(automaticRegistry()); await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.create).not.toHaveBeenCalled();
});

it('a registry hint can discover a saved opt-in after an initially empty catalogue', async () => {
  vi.useFakeTimers(); const feature = await import('./feature');
  await feature.configureRpcFeature({ status: 'enabled', settings }); automaticDisposers.push(feature.startRpcAutomaticConnections());
  await vi.advanceTimersByTimeAsync(60000); expect(fixture.list).toHaveBeenCalledOnce();
  fixture.list.mockResolvedValue(automaticRegistry()); for (const listener of fixture.registryListeners) listener();
  await vi.advanceTimersByTimeAsync(100); expect(fixture.startAutomaticConnections).toHaveBeenCalledOnce();
});

it('passive hydration and enabling alone create no control channel, identity or manager', async () => {
  const feature = await import('./feature');
  await feature.configureRpcFeature({ status: 'disabled', settings }); await feature.configureRpcFeature({ status: 'enabled', settings });
  expect(fixture.create).not.toHaveBeenCalled(); expect(channels).toHaveLength(0);
});

it('focus and validated registry hints recheck a loaded manager without replaying a call', async () => {
  const feature = await import('./feature'); await feature.configureRpcFeature({ status: 'enabled', settings }); await feature.getRpcManager();
  expect(channels).toHaveLength(1); expect(channels[0]!.postMessage).not.toHaveBeenCalled();
  window.dispatchEvent(new Event('focus')); await Promise.resolve(); expect(fixture.revalidate).toHaveBeenCalledOnce();
  channels[0]!.onmessage?.({ data: { type: 'registry-changed' } }); await Promise.resolve(); expect(fixture.revalidate).toHaveBeenCalledTimes(2);
  channels[0]!.onmessage?.({ data: { type: 'registry-changed', settings: { inboundAllowedMethods: ['generateImage'] } } });
  await Promise.resolve(); expect(fixture.revalidate).toHaveBeenCalledTimes(2);
});

it('a stop is explicit and settings persistence alone is not a remote acknowledgement', async () => {
  vi.useFakeTimers(); const feature = await import('./feature'); await feature.configureRpcFeature({ status: 'enabled', settings });
  feature.requestRpcStop(); expect(feature.rpcStopStatus()).toBe('checking');
  expect(channels[0]!.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'probe' }));
  await feature.configureRpcFeature({ status: 'disabled', settings });
  await vi.advanceTimersByTimeAsync(2001); expect(feature.rpcStopStatus()).toBe('unconfirmed');
  expect(fixture.create).not.toHaveBeenCalled();
});

it('enabling after a previous stop clears only its status and never sends an enable command', async () => {
  vi.useFakeTimers(); const feature = await import('./feature'); feature.requestRpcStop();
  await vi.advanceTimersByTimeAsync(2001); expect(feature.rpcStopStatus()).toBe('unconfirmed');
  const sent = channels[0]!.postMessage.mock.calls.length;
  await feature.configureRpcFeature({ status: 'enabled', settings }); expect(feature.rpcStopStatus()).toBe('idle');
  expect(channels[0]!.postMessage).toHaveBeenCalledTimes(sent); expect(fixture.create).not.toHaveBeenCalled();
});

it('unavailable notification transport is reported as unconfirmed rather than silently successful', async () => {
  vi.useFakeTimers(); vi.stubGlobal('BroadcastChannel', undefined);
  const feature = await import('./feature'); feature.requestRpcStop(); await vi.advanceTimersByTimeAsync(2001);
  expect(feature.rpcStopStatus()).toBe('unconfirmed');
});

it('retries a failed manager initialization only on the next explicit request', async () => {
  const feature = await import('./feature');
  const failure = new Error('Runtime initialization interrupted');
  fixture.create.mockImplementationOnce(() => {
    throw failure;
  });
  await feature.configureRpcFeature({ status: 'enabled', settings });
  const first = feature.getRpcManager(), concurrent = feature.getRpcManager();
  await Promise.all([expect(first).rejects.toBe(failure), expect(concurrent).rejects.toBe(failure)]);
  expect(fixture.create).toHaveBeenCalledOnce();
  await feature.configureRpcFeature({ status: 'disabled', settings });
  await feature.configureRpcFeature({ status: 'enabled', settings });
  window.dispatchEvent(new Event('focus'));
  await Promise.resolve();
  expect(fixture.create).toHaveBeenCalledOnce();
  const recovered = await feature.getRpcManager();
  expect(await feature.getRpcManager()).toBe(recovered);
  expect(fixture.create).toHaveBeenCalledTimes(2);
  expect(channels).toHaveLength(1);
});

it('does not reenable a pending manager after an explicit OFF', async () => {
  const feature = await import('./feature');
  await feature.configureRpcFeature({ status: 'enabled', settings });
  const pending = feature.getRpcManager();
  feature.requestRpcStop();
  await expect(pending).rejects.toThrow('disabled');
  expect(fixture.setEnabled).toHaveBeenCalled();
  expect(fixture.setEnabled).not.toHaveBeenCalledWith({ enabled: true });
  expect(fixture.create).toHaveBeenCalledOnce();
});

it('does not replace an initialized manager when its resource retirement has failed', async () => {
  const feature = await import('./feature');
  const failure = new Error('Previous resources have not retired');
  fixture.setEnabled.mockRejectedValue(failure);
  try {
    await feature.configureRpcFeature({ status: 'enabled', settings });
    await expect(feature.getRpcManager()).rejects.toBe(failure);
    await expect(feature.getRpcManager()).rejects.toBe(failure);
    expect(fixture.create).toHaveBeenCalledOnce();
  } finally {
    fixture.setEnabled.mockResolvedValue(undefined);
  }
});

it('delegates repeated readiness to the same manager instead of owning another consumed flag', async () => {
  vi.useFakeTimers(); const feature = await import('./feature');
  fixture.list.mockResolvedValue(automaticRegistry());
  await feature.configureRpcFeature({ status: 'enabled', settings });
  automaticDisposers.push(feature.startRpcAutomaticConnections());
  await vi.advanceTimersByTimeAsync(100);
  expect(fixture.startAutomaticConnections).toHaveBeenCalledOnce();
  await feature.configureRpcFeature({ status: 'disabled', settings });
  await feature.configureRpcFeature({ status: 'enabled', settings });
  await vi.advanceTimersByTimeAsync(1000);
  window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.startAutomaticConnections.mock.calls.length).toBeGreaterThan(1); expect(fixture.create).toHaveBeenCalledOnce();
});

it('disabled app-ready retains readiness so later enable starts the saved policy', async () => {
  vi.useFakeTimers(); const feature = await import('./feature'); fixture.list.mockResolvedValue(automaticRegistry());
  await feature.configureRpcFeature({ status: 'disabled', settings }); automaticDisposers.push(feature.startRpcAutomaticConnections());
  await vi.advanceTimersByTimeAsync(1000); await feature.configureRpcFeature({ status: 'enabled', settings });
  for (const name of ['focus', 'pageshow', 'online']) window.dispatchEvent(new Event(name));
  for (const listener of fixture.registryListeners) listener();
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.startAutomaticConnections).toHaveBeenCalledOnce(); expect(fixture.create).toHaveBeenCalledOnce();
});

it('OFF invalidates an awaiting startup read even if ON returns before that read resolves', async () => {
  vi.useFakeTimers(); const feature = await import('./feature'), listed = Promise.withResolvers<NaidanRpcRegistrySnapshot>(); fixture.list.mockReturnValueOnce(listed.promise);
  await feature.configureRpcFeature({ status: 'enabled', settings }); automaticDisposers.push(feature.startRpcAutomaticConnections());
  await vi.advanceTimersByTimeAsync(100); expect(fixture.list).toHaveBeenCalledOnce();
  await feature.configureRpcFeature({ status: 'disabled', settings }); await feature.configureRpcFeature({ status: 'enabled', settings });
  listed.resolve(automaticRegistry()); await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.startAutomaticConnections).not.toHaveBeenCalled(); expect(fixture.create).not.toHaveBeenCalled();
});

it('retries failed startup catalogue reads on a later hint without polling', async () => {
  vi.useFakeTimers(); const feature = await import('./feature');
  fixture.list.mockRejectedValueOnce(new Error('not ready')).mockResolvedValue(automaticRegistry());
  await feature.configureRpcFeature({ status: 'enabled', settings }); automaticDisposers.push(feature.startRpcAutomaticConnections());
  await vi.advanceTimersByTimeAsync(60000); expect(fixture.list).toHaveBeenCalledOnce(); expect(fixture.create).not.toHaveBeenCalled();
  window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.startAutomaticConnections).toHaveBeenCalledOnce(); expect(fixture.list).toHaveBeenCalledTimes(2);
});

it('starts only from the fresh ON generation when an older startup read completes late', async () => {
  vi.useFakeTimers(); const feature = await import('./feature'), old = Promise.withResolvers<NaidanRpcRegistrySnapshot>();
  fixture.list.mockReturnValueOnce(old.promise).mockResolvedValue(automaticRegistry());
  await feature.configureRpcFeature({ status: 'enabled', settings }); automaticDisposers.push(feature.startRpcAutomaticConnections());
  await vi.advanceTimersByTimeAsync(100);
  await feature.configureRpcFeature({ status: 'disabled', settings }); await feature.configureRpcFeature({ status: 'enabled', settings });
  await vi.advanceTimersByTimeAsync(1000); expect(fixture.startAutomaticConnections).toHaveBeenCalledOnce();
  old.resolve(automaticRegistry()); await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.startAutomaticConnections).toHaveBeenCalledOnce();
});
