// @vitest-environment node
import { setImmediate } from 'node:timers/promises';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPWAUpdateController, type PWAUpdatePlatform } from './update-controller';
import type { PWAUpdateState } from '@/composables/usePWAUpdate';
import { BUILD_ID_MESSAGE, COMPLETE_OFFLINE_MESSAGE, USE_NETWORK_MESSAGE } from './protocol';

class WorkerHandle extends EventTarget {
  state: ServiceWorkerState = 'installing';
  scriptURL = 'https://example.test/naidan/sw.js';
  buildId = 'version-b';
  postMessage = vi.fn((data: unknown, ports?: MessagePort[]) => {
    const type = (data as { type?: string }).type;
    ports?.[0]?.postMessage(type === BUILD_ID_MESSAGE ? { type, buildId: this.buildId }
      : type === COMPLETE_OFFLINE_MESSAGE ? COMPLETE_OFFLINE_MESSAGE : USE_NETWORK_MESSAGE);
  });

  native(): ServiceWorker {
    return this as unknown as ServiceWorker;
  }

  transition(state: ServiceWorkerState): void {
    this.state = state; this.dispatchEvent(new Event('statechange'));
  }
}

const commands = (worker: WorkerHandle) => worker.postMessage.mock.calls.map(([data]) => data).filter(data => (data as { type: string }).type !== BUILD_ID_MESSAGE);

const disposers: Array<() => void> = [];

const flush = async () => {
  for (let n = 0; n < 12; n++) await setImmediate();
};

