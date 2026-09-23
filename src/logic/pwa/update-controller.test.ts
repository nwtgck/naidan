import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPWAUpdateController, type PWAUpdatePlatform } from '@/logic/pwa/update-controller';
import type { PWAUpdateState } from '@/composables/usePWAUpdate';
import { NETWORK_UPDATE_PARAMETER, PWA_PROTOCOL } from '@/logic/pwa/protocol';
import { requestPWAWorker } from '@/logic/pwa/worker-request';

// Replace the browser message transport, typed from its real public contract.
// App, settings, router, main entry and application imports are not substituted.
vi.mock('@/logic/pwa/worker-request', () => ({ requestPWAWorker: vi.fn() }));
const ask = vi.mocked(requestPWAWorker);
class WorkerHandle extends EventTarget {
  state: ServiceWorkerState = 'installing';
  scriptURL = 'https://example.test/naidan/sw.js';
  postMessage = vi.fn();
  readonly buildId: string;
  constructor(buildId: string) {
    super(); this.buildId = buildId;
  }
  native(): ServiceWorker {
    return this as unknown as ServiceWorker;
  }
  transition(state: ServiceWorkerState) {
    this.state = state; this.dispatchEvent(new Event('statechange'));
  }
}
const disposers: Array<() => void> = [];
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const token = '01234567-1234-1234-1234-0123456789ab';

function setup({ online = false, pageBuildId = 'old', existing = true, registerPending = false } = {}) {
  const old = new WorkerHandle('old'); old.state = 'activated';
  const next = new WorkerHandle('new');
  const reg = Object.assign(new EventTarget(), { scope: 'https://example.test/naidan/', active: old.native(), installing: next.native() as ServiceWorker | null, waiting: null as ServiceWorker | null });
  const container = Object.assign(new EventTarget(), {
    controller: old.native() as ServiceWorker | null,
    getRegistration: vi.fn().mockResolvedValue(existing ? reg : undefined),
    register: vi.fn().mockImplementation(() => registerPending ? new Promise(() => {}) : Promise.resolve(reg)),
  });
  let href = `https://example.test/naidan/?other=keep${online ? `&${NETWORK_UPDATE_PARAMETER}=${token}` : ''}#/chat/42`;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response('<!doctype html><title>Naidan</title>', { headers: { 'content-type': 'text/html' } }));
  const platform: PWAUpdatePlatform = {
    serviceWorkers: container as unknown as ServiceWorkerContainer,
    getHref: () => href,
    navigate: vi.fn(),
    replaceHistory: vi.fn(({ href: next }: { href: string }) => {
      href = next;
    }),
    fetch,
    createToken: () => token,
  };
  const states: PWAUpdateState[] = [];
  const onError = vi.fn(); const onOfflineReady = vi.fn();
  const start = () => {
    const controller = createPWAUpdateController({ platform, baseUrl: new URL(reg.scope), buildId: pageBuildId, onState: ({ next }) => states.push(next), onError, onOfflineReady });
    disposers.push(controller.dispose);
    return controller;
  };
  const makeReady = () => {
    reg.waiting = next.native(); reg.installing = null; next.transition('installed');
  };
  const takeControl = () => {
    reg.active = next.native(); reg.waiting = null; next.state = 'activated';
    container.controller = next.native(); container.dispatchEvent(new Event('controllerchange'));
  };
  const action = () => {
    const state = states.at(-1);
    if (!state || state.kind === 'idle' || !state.handler) throw new Error(`No action in ${state?.kind}`);
    return state.handler();
  };
  return { old, next, reg, container, platform, fetch, start, states, makeReady, takeControl, action, onError, onOfflineReady };
}

beforeEach(() => {
  ask.mockReset();
  ask.mockImplementation(async ({ worker }) => ({ protocol: PWA_PROTOCOL, ok: true, buildId: (worker as unknown as WorkerHandle).buildId }));
});
afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose()); vi.useRealTimers();
});

