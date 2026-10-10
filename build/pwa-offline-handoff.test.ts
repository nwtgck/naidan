// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfflineHandoff } from '../pwa/offline-handoff';
import { waitForActiveCleanup } from '../pwa/precache-lifecycle';
import { ACTIVATE_BUILD_MESSAGE, BUILD_ID_MESSAGE } from '../src/logic/pwa/protocol';

class WorkerHandle extends EventTarget {
  state: ServiceWorkerState = 'installed';
  buildId = 'build-b';
  postMessage = vi.fn((data: { type: string }, ports?: MessagePort[]) => {
    if (data.type === BUILD_ID_MESSAGE) ports?.[0]?.postMessage({ type: BUILD_ID_MESSAGE, buildId: this.buildId });
  });

  native(): ServiceWorker {
    return this as unknown as ServiceWorker;
  }

  transition({ state }: { state: ServiceWorkerState }): void {
    this.state = state; this.dispatchEvent(new Event('statechange'));
  }
}

function fixture() {
  const old = new WorkerHandle(), next = new WorkerHandle();
  old.state = 'activated'; old.buildId = 'build-a';
  const registration = { active: old.native(), waiting: next.native() as ServiceWorker | null } as ServiceWorkerRegistration;
  const isIdle = vi.fn().mockReturnValue(false);
  const handoff = createOfflineHandoff({ registration, isIdle });
  const messages = () => next.postMessage.mock.calls.map(([data]) => data).filter(data => data.type !== BUILD_ID_MESSAGE);
  return { old, next, registration, isIdle, handoff, messages };
}

afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers();
});

describe('worker-owned offline handoff', () => {
  it('waits for all active sessions, then closes admission atomically before sending', async () => {
    const f = fixture();
    expect(await f.handoff.request({ buildId: 'build-b' })).toBe(true);
    expect(f.messages()).toEqual([]);
    expect(f.handoff.isDraining()).toBe(false);
    f.isIdle.mockReturnValue(true);
    const original = f.next.postMessage.getMockImplementation()!;
    f.next.postMessage.mockImplementation((data, ports) => {
      if (data.type === ACTIVATE_BUILD_MESSAGE) expect(f.handoff.isDraining()).toBe(true);
      original(data, ports);
    });
    f.handoff.resume(); f.handoff.resume();
    expect(f.messages()).toEqual([{ type: ACTIVATE_BUILD_MESSAGE, buildId: 'build-b' }]);
    expect(f.handoff.isDraining()).toBe(true);
  });

  it('does not drain or activate a different build', async () => {
    const f = fixture(); f.isIdle.mockReturnValue(true);
    expect(await f.handoff.request({ buildId: 'build-c' })).toBe(false);
    expect(f.messages()).toEqual([]); expect(f.handoff.isDraining()).toBe(false);
  });

  it('does not substitute a replacement worker after a deferred identity reply', async () => {
    const f = fixture();
    let reply!: MessagePort;
    f.next.postMessage.mockImplementation((_data, ports) => {
      reply = ports![0]!;
    });
    const operation = f.handoff.request({ buildId: 'build-b' });
    const newer = new WorkerHandle(); newer.buildId = 'build-c';
    Object.assign(f.registration, { waiting: newer.native() });
    reply.postMessage({ type: BUILD_ID_MESSAGE, buildId: 'build-b' });
    expect(await operation).toBe(false);
    expect(newer.postMessage).not.toHaveBeenCalled();
    expect(f.handoff.isDraining()).toBe(false);
  });

  it('releases a superseded target and never activates its successor implicitly', async () => {
    const f = fixture(); await f.handoff.request({ buildId: 'build-b' });
    const newer = new WorkerHandle(); newer.buildId = 'build-c';
    Object.assign(f.registration, { waiting: newer.native() });
    f.next.transition({ state: 'redundant' });
    f.isIdle.mockReturnValue(true); f.handoff.resume();
    expect(f.messages()).toEqual([]); expect(newer.postMessage).not.toHaveBeenCalled();
    expect(f.handoff.isDraining()).toBe(false);
  });

  it('does not reopen admission just because the target moved from waiting to active', async () => {
    const f = fixture(); f.isIdle.mockReturnValue(true); await f.handoff.request({ buildId: 'build-b' });
    Object.assign(f.registration, { active: f.next.native(), waiting: null });
    f.next.transition({ state: 'activating' });
    expect(f.handoff.isDraining()).toBe(true);
    f.next.transition({ state: 'activated' });
    expect(f.handoff.isDraining()).toBe(true);
    expect(f.messages()).toHaveLength(1);
  });

  it('does not keep admission closed if postMessage synchronously failed', async () => {
    const f = fixture(); vi.spyOn(console, 'warn').mockImplementation(() => {});
    await f.handoff.request({ buildId: 'build-b' });
    f.next.postMessage.mockImplementation(() => {
      throw new Error('terminated');
    });
    f.isIdle.mockReturnValue(true); f.handoff.resume();
    expect(f.handoff.isDraining()).toBe(false);
  });

  it('deduplicates repeated page requests while draining a busy worker', async () => {
    const f = fixture();
    await f.handoff.request({ buildId: 'build-b' });
    await f.handoff.request({ buildId: 'build-b' });
    expect(f.next.postMessage).toHaveBeenCalledTimes(1);
    f.isIdle.mockReturnValue(true); f.handoff.resume();
    expect(f.messages()).toHaveLength(1);
  });

  it('cannot prepare a handoff without an installed waiting worker', async () => {
    const f = fixture(); f.next.state = 'installing';
    expect(await f.handoff.request({ buildId: 'build-b' })).toBe(false);
    expect(f.next.postMessage).not.toHaveBeenCalled();
  });
});

describe('shared precache activation boundary', () => {
  it('does not wait for normal active or absent workers', async () => {
    const f = fixture(); await waitForActiveCleanup({ registration: f.registration });
    Object.assign(f.registration, { active: null });
    await waitForActiveCleanup({ registration: f.registration });
  });

  it('waits until an activating worker finishes cleanup and releases its listener', async () => {
    const f = fixture(); f.old.state = 'activating';
    const remove = vi.spyOn(f.old, 'removeEventListener'); let finished = false;
    const operation = waitForActiveCleanup({ registration: f.registration }).then(() => {
      finished = true;
    });
    await Promise.resolve(); expect(finished).toBe(false);
    f.old.transition({ state: 'activated' }); await operation;
    expect(finished).toBe(true); expect(remove).toHaveBeenCalledOnce();
  });
});