function setup({ registerPending = false, firstInstall = false, pageBuildId = 'version-a' } = {}) {
  const old = new WorkerHandle(); old.state = 'activated'; old.buildId = 'version-a';
  const next = new WorkerHandle();
  if (firstInstall) next.buildId = pageBuildId;
  const reg = Object.assign(new EventTarget(), {
    scope: 'https://example.test/naidan/',
    active: firstInstall ? null : old.native(),
    installing: next.native() as ServiceWorker | null,
    waiting: null as ServiceWorker | null,
    update: vi.fn().mockResolvedValue(undefined),
  });
  const container = Object.assign(new EventTarget(), {
    controller: firstInstall ? null : old.native(),
    getRegistration: vi.fn().mockResolvedValue(reg),
    register: vi.fn().mockImplementation(() => registerPending ? new Promise(() => {}) : Promise.resolve(reg)),
  });
  const states: PWAUpdateState[] = [];
  const platform: PWAUpdatePlatform = { serviceWorkers: container as unknown as ServiceWorkerContainer, reload: vi.fn() };
  const onError = vi.fn(), onWarning = vi.fn(), onOfflineReady = vi.fn();
  const controller = createPWAUpdateController({ platform, pageBuildId, baseUrl: new URL(reg.scope), onState: ({ next }) => states.push(next), onError, onWarning, onOfflineReady });
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
  it('does not announce the executing build after a network reload, even transiently', async () => {
    const f = setup({ pageBuildId: 'version-b' });
    await flush();
    expect(f.states.length).toBeGreaterThan(0);
    expect(f.states.every(state => state.kind === 'idle')).toBe(true);
  });

  it('observes the existing installer while register is still queued', async () => {
    const f = setup({ registerPending: true }); await flush();
    expect(f.states.at(-1)?.kind).toBe('preparing');
    expect(f.container.register).toHaveBeenCalledWith('https://example.test/naidan/sw.js', { scope: f.reg.scope, updateViaCache: 'none' });
    await f.action();
    expect(f.next.state).toBe('installing');
    expect(commands(f.next)).toEqual([]);
    expect(commands(f.old)[0]).toEqual({ type: USE_NETWORK_MESSAGE });
    expect(f.platform.reload).toHaveBeenCalledOnce();
  });

  it('waits for ACTUAL activation then reloads without controllerchange', async () => {
    const f = setup(); await flush(); f.ready();
    const action = f.action();
    expect(commands(f.next)).toContainEqual({ type: 'SKIP_WAITING' });
    expect(commands(f.old)).toEqual([]);
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
    expect(commands(f.old)).toEqual([]);
    f.activate(); await action;
    expect(f.platform.reload).toHaveBeenCalledOnce();
  });

  it('only reloads when another tab has already activated the update', async () => {
    const f = setup(); await flush(); f.ready(); f.activate();
    await f.action();
    expect(commands(f.old)).toEqual([]);
    expect(commands(f.next)).toEqual([]);
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
    expect(commands(f.old)).toEqual([]);
    f.activate(); await action;
    expect(f.platform.reload).toHaveBeenCalledOnce();
  });

  it('retains the first active worker as baseline for a page initially without a controller', async () => {
    const f = setup({ firstInstall: true }); await flush(); f.activate();
    const later = new WorkerHandle(); later.state = 'activated';
    f.reg.active = later.native(); f.container.controller = later.native();
    f.container.dispatchEvent(new Event('controllerchange'));
    await flush();
    expect(f.states.at(-1)?.kind).toBe('ready');
    await f.action();
    expect(commands(later)).toEqual([]);
    expect(f.platform.reload).toHaveBeenCalledOnce();
  });

  it('does not report a normally superseded installer as a preparation failure', async () => {
    const f = setup(); await flush();
    f.reg.installing = new WorkerHandle().native(); f.next.transition('redundant');
    expect(f.onWarning).not.toHaveBeenCalled();
    await flush();
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
    await flush();
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
    expect(commands(f.old)).toEqual([]);
  });

  it('never sends a network command to an unrelated scope controller', async () => {
    const f = setup(); await flush(); f.container.controller = new WorkerHandle().native();
    await expect(f.action()).rejects.toThrow('not controlled');
    expect(commands(f.old)).toEqual([]);
    expect(f.platform.reload).not.toHaveBeenCalled();
  });

  it('completes the executing build without ever exposing an application update', async () => {
    const f = setup({ pageBuildId: 'version-b' }); await flush(); f.ready(); await flush();
    expect(commands(f.old)).toEqual([{ type: COMPLETE_OFFLINE_MESSAGE, buildId: 'version-b' }]);
    expect(commands(f.next)).toEqual([]);
    f.container.dispatchEvent(new Event('controllerchange')); await flush();
    expect(commands(f.old)).toHaveLength(1);
    f.activate(); await flush();
    expect(f.states.every(state => state.kind === 'idle')).toBe(true);
    expect(f.platform.reload).not.toHaveBeenCalled();
    expect(f.onOfflineReady).toHaveBeenCalledOnce();
  });

  it('does not turn failure of the executing build into a second update', async () => {
    const f = setup({ pageBuildId: 'version-b' }); await flush();
    f.reg.installing = null; f.next.transition('redundant'); await flush();
    expect(f.states.every(state => state.kind === 'idle')).toBe(true);
    expect(f.onWarning).toHaveBeenCalledOnce();
    expect(f.platform.reload).not.toHaveBeenCalled();
  });

  it('keeps C visible while waiting B is this page\'s offline preparation, including C failure', async () => {
    const f = setup({ pageBuildId: 'version-b' }); await flush(); f.ready(); await flush();
    const newer = new WorkerHandle(); newer.buildId = 'version-c';
    f.reg.installing = newer.native(); f.reg.dispatchEvent(new Event('updatefound')); await flush();
    expect(f.states.at(-1)?.kind).toBe('preparing');
    expect(commands(f.next)).toEqual([]);
    f.reg.installing = null; newer.transition('redundant'); await flush();
    expect(f.states.at(-1)?.kind).toBe('preparing');
    expect(f.onWarning).toHaveBeenCalledOnce();
    expect(f.platform.reload).not.toHaveBeenCalled();
  });

  it('does not call a residual older B an update of C without a new successful check', async () => {
    const f = setup({ pageBuildId: 'version-c' });
    f.reg.update.mockImplementation(() => new Promise(() => {}));
    await flush(); f.ready(); await flush();
    expect(f.states.every(state => state.kind === 'idle')).toBe(true);
    expect(commands(f.old)).toEqual([]);
    expect(commands(f.next)).toEqual([]);
  });

  it('does not infer an update solely from an older active worker', async () => {
    const f = setup({ pageBuildId: 'version-b' });
    f.reg.installing = null;
    f.reg.update.mockRejectedValue(new Error('offline'));
    await flush();
    expect(f.states.every(state => state.kind === 'idle')).toBe(true);
    expect(commands(f.old)).toEqual([]);
  });

  it('ignores an obsolete identity reply after its worker has been replaced', async () => {
    const f = setup();
    let reply: MessagePort | undefined;
    f.next.postMessage.mockImplementation((_data, ports) => {
      reply = ports?.[0];
    });
    await flush();
    const newer = new WorkerHandle(); newer.buildId = 'version-a';
    f.reg.installing = newer.native(); f.reg.dispatchEvent(new Event('updatefound')); await flush();
    reply!.postMessage({ type: BUILD_ID_MESSAGE, buildId: 'version-b' }); await flush();
    expect(f.states.every(state => state.kind === 'idle')).toBe(true);
    reply!.close();
  });

  it('rejects a stale action after a same-build replacement instead of reloading', async () => {
    const f = setup(); await flush();
    const previous = f.states.at(-1)!;
    if (previous.kind === 'idle') throw new Error('Missing test action');
    const same = new WorkerHandle(); same.buildId = 'version-a';
    f.reg.installing = same.native(); f.reg.dispatchEvent(new Event('updatefound')); await flush();
    await expect(previous.handler!()).rejects.toThrow('no longer available');
    expect(f.platform.reload).not.toHaveBeenCalled();
  });

  it('shares concurrent update calls and requests only one reload', async () => {
    const f = setup(); await flush();
    const one = f.action(), two = f.action();
    expect(one).toBe(two);
    await Promise.all([one, two]);
    expect(commands(f.old)).toEqual([{ type: USE_NETWORK_MESSAGE }]);
    expect(f.platform.reload).toHaveBeenCalledOnce();
  });

  it('rejects an acknowledgement from a controller that changed during the operation', async () => {
    const f = setup(); await flush();
    f.old.postMessage.mockImplementation((_data, ports) => {
      f.reg.active = f.next.native(); f.container.controller = f.next.native();
      ports?.[0]?.postMessage(USE_NETWORK_MESSAGE);
    });
    await expect(f.action()).rejects.toThrow('changed during');
    expect(f.platform.reload).not.toHaveBeenCalled();
  });

  it('does not send unchecked activation to a legacy controller or re-offer the same build', async () => {
    vi.useFakeTimers();
    const f = setup({ pageBuildId: 'version-b' });
    f.old.postMessage.mockImplementation(() => {});
    await flush(); f.ready(); await flush();
    await vi.advanceTimersByTimeAsync(5000); await flush();
    expect(f.states.every(state => state.kind === 'idle')).toBe(true);
    expect(commands(f.next)).toEqual([]);
    expect(commands(f.old)).toEqual([{ type: COMPLETE_OFFLINE_MESSAGE, buildId: 'version-b' }]);
    expect(f.onWarning).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.platform.reload).not.toHaveBeenCalled();
  });

  it('cancels outstanding identity requests on disposal without late UI writes', async () => {
    vi.useFakeTimers(); const f = setup();
    f.next.postMessage.mockImplementation(() => {}); await flush();
    f.controller.dispose(); const count = f.states.length;
    await vi.runAllTimersAsync(); await flush();
    expect(f.states).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.platform.reload).not.toHaveBeenCalled();
  });

  it('does not re-announce offline readiness on every already-prepared page load', async () => {
    const f = setup(); f.reg.installing = null; await flush();
    expect(f.states.every(state => state.kind === 'idle')).toBe(true);
    expect(f.onOfflineReady).not.toHaveBeenCalled();
  });

  it('does not promote an unchanged older active slot just because update() resolved', async () => {
    const f = setup({ pageBuildId: 'version-b' }); f.reg.installing = null; await flush();
    expect(f.reg.update).toHaveBeenCalledOnce();
    expect(f.states.every(state => state.kind === 'idle')).toBe(true);
  });
});
