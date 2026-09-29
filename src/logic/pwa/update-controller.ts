import type { PWAUpdateState } from '@/composables/usePWAUpdate';
import { activateUpdate } from '@/logic/pwa/activate-update';
import { requestNetworkUpdate } from '@/logic/pwa/worker-request';

export interface PWAUpdatePlatform {
  serviceWorkers: ServiceWorkerContainer;
  reload: () => void;
}

/** Detection only; apply() below is the complete, two-path update transaction. */
export function createPWAUpdateController({ platform, baseUrl, onState, onOfflineReady, onError, onWarning }: {
  platform: PWAUpdatePlatform;
  baseUrl: URL;
  onState: ({ next }: { next: PWAUpdateState }) => void;
  onOfflineReady: () => void;
  onError: ({ message, error }: { message: string; error: unknown }) => void;
  onWarning: ({ message }: { message: string }) => void;
}): { dispose: () => void } {
  const sw = platform.serviceWorkers;
  const lifetime = new AbortController();
  // Remember a worker, not a page version. A page first opened without a
  // controller acquires its baseline when the initial worker becomes active.
  let pageController = sw.controller;
  const observed = new Map<ServiceWorker, () => void>();
  let registration: ServiceWorkerRegistration | undefined;
  let updateSeen = false;
  let firstInstallation = false;
  let offlineAnnounced = false;
  const disposed = () => lifetime.signal.aborted;

  async function apply(): Promise<void> {
    if (disposed() || !registration) throw new Error('The update runtime was stopped.');
    try {
      // Re-read slots at click time. The update may have become ready since the
      // button appeared. No networking or cache changes on the prepared path.
      const prepared = preparedWorker();
      if (prepared) {
        // Another tab may have moved it from waiting to active/activating.
        // The same bounded activation wait handles both cases (and activated).
        await activateUpdate({ worker: prepared, signal: lifetime.signal });
      } else {
        const controller = sw.controller;
        if (!controller || controller !== registration.active) throw new Error('This page is not controlled by the application service worker. Reload and retry.');
        await requestNetworkUpdate({ worker: controller, signal: lifetime.signal });
      }
      if (disposed()) throw new Error('The update runtime was stopped.');
      platform.reload(); // Always a FULL document reload, including hash routes.
    } catch (error) {
      if (!disposed()) onError({ message: 'Failed to apply the application update.', error });
      throw error;
    } finally {
      if (!disposed()) synchronize();
    }
  }

  function preparedWorker(): ServiceWorker | undefined {
    const waiting = registration?.waiting;
    // A first installation is offline preparation, not an application update.
    if (registration?.active && waiting && waiting !== registration.active
      && (waiting.state === 'installed' || waiting.state === 'activating')) return waiting;
    const active = registration?.active;
    if (pageController && active && active !== pageController
      && (active.state === 'activating' || active.state === 'activated')) return active;
    return undefined;
  }

  function synchronize(): void {
    if (disposed() || !registration) return;
    const current = registration;
    pageController ??= current.active;
    const workers = [current.installing, current.waiting, current.active].filter(worker => worker !== null);
    for (const [worker, listener] of observed) {
      if (workers.includes(worker)) continue;
      worker.removeEventListener('statechange', listener);
      observed.delete(worker);
    }
    for (const worker of workers) {
      if (observed.has(worker)) continue;
      let previous = worker.state;
      const activeWhenObserved = current.active;
      const waitingWhenObserved = current.waiting;
      const listener = () => {
        const stopped = (previous === 'parsed' || previous === 'installing') && worker.state === 'redundant';
        previous = worker.state;
        const superseded = [current.installing, current.waiting].some(replacement =>
          replacement && replacement !== worker && replacement !== waitingWhenObserved && replacement.state !== 'redundant')
          || (current.active && current.active !== worker && current.active !== activeWhenObserved);
        synchronize();
        if (stopped && !superseded && !disposed()) onWarning({ message: 'Offline preparation stopped. The service worker console contains any resource-level error supplied by the browser.' });
      };
      observed.set(worker, listener);
      worker.addEventListener('statechange', listener);
    }
    if (current.active && [current.installing, current.waiting].some(worker =>
      worker && worker !== current.active && worker.state !== 'redundant')) updateSeen = true;
    if (preparedWorker()) {
      onState({ next: { kind: 'ready', handler: apply } });
    } else if (updateSeen) {
      // Keep the deliberate network choice even if full precaching has failed.
      onState({ next: { kind: 'preparing',
        handler: sw.controller && sw.controller === current.active && current.active.state === 'activated' ? apply : undefined,
      } });
    } else {
      onState({ next: { kind: 'idle' } });
      if (firstInstallation && current.active?.state === 'activated' && !offlineAnnounced) {
        offlineAnnounced = true;
        onOfflineReady();
      }
    }
  }

  function attach({ next }: { next: ServiceWorkerRegistration }): void {
    if (disposed() || next.scope !== baseUrl.href) return;
    if (!registration) firstInstallation = !next.active;
    registration?.removeEventListener('updatefound', synchronize);
    registration = next;
    registration.addEventListener('updatefound', synchronize);
    synchronize();
  }

  sw.addEventListener('controllerchange', synchronize);
  // Observe an existing installer first: register/update jobs can queue behind
  // its full download. Registration itself still starts only after surface paint.
  void sw.getRegistration(baseUrl.href).then(existing => {
    if (disposed()) return;
    if (existing?.scope === baseUrl.href) attach({ next: existing });
    return sw.register(new URL('sw.js', baseUrl).href, { scope: baseUrl.href, updateViaCache: 'none' });
  }).then(next => {
    if (next) attach({ next });
  }).catch((error: unknown) => {
    if (!disposed()) onError({ message: 'Failed to register the service worker.', error });
  });

  return { dispose() {
    lifetime.abort();
    sw.removeEventListener('controllerchange', synchronize);
    registration?.removeEventListener('updatefound', synchronize);
    for (const [worker, listener] of observed) worker.removeEventListener('statechange', listener);
    observed.clear();
  } };
}

export const TEST_ONLY = {
};
