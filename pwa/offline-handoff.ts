import { ACTIVATE_BUILD_MESSAGE } from '../src/logic/pwa/protocol';
import { requestBuildId } from '../src/logic/pwa/worker-request';

/** The active worker, not an individual page, owns stream admission and draining. */
export function createOfflineHandoff({ registration, isIdle }: {
  registration: ServiceWorkerRegistration;
  isIdle: () => boolean;
}) {
  let pending: { worker: ServiceWorker; active: ServiceWorker; buildId: string; sent: boolean; listener: () => void } | undefined;

  function clear(): void {
    if (!pending) return;
    pending.worker.removeEventListener('statechange', pending.listener);
    pending = undefined;
  }

  function isDraining(): boolean {
    if (!pending) return false;
    if (pending.worker.state === 'redundant' || (registration.waiting !== pending.worker && registration.active !== pending.worker)) clear();
    // Once sent, do not reopen admission on a timer: delivery may be delayed.
    // Existing downloads are already complete. The new worker starts open.
    return pending?.sent ?? false;
  }

  function resume(): void {
    if (isDraining() || !pending || !isIdle()) return;
    const target = pending;
    if (registration.active !== target.active || registration.waiting !== target.worker || target.worker.state !== 'installed') {
      clear(); return;
    }
    // This assignment and download admission run on this worker's single event
    // loop. No new stream can slip between the idle check and the handoff.
    target.sent = true;
    try {
      target.worker.postMessage({ type: ACTIVATE_BUILD_MESSAGE, buildId: target.buildId });
    } catch (error) {
      clear();
      console.warn('[PWA] Offline handoff could not be sent.', error);
    }
  }

  async function request({ buildId }: { buildId: string }): Promise<boolean> {
    const worker = registration.waiting;
    const active = registration.active;
    if (!worker || !active || worker === active || worker.state !== 'installed') return false;
    if (pending?.worker === worker && pending.buildId === buildId) {
      resume(); return true;
    }
    const identity = await requestBuildId({ worker, signal: new AbortController().signal });
    if (identity !== buildId || registration.waiting !== worker || registration.active !== active || worker.state !== 'installed') return false;
    clear();
    pending = {
      worker,
      active,
      buildId,
      sent: false,
      listener: () => {
        isDraining();
      },
    };
    worker.addEventListener('statechange', pending.listener);
    resume();
    return true;
  }

  return { request, resume, isDraining };
}

export const TEST_ONLY = {
};