describe('post-paint update controller', () => {
  it('observes an existing downloading update without waiting for register to finish', async () => {
    const f = setup({ registerPending: true }); f.start(); await flush();
    expect(f.states.at(-1)).toEqual({ kind: 'preparing', handler: expect.any(Function) });
    expect(f.container.getRegistration).toHaveBeenCalledWith(f.reg.scope);
    expect(f.container.register).toHaveBeenCalledWith('https://example.test/naidan/sw.js', { scope: f.reg.scope, updateViaCache: 'none' });
  });

  it('allows an immediate NETWORK reload while full precaching remains installing', async () => {
    const f = setup({ registerPending: true }); f.start(); await flush();
    await f.action();
    expect(f.next.state).toBe('installing');
    expect(f.next.postMessage).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledOnce();
    const destination = new URL(vi.mocked(f.platform.navigate).mock.calls[0]![0].href);
    expect(destination.searchParams.get(NETWORK_UPDATE_PARAMETER)).toBe(token);
    expect(destination.searchParams.get('other')).toBe('keep');
    expect(destination.hash).toBe('#/chat/42');
    expect(f.fetch).toHaveBeenCalledWith(destination.href, expect.objectContaining({ cache: 'no-store', redirect: 'error' }));
  });

  it('keeps the existing page usable on a failed HTML probe, then permits retry', async () => {
    const f = setup(); f.start(); await flush();
    f.fetch.mockRejectedValueOnce(new TypeError('offline'));
    await expect(f.action()).rejects.toThrow('offline');
    expect(f.platform.navigate).not.toHaveBeenCalled();
    expect(f.onError).toHaveBeenCalledOnce();
    await f.action();
    expect(f.platform.navigate).toHaveBeenCalledOnce();
  });

  it.each([404, 500])('rejects HTTP %s instead of abandoning a usable page', async status => {
    const f = setup(); f.start(); await flush();
    f.fetch.mockResolvedValueOnce(new Response('error', { status, headers: { 'content-type': 'text/html' } }));
    await expect(f.action()).rejects.toThrow('not available');
    expect(f.platform.navigate).not.toHaveBeenCalled();
  });

  it('rejects a success response that is not an HTML application document', async () => {
    const f = setup(); f.start(); await flush();
    f.fetch.mockResolvedValueOnce(new Response('{}', { headers: { 'content-type': 'application/json' } }));
    await expect(f.action()).rejects.toThrow('not available');
    expect(f.platform.navigate).not.toHaveBeenCalled();
  });

  it('uses the ordinary offline-capable path when a waiting update is ready', async () => {
    const f = setup(); f.reg.installing = null; f.reg.waiting = f.next.native(); f.next.state = 'installed';
    f.start(); await flush();
    const action = f.action();
    expect(f.next.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.platform.navigate).not.toHaveBeenCalled();
    f.takeControl(); await action;
    expect(f.platform.navigate).toHaveBeenCalledWith({ href: 'https://example.test/naidan/?other=keep#/chat/42' });
  });

  it('rechecks waiting at click time rather than starting an unnecessary online session', async () => {
    const f = setup(); f.start(); await flush();
    const state = f.states.at(-1)!;
    expect(state.kind).toBe('preparing');
    f.reg.installing = null; f.reg.waiting = f.next.native(); f.next.state = 'installed';
    const action = state.kind === 'preparing' ? state.handler!() : Promise.reject(new Error('bad test state'));
    expect(f.fetch).not.toHaveBeenCalled(); f.takeControl(); await action;
  });

  it('does not promise network bypass with a legacy controller', async () => {
    const f = setup(); ask.mockRejectedValue(new Error('unsupported')); f.start(); await flush();
    expect(f.states.at(-1)).toEqual({ kind: 'preparing' });
    f.makeReady(); await flush();
    expect(f.states.at(-1)).toEqual({ kind: 'ready', handler: expect.any(Function) });
  });

  it('restores FULL offline support for the already-running build without another reload', async () => {
    const f = setup({ online: true, pageBuildId: 'new' }); f.start(); await flush();
    expect(f.states.at(-1)?.kind).toBe('idle');
    expect(f.next.postMessage).not.toHaveBeenCalled();
    expect(f.platform.replaceHistory).not.toHaveBeenCalled();
    f.makeReady(); await flush();
    expect(f.next.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'SKIP_WAITING' });
    f.takeControl(); await flush();
    expect(f.platform.navigate).not.toHaveBeenCalled();
    expect(f.platform.replaceHistory).toHaveBeenCalledWith({ href: 'https://example.test/naidan/?other=keep#/chat/42' });
    expect(f.onOfflineReady).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledWith({ worker: f.next.native(), request: { protocol: PWA_PROTOCOL, type: 'complete-page', buildId: 'new' } });
  });

  it('does not automatically activate a DIFFERENT later build during an online session', async () => {
    const f = setup({ online: true, pageBuildId: 'running-other-build' }); f.start(); await flush();
    f.makeReady(); await flush();
    expect(f.next.postMessage).not.toHaveBeenCalled();
    expect(f.states.at(-1)?.kind).toBe('ready');
    expect(f.platform.replaceHistory).not.toHaveBeenCalled();
  });

  it('publishes readiness that arrived during a failing network probe instead of restoring a stale action', async () => {
    const f = setup(); f.start(); await flush();
    let reject!: (error: Error) => void;
    f.fetch.mockImplementationOnce(() => new Promise((_resolve, fail) => {
      reject = fail;
    }));
    const action = f.action(); await flush(); f.makeReady();
    reject(new Error('network lost')); await expect(action).rejects.toThrow('network lost');
    expect(f.states.at(-1)?.kind).toBe('ready');
    const retry = f.action(); f.takeControl(); await retry;
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it('keeps an explicit action when a waiting worker cannot answer the cross-version identity protocol', async () => {
    const f = setup({ online: true, pageBuildId: 'running' });
    ask.mockImplementation(async ({ worker }) => {
      if (worker === f.next.native()) throw new Error('legacy candidate');
      return { protocol: PWA_PROTOCOL, ok: true, buildId: 'old' };
    });
    f.start(); await flush(); f.makeReady(); await flush();
    expect(f.states.at(-1)?.kind).toBe('ready');
    expect(f.next.postMessage).not.toHaveBeenCalled();
  });

  it('keeps the online choice when a detected update fails full precaching', async () => {
    const f = setup(); f.start(); await flush();
    f.reg.installing = null; f.next.transition('redundant'); await flush();
    expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Failed to prepare the offline application update.' }));
    expect(f.states.at(-1)).toEqual({ kind: 'preparing', handler: expect.any(Function) });
    await f.action();
    expect(f.platform.navigate).toHaveBeenCalledWith({ href: expect.stringContaining(NETWORK_UPDATE_PARAMETER) });
  });

  it('does not label first installation as an update', async () => {
    const f = setup({ existing: false }); f.reg.active = null as unknown as ServiceWorker; f.container.controller = null;
    f.start(); await flush();
    expect(f.states.at(-1)?.kind).toBe('idle');
    f.reg.active = f.next.native(); f.reg.installing = null; f.next.transition('activated'); await flush();
    expect(f.onOfflineReady).toHaveBeenCalledOnce();
  });

  it('does not automatically reload unrelated tabs on controllerchange', async () => {
    const f = setup(); f.start(); await flush(); f.takeControl(); await flush();
    expect(f.platform.navigate).not.toHaveBeenCalled();
  });

  it('stops a disposed runtime from navigating after a delayed successful probe', async () => {
    const f = setup(); const controller = f.start(); await flush();
    let resolve!: (response: Response) => void;
    f.fetch.mockImplementationOnce(() => new Promise(r => {
      resolve = r;
    }));
    const action = f.action(); await flush(); controller.dispose();
    resolve(new Response('html', { headers: { 'content-type': 'text/html' } }));
    await expect(action).rejects.toThrow('stopped');
    expect(f.platform.navigate).not.toHaveBeenCalled();
  });

  it('times out a ready activation and permits retry instead of indefinitely disabling the button', async () => {
    vi.useFakeTimers();
    const f = setup(); f.start(); await flush(); f.makeReady(); await flush();
    const action = f.action(); const rejected = expect(action).rejects.toThrow('did not activate');
    await vi.advanceTimersByTimeAsync(15001); await rejected;
    const retry = f.action(); f.takeControl(); await retry;
  });

  it('reports a registration error without an unhandled rejection', async () => {
    const f = setup({ existing: false }); f.container.register.mockRejectedValue(new Error('registration error'));
    f.start(); await flush(); expect(f.onError).toHaveBeenCalledOnce();
  });
});
