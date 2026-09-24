// @vitest-environment node
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPWAUpdateController, type PWAUpdatePlatform } from './update-controller';
import type { PWAUpdateState } from '@/composables/usePWAUpdate';
import { USE_NETWORK_MESSAGE } from './protocol';

class WorkerHandle extends EventTarget {
  state: ServiceWorkerState = 'installing';
  scriptURL = 'https://example.test/naidan/sw.js';
  postMessage = vi.fn((_data: unknown, ports?: MessagePort[]) => ports?.[0]?.postMessage(USE_NETWORK_MESSAGE));
  native(): ServiceWorker {
    return this as unknown as ServiceWorker;
  }
  transition(state: ServiceWorkerState): void {
    this.state = state; this.dispatchEvent(new Event('statechange'));
  }
}
const disposers: Array<() => void> = [];
const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};
function setup({ registerPending = false, firstInstall = false } = {}) {
  const old = new WorkerHandle(); old.state = 'activated';
  const next = new WorkerHandle();
  const reg = Object.assign(new EventTarget(), {
    scope: 'https://example.test/naidan/', active: firstInstall ? null : old.native(),
    installing: next.native() as ServiceWorker | null, waiting: null as ServiceWorker | null,
  });
  const container = Object.assign(new EventTarget(), {
    controller: firstInstall ? null : old.native(),
    getRegistration: vi.fn().mockResolvedValue(reg),
    register: vi.fn().mockImplementation(() => registerPending ? new Promise(() => {}) : Promise.resolve(reg)),
  });
  const states: PWAUpdateState[] = [];
  const platform: PWAUpdatePlatform = { serviceWorkers: container as unknown as ServiceWorkerContainer, reload: vi.fn() };
  const onError = vi.fn(), onWarning = vi.fn(), onOfflineReady = vi.fn();
  const controller = createPWAUpdateController({ platform, baseUrl: new URL(reg.scope), onState: ({ next }) => states.push(next), onError, onWarning, onOfflineReady });
  disposers.push(controller.dispose);
  const ready = () => {
    reg.installing = null; reg.waiting = next.native(); next.transition('installed');
  };
  const activate = () => {
    reg.active = next.native(); reg.waiting = null; reg.installing = null;
    // Deliberately NO controllerchange: the ready path must not depend on it.
    next.transition('activated');
  };
  const action = () => {
    const state = states.at(-1);
    if (!state || state.kind === 'idle' || !state.handler) throw new Error('No action');
    return state.handler();
  };
  return { old, next, reg, container, platform, states, controller, ready, activate, action, onError, onWarning, onOfflineReady };
}
beforeEach(() => vi.stubGlobal('MessageChannel', MessageChannel));
afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose());
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('auditable two-path PWA update', () => {
  it('observes the existing installer while register is still queued', async () => {
    const f = setup({ registerPending: true }); await flush();
    expect(f.states.at(-1)?.kind).toBe('preparing');
    expect(f.container.register).toHaveBeenCalledWith('https://example.test/naidan/sw.js', { scope: f.reg.scope, updateViaCache: 'none' });
    await f.action();
    expect(f.next.state).toBe('installing');
    expect(f.next.postMessage).not.toHaveBeenCalled();
    expect(f.old.postMessage.mock.calls[0]?.[0]).toEqual({ type: USE_NETWORK_MESSAGE });
    expect(f.platform.reload).toHaveBeenCalledOnce();
  });
  it('waits for ACTUAL activation then reloads without controllerchange', async () => {
    const f = setup(); await flush(); f.ready();
    const action = f.action();
    expect(f.next.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(f.old.postMessage).not.toHaveBeenCalled();
    expect(f.platform.reload).not.toHaveBeenCalled();
    f.next.transition('activating'); await flush();
    expect(f.platform.reload).not.toHaveBeenCalled();
    f.activate(); await action;
    expect(f.platform.reload).toHaveBeenCalledOnce();
  });
  it('rechecks readiness rather than following a stale preparing action', async () => {
    const f = setup(); await flush();
    const state = f.states.at(-1)!;
    f.ready();
    const action = state.kind === 'preparing' ? state.handler!() : Promise.reject(new Error('bad test state'));
    expect(f.old.postMessage).not.toHaveBeenCalled();
    f.activate(); await action;
    expect(f.platform.reload).toHaveBeenCalledOnce();
  });
  it('only reloads when another tab has already activated the update', async () => {
    const f = setup(); await flush(); f.ready(); f.activate();
    await f.action();
    expect(f.old.postMessage).not.toHaveBeenCalled();
    expect(f.next.postMessage).not.toHaveBeenCalled();
    expect(f.platform.reload).toHaveBeenCalledOnce();
  });
  it('keeps a failed installer as an explicit network option, not a synthetic error', async () => {
    const f = setup(); await flush(); f.reg.installing = null; f.next.transition('redundant');
    expect(f.onWarning).toHaveBeenCalledOnce(); expect(f.onError).not.toHaveBeenCalled();
    await f.action(); expect(f.platform.reload).toHaveBeenCalledOnce();
  });
  it('first offline preparation is not an application update', async () => {
    const f = setup({ firstInstall: true }); await flush();
    expect(f.states.at(-1)).toEqual({ kind: 'idle' });
    f.activate();
    expect(f.onOfflineReady).toHaveBeenCalledOnce();
    expect(f.states.at(-1)).toEqual({ kind: 'idle' });
  });
  it('does not call the first installed worker an update before activation', async () => {
    const f = setup({ firstInstall: true }); await flush(); f.ready();
    expect(f.states.at(-1)).toEqual({ kind: 'idle' });
    f.reg.active = f.next.native(); f.next.transition('activating');
    expect(f.states.at(-1)).toEqual({ kind: 'idle' });
    f.activate();
    expect(f.states.at(-1)).toEqual({ kind: 'idle' });
    expect(f.onOfflineReady).toHaveBeenCalledOnce();
  });
  it('waits for an update another tab has already moved to the active slot', async () => {
    const f = setup(); await flush(); f.ready();
    f.reg.waiting = null; f.reg.active = f.next.native(); f.next.transition('activating');
    const action = f.action();
    await flush();
    expect(f.platform.reload).not.toHaveBeenCalled();
    expect(f.old.postMessage).not.toHaveBeenCalled();
    f.activate(); await action;
    expect(f.platform.reload).toHaveBeenCalledOnce();
  });
  it('retains the first active worker as baseline for a page initially without a controller', async () => {
    const f = setup({ firstInstall: true }); await flush(); f.activate();
    const later = new WorkerHandle(); later.state = 'activated';
    f.reg.active = later.native(); f.container.controller = later.native();
    f.container.dispatchEvent(new Event('controllerchange'));
    expect(f.states.at(-1)?.kind).toBe('ready');
    await f.action();
    expect(later.postMessage).not.toHaveBeenCalled();
    expect(f.platform.reload).toHaveBeenCalledOnce();
  });
  it('does not report a normally superseded installer as a preparation failure', async () => {
    const f = setup(); await flush();
    f.reg.installing = new WorkerHandle().native(); f.next.transition('redundant');
    expect(f.onWarning).not.toHaveBeenCalled();
    expect(f.states.at(-1)?.kind).toBe('preparing');
  });
  it('times out an unsupported/legacy network command without reloading', async () => {
    vi.useFakeTimers(); const f = setup(); await flush(); f.old.postMessage.mockImplementation(() => {});
    const rejected = expect(f.action()).rejects.toThrow('did not enable');
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    expect(f.onError).toHaveBeenCalledWith({ message: 'Failed to apply the application update.', error: expect.any(Error) });
    expect(f.platform.reload).not.toHaveBeenCalled();
    expect(f.states.at(-1)?.kind).toBe('preparing');
  });
  it('bounds activation waits and keeps the prepared action retryable', async () => {
    vi.useFakeTimers(); const f = setup(); await flush(); f.ready();
    const rejected = expect(f.action()).rejects.toThrow('did not activate');
    await vi.advanceTimersByTimeAsync(15000); await rejected;
    expect(f.platform.reload).not.toHaveBeenCalled();
    const retry = f.action(); f.activate(); await retry;
    expect(f.platform.reload).toHaveBeenCalledOnce();
  });
  it('rejects a replaced waiting worker without waiting for the timeout', async () => {
    const f = setup(); await flush(); f.ready();
    const rejected = expect(f.action()).rejects.toThrow('replaced');
    f.next.transition('redundant'); await rejected;
    expect(f.platform.reload).not.toHaveBeenCalled();
  });
  it('aborts an outstanding action on disposal and never reloads later', async () => {
    const f = setup(); await flush(); f.ready();
    const rejected = expect(f.action()).rejects.toThrow('stopped');
    f.controller.dispose(); await rejected; f.activate();
    expect(f.platform.reload).not.toHaveBeenCalled();
  });
  it('retains replacement updates that appear during a pending click', async () => {
    const f = setup(); await flush(); f.ready();
    const action = f.action();
    const newer = new WorkerHandle();
    f.reg.installing = newer.native(); f.container.dispatchEvent(new Event('controllerchange'));
    f.reg.active = f.next.native(); f.reg.waiting = null; f.next.transition('activated');
    await action;
    f.reg.waiting = newer.native(); f.reg.installing = null; newer.transition('installed');
    expect(f.states.at(-1)?.kind).toBe('ready');
    const again = f.action();
    expect(newer.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    f.reg.active = newer.native(); f.reg.waiting = null; newer.transition('activated');
    await again;
    expect(f.platform.reload).toHaveBeenCalledTimes(2);
  });
  it('retains observation and prepared updates after a register failure', async () => {
    const f = setup(); f.container.register.mockRejectedValue(new Error('registration offline'));
    await flush();
    expect(f.onError).toHaveBeenCalledWith({ message: 'Failed to register the service worker.', error: expect.any(Error) });
    f.ready(); const action = f.action(); f.activate(); await action;
    expect(f.platform.reload).toHaveBeenCalledOnce();
  });
  it('does not register after disposal while an existing registration is being read', async () => {
    const f = setup(); f.controller.dispose(); await flush();
    expect(f.container.register).not.toHaveBeenCalled();
    expect(f.states).toEqual([]);
  });
  it('disables early updating when the page has lost its controller but retains prepared updates', async () => {
    const f = setup(); await flush(); f.container.controller = null;
    f.container.dispatchEvent(new Event('controllerchange'));
    expect(f.states.at(-1)).toEqual({ kind: 'preparing', handler: undefined });
    f.ready(); const action = f.action(); f.activate(); await action;
    expect(f.platform.reload).toHaveBeenCalledOnce();
    expect(f.old.postMessage).not.toHaveBeenCalled();
  });
  it('never sends a network command to an unrelated scope controller', async () => {
    const f = setup(); await flush(); f.container.controller = new WorkerHandle().native();
    await expect(f.action()).rejects.toThrow('not controlled');
    expect(f.old.postMessage).not.toHaveBeenCalled();
    expect(f.platform.reload).not.toHaveBeenCalled();
  });
});
