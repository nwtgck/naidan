
import type { PWAUpdateState } from './update-state';

import { activateUpdate } from './activate-update';

import { requestBuildId, requestNetworkUpdate, requestOfflineCompletion } from './worker-request';

export interface PWAUpdatePlatform {
  serviceWorkers: ServiceWorkerContainer;
  reload: () => void;
}

type Observation = {
  worker: ServiceWorker;
  listener: () => void;
  lifetime: AbortController;
  buildId: string | undefined;
  trusted: boolean;
  observedAt: number;
  queriedState: ServiceWorkerState | undefined;
  querying: boolean;
  completionController: ServiceWorker | undefined;
};

/** An executing build is never its own application update. Unknown is not different. */
export function createPWAUpdateController({ platform, baseUrl, pageBuildId, onState, onOfflineReady, onError, onWarning }: {
  platform: PWAUpdatePlatform;
  baseUrl: URL;
  pageBuildId: string;
  onState: ({ next }: { next: PWAUpdateState }) => void;
  onOfflineReady: () => void;
  onError: ({ message, error }: { message: string; error: unknown }) => void;
  onWarning: ({ message }: { message: string }) => void;
}): { dispose: () => void } {
  const sw = platform.serviceWorkers;
  const lifetime = new AbortController();
  const observed = new Map<ServiceWorker, Observation>();
  let registration: ServiceWorkerRegistration | undefined;
  let lastActive: ServiceWorker | null = null;
  let lineageKnown = false;
  let candidate: Observation | undefined;
  let offlineAnnounced = false;
  let offlinePending = false;
  let observationSequence = 0;
  let updateAvailable = false;
  let applying: Promise<void> | undefined;
  const disposed = () => lifetime.signal.aborted;

  function preparedWorker(): ServiceWorker | undefined {
    const worker = candidate?.worker;
    if (!worker || candidate?.buildId === pageBuildId) return undefined;
    if (worker === registration?.waiting && worker.state === 'installed') return worker;
    if (worker === registration?.active && (worker.state === 'activating' || worker.state === 'activated')) return worker;
    return undefined;
  }

  // This is the ONLY path with reload capability; offline completion never calls it.
  async function applyTransaction(): Promise<void> {
    if (disposed() || !registration || !candidate || !updateAvailable) throw new Error('The update is no longer available.');
    try {
      const prepared = preparedWorker();
      if (prepared) {
        await activateUpdate({ worker: prepared, signal: lifetime.signal });
      } else {
        const controller = sw.controller;
        if (!controller || controller !== registration.active) throw new Error('This page is not controlled by the application service worker. Reload and retry.');
        await requestNetworkUpdate({ worker: controller, signal: lifetime.signal });
        // An acknowledgement from A says nothing about a replacement B's mode.
        if (sw.controller !== controller || registration.active !== controller) throw new Error('The controlling service worker changed during the update. Retry.');
      }
      if (disposed()) throw new Error('The update runtime was stopped.');
      platform.reload();
    } catch (error) {
      if (!disposed()) onError({ message: 'Failed to apply the application update.', error });
      throw error;
    } finally {
      if (!disposed()) synchronize();
    }
  }

  function apply(): Promise<void> {
    // A stale handler or multiple callers still represents one user transaction.
    applying ??= applyTransaction().finally(() => {
      applying = undefined;
    });
    return applying;
  }

  function identify({ item }: { item: Observation }): void {
    const worker = item.worker;
    if (item.buildId || item.querying || item.queriedState === worker.state || worker.state === 'redundant') return;
    item.querying = true;
    item.queriedState = worker.state;
    void requestBuildId({ worker, signal: item.lifetime.signal }).then(buildId => {
      if (disposed() || observed.get(worker) !== item) return;
      item.buildId = buildId;
    }).catch(() => {
      // Older workers need not understand this protocol. No invented identity,
      // automatic activation, or immediate retry loop on a missing response.
    }).finally(() => {
      item.querying = false;
      if (!disposed() && observed.get(worker) === item) synchronize();
    });
  }

  function completeOffline({ item }: { item: Observation }): void {
    const active = registration?.active;
    if (!active || sw.controller !== active || item.worker !== registration?.waiting
      || item.worker.state !== 'installed' || item.buildId !== pageBuildId
      || item.completionController === active) return;
    item.completionController = active;
    // The ACTIVE worker owns every download session, including other tabs. It
    // drains them before addressing this exact build, rather than blindly skipping.
    void requestOfflineCompletion({ worker: active, buildId: pageBuildId, signal: item.lifetime.signal }).catch((error: unknown) => {
      if (!disposed() && observed.get(item.worker) === item && item.worker.state === 'installed') {
        onWarning({ message: error instanceof Error ? error.message : 'Automatic offline completion was unavailable.' });
      }
    });
  }

  function synchronize(): void {
    if (disposed() || !registration) return;
    const current = registration;
    const workers = [current.installing, current.waiting, current.active].filter(worker => worker !== null);
    for (const [worker, item] of observed) {
      if (workers.includes(worker)) continue;
      worker.removeEventListener('statechange', item.listener);
      observed.delete(worker);
      item.lifetime.abort();
    }
    const observedAt = ++observationSequence;
    for (const worker of workers) {
      if (observed.has(worker)) continue;
      let previous = worker.state;
      const item: Observation = {
        worker,
        listener: () => {
          const stopped = (previous === 'parsed' || previous === 'installing') && worker.state === 'redundant';
          previous = worker.state;
          synchronize();
          if (stopped && !disposed() && ![current.installing, current.waiting, current.active].some(other => other && other !== worker && other.state !== 'redundant' && (observed.get(other)?.observedAt ?? 0) > item.observedAt)) {
            onWarning({ message: 'Offline preparation stopped. The service worker console contains any resource-level error supplied by the browser.' });
          }
        },
        lifetime: new AbortController(),
        buildId: undefined,
        trusted: lineageKnown && worker !== lastActive,
        observedAt,
        queriedState: undefined,
        querying: false,
        completionController: undefined,
      };
      observed.set(worker, item);
      worker.addEventListener('statechange', item.listener);
    }
    lastActive = current.active;
    for (const item of observed.values()) identify({ item });
    const newest = current.installing ?? current.waiting ?? current.active;
    const latest = newest ? observed.get(newest) : undefined;
    const ownActive = current.active && observed.get(current.active)?.buildId === pageBuildId;
    if (ownActive || latest?.buildId === pageBuildId) lineageKnown = true;
    if (latest && ownActive) latest.trusted = true;

    if (latest?.buildId === pageBuildId) {
      // Falling back to an OLDER slot after C fails is not a new observation of B.
      if (!candidate || latest.observedAt > candidate.observedAt || candidate.worker.state !== 'redundant') candidate = undefined;
    } else if (latest?.buildId && latest.trusted && latest.worker.state !== 'redundant') {
      candidate = latest;
    } else if (candidate && candidate.worker.state !== 'redundant' && candidate !== latest) {
      candidate = undefined;
    }
    // A failed, known DIFFERENT build remains an explicit online choice. A live
    // unknown replacement hides that choice until its identity has been checked.
    const unknownReplacement = latest && latest.worker !== current.active && !latest.buildId;
    updateAvailable = !!candidate && !unknownReplacement;
    if (unknownReplacement) {
      onState({ next: { kind: 'idle' } });
    } else if (preparedWorker()) {
      onState({ next: { kind: 'ready', handler: apply } });
    } else if (candidate) {
      onState({ next: { kind: 'preparing', handler: sw.controller === current.active && current.active?.state === 'activated' ? apply : undefined } });
    } else {
      onState({ next: { kind: 'idle' } });
    }
    // Independent of C's update: waiting B can be this page's offline preparation.
    const waiting = current.waiting ? observed.get(current.waiting) : undefined;
    if ([current.installing, current.waiting].some(worker => worker && observed.get(worker)?.buildId === pageBuildId)) offlinePending = true;
    if (waiting) completeOffline({ item: waiting });
    if (offlinePending && ownActive && current.active?.state === 'activated' && !offlineAnnounced) {
      offlineAnnounced = true;
      onOfflineReady();
    }
  }

  function attach({ next }: { next: ServiceWorkerRegistration }): void {
    if (disposed() || next.scope !== baseUrl.href || registration === next) return;
    registration?.removeEventListener('updatefound', synchronize);
    registration = next;
    offlinePending ||= !next.active;
    const activeBeforeCheck = next.active;
    lastActive = next.active;
    next.addEventListener('updatefound', synchronize);
    synchronize();
    // register() alone can return an unchanged registration. A successful update
    // check authenticates the newest slot, NOT every old worker left in the scope.
    void next.update().then(() => {
      if (disposed() || registration !== next) return;
      synchronize();
      const newest = next.installing ?? next.waiting ?? next.active;
      const item = newest ? observed.get(newest) : undefined;
      if (item && (newest !== activeBeforeCheck || item.buildId === pageBuildId || item.trusted)) {
        item.trusted = true; lineageKnown = true;
      }
      synchronize();
    }).catch(() => {
      // Offline checks do not invalidate known identities or block the page.
    });
  }

  sw.addEventListener('controllerchange', synchronize);
  void sw.getRegistration(baseUrl.href).then(existing => {
    if (disposed()) return;
    if (existing?.scope === baseUrl.href) attach({ next: existing });
    return sw.register(new URL('sw.js', baseUrl).href, { scope: baseUrl.href, updateViaCache: 'none' });
  }).then(next => {
    if (next) attach({ next });
  }).catch((error: unknown) => {
    if (!disposed()) onError({ message: 'Failed to register the service worker.', error });
  });

  return {
    dispose() {
      lifetime.abort();
      sw.removeEventListener('controllerchange', synchronize);
      registration?.removeEventListener('updatefound', synchronize);
      for (const [worker, item] of observed) {
        worker.removeEventListener('statechange', item.listener);
        item.lifetime.abort();
      }
      observed.clear();
    },
  };
}

export const TEST_ONLY = {
};
