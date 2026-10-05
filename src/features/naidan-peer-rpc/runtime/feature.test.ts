import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Settings } from '@/01-models/types';
import type { createRpcStopControl } from './stop-control';

const fixture = vi.hoisted(() => ({ create: vi.fn(), setEnabled: vi.fn(async () => {}), revalidate: vi.fn(async () => {}) }));
vi.mock('./state', () => ({ createRpcManager: fixture.create }));
let control: ReturnType<typeof createRpcStopControl> | undefined;
const channels: { onmessage: ((event: { data: unknown }) => void) | undefined, postMessage: ReturnType<typeof vi.fn> }[] = [];
const settings = () => ({ experimental: { naidanRpc: 'enabled' } }) as Settings;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); channels.length = 0;
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
    control = created; return { setEnabled: fixture.setEnabled, revalidate: fixture.revalidate };
  });
});
afterEach(() => {
  control?.dispose(); control = undefined; vi.unstubAllGlobals(); vi.useRealTimers();
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
  channels[0]!.onmessage?.({ data: { type: 'registry-changed', settings: { allowedMethods: ['generateImage'] } } });
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
