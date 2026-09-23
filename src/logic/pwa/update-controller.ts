import type { PWAUpdateState } from '@/composables/usePWAUpdate';
import { NETWORK_UPDATE_PARAMETER, PWA_PROTOCOL, networkUpdateToken, networkUpdateUrl } from '@/logic/pwa/protocol';
import { requestPWAWorker } from '@/logic/pwa/worker-request';
import { pwaInstallFailureSchema } from '@/logic/pwa/install-diagnostics';

export interface PWAUpdatePlatform {
  serviceWorkers: ServiceWorkerContainer;
  getHref: () => string;
  navigate: ({ href }: { href: string }) => void;
  replaceHistory: ({ href }: { href: string }) => void;
  fetch: typeof fetch;
  createToken: () => string;
}

/** Native browser boundaries only: no substitute App/router/settings dependency graph. */
export function createPWAUpdateController({ platform, baseUrl, buildId, onState, onOfflineReady, onError, onDiagnostic }: {
  platform: PWAUpdatePlatform;
  baseUrl: URL;
  buildId: string;
  onState: ({ next }: { next: PWAUpdateState }) => void;
  onOfflineReady: () => void;
  onError: ({ message, error }: { message: string; error: unknown }) => void;
  onDiagnostic: ({ level, message, details }: {
    level: 'warn' | 'error'; message: string; details: Record<string, unknown>;
  }) => void;
}): { dispose: () => void } {
  const sw = platform.serviceWorkers;
  let disposed = false;
  let registration: ServiceWorkerRegistration | undefined;
  let capabilityWorker: ServiceWorker | null = null;
  let supportsNetworkUpdate = false;
  let acceptedWorker: ServiceWorker | undefined;
  let promotionWorker: ServiceWorker | undefined;
  let failedUpdate: ServiceWorker | undefined;
  let offlineAnnounced = false;
  let operation = false;
  let generation = 0;
  const workers = new Map<ServiceWorker, () => void>();
  const observedInstallers = new WeakSet<ServiceWorker>();
  const reportedFailures = new WeakSet<ServiceWorker>();
  const info = new Map<ServiceWorker, Promise<{ buildId: string }>>();
  let pendingActivation: { worker: ServiceWorker; finish: ({ error }?: { error?: Error }) => void } | undefined;

  const online = () => networkUpdateToken({ url: new URL(platform.getHref()) }) !== undefined;
  const report = ({ message, error }: { message: string; error: unknown }) => {
    if (!disposed) onError({ message, error });
  };
  const workerInfo = ({ worker }: { worker: ServiceWorker }) => {
    let pending = info.get(worker);
    if (!pending) {
      pending = requestPWAWorker({ worker, request: { protocol: PWA_PROTOCOL, type: 'info' } });
      info.set(worker, pending);
      // A sleeping worker may time out once. Do not make that transient failure
      // a permanent negative capability cache for the remainder of the page.
      void pending.catch(() => {
        info.delete(worker);
      });
    }
    return pending;
  };

  function announceOffline(): void {
    if (disposed || offlineAnnounced) return;
    offlineAnnounced = true;
    onOfflineReady();
  }

  async function finishOnlinePage({ controller }: { controller: ServiceWorker }): Promise<void> {
    if (!online()) return;
    await requestPWAWorker({ worker: controller, request: { protocol: PWA_PROTOCOL, type: 'bind-page', buildId } });
    const identity = await workerInfo({ worker: controller });
    if (disposed || sw.controller !== controller || identity.buildId !== buildId) return;
    // A controller is active only after FULL precaching completed. Only an exact
    // page/worker build match may end online mode; a later unrelated release may
    // not silently switch this page back onto mismatched unversioned resources.
    await requestPWAWorker({ worker: controller, request: { protocol: PWA_PROTOCOL, type: 'complete-page', buildId } });
    if (disposed || sw.controller !== controller) return;
    const clean = new URL(platform.getHref());
    clean.searchParams.delete(NETWORK_UPDATE_PARAMETER);
    platform.replaceHistory({ href: clean.href });
    announceOffline();
  }

  function observeController(): void {
    if (disposed) return;
    const controller = sw.controller;
    if (pendingActivation?.worker === controller) pendingActivation?.finish();
    if (controller && acceptedWorker === controller) {
      acceptedWorker = undefined;
      const destination = new URL(platform.getHref());
      destination.searchParams.delete(NETWORK_UPDATE_PARAMETER);
      platform.navigate({ href: destination.href });
      return;
    }
    if (capabilityWorker !== controller) {
      capabilityWorker = controller;
      failedUpdate = undefined;
      supportsNetworkUpdate = false;
      if (controller) {
        void workerInfo({ worker: controller }).then(async () => {
          if (disposed || sw.controller !== controller) return;
          supportsNetworkUpdate = true;
          if (online()) await finishOnlinePage({ controller });
          synchronize();
        }).catch((error: unknown) => {
          // Legacy workers do not implement the protocol. Keep their installed-
          // waiting path usable, but never claim an unsupported early reload works.
          if (online()) report({ message: 'Failed to restore offline support for this page.', error });
          synchronize();
        });
      }
    }
    synchronize();
  }

  async function activateReady({ worker }: { worker: ServiceWorker }): Promise<void> {
    if (registration?.waiting !== worker || worker.state !== 'installed') throw new Error('The waiting update changed. Try again.');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish({ error: new Error('The service worker did not activate. Try again.') }), 15000);
      const finish = ({ error }: { error?: Error } = {}) => {
        clearTimeout(timer);
        pendingActivation = undefined;
        if (error) {
          acceptedWorker = undefined;
          reject(error);
        } else resolve();
      };
      pendingActivation = { worker, finish };
      acceptedWorker = worker;
      try {
        worker.postMessage({ type: 'SKIP_WAITING' });
      } catch (error) {
        finish({ error: error instanceof Error ? error : new Error(String(error)) });
      }
    });
  }

  async function reloadFromNetwork(): Promise<void> {
    const controller = sw.controller;
    if (!controller) throw new Error('The update controller is no longer available. Try again.');
    await workerInfo({ worker: controller });
    const destination = networkUpdateUrl({ href: platform.getHref(), token: platform.createToken() });
    // Probe only the small HTML document, NOT every precache resource. Our active
    // worker recognizes this marker and never falls back to old cached HTML.
    // Keep the old, usable page on connection errors, HTTP errors or redirects.
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await platform.fetch(destination.href, { cache: 'no-store', redirect: 'error', signal: abort.signal });
      if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
        throw new Error(`The update document was not available (${response.status}).`);
      }
      await response.text();
    } finally {
      clearTimeout(timeout);
    }
    if (disposed) throw new Error('The update runtime was stopped.');
    // Recheck capabilities after the probe in case another tab activated a worker.
    if (!sw.controller) throw new Error('The service worker changed. Try again.');
    await workerInfo({ worker: sw.controller });
    platform.navigate({ href: destination.href });
  }

  async function apply({ worker, ready }: { worker: ServiceWorker; ready: boolean }): Promise<void> {
    if (operation) return;
    operation = true;
    try {
      const current = updateCandidate();
      if (ready) await activateReady({ worker });
      else if (current?.ready) await activateReady({ worker: current.worker });
      else await reloadFromNetwork();
    } catch (error) {
      operation = false;
      report({ message: 'Failed to apply the application update.', error });
      // Lifecycle events can arrive while operation blocks publication. Publish
      // their CURRENT candidate now; otherwise the store could restore an obsolete
      // handler indefinitely after a failed probe or a competing-tab activation.
      synchronize();
      throw error;
    }
  }

  function updateCandidate(): { worker: ServiceWorker; ready: boolean } | undefined {
    // Registration slots and statechange are delivered separately. A retired
    // waiting slot must not mask a viable installer while those tasks settle.
    for (const worker of [registration?.waiting, registration?.installing]) {
      if (!worker) continue;
      const state = worker.state;
      switch (state) {
      case 'parsed':
      case 'installing': return { worker, ready: false };
      case 'installed': return { worker, ready: true };
      case 'activating':
      case 'activated':
      case 'redundant': continue;
      default: {
        const exhaustive: never = state;
        throw new Error(`Unexpected service worker state: ${exhaustive}`);
      }
      }
    }
    return undefined;
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native ServiceWorkerContainer listener uses the browser's positional event contract.
  function observeInstallFailure(event: MessageEvent<unknown>): void {
    if (disposed || event.origin !== baseUrl.origin) return;
    const worker = event.source;
    // URL equality alone cannot identify versions: all releases use sw.js.
    // Remember observed installers weakly so a late message is still accepted
    // after the redundant worker has left registration.installing.
    if (!worker || !('scriptURL' in worker) || !observedInstallers.has(worker)) return;
    const result = pwaInstallFailureSchema.safeParse(event.data);
    if (!result.success || result.data.scope !== baseUrl.href || reportedFailures.has(worker)) return;
    reportedFailures.add(worker);
    onDiagnostic({
      level: 'error', message: 'Failed to precache an application resource.',
      details: { ...result.data, workerScriptUrl: worker.scriptURL, pageBuildId: buildId },
    });
  }

  function synchronize(): void {
    if (disposed || !registration) return;
    const revision = ++generation;
    const current = registration;
    const candidates = new Set([current.installing, current.waiting, current.active].filter((worker) => worker !== null));
    for (const [worker, listener] of workers) {
      if (candidates.has(worker)) continue;
      worker.removeEventListener('statechange', listener);
      workers.delete(worker);
    }
    for (const worker of candidates) {
      if (workers.has(worker)) continue;
      let previous = worker.state;
      if (previous === 'parsed' || previous === 'installing') observedInstallers.add(worker);
      const activeWhenObserved = current.active;
      const waitingWhenObserved = current.waiting;
      const listener = () => {
        const stopped = (previous === 'parsed' || previous === 'installing') && worker.state === 'redundant';
        previous = worker.state;
        // Inspect both slots: an older waiting version may outrank a newer
        // installer for the button, but must not hide that installer's presence.
        const superseded = [current.installing, current.waiting].some(replacement =>
          replacement && replacement !== worker && replacement !== waitingWhenObserved && replacement.state !== 'redundant')
          || (current.active && current.active !== worker && current.active !== activeWhenObserved);
        if (stopped && !superseded) failedUpdate = worker;
        if (worker.state === 'redundant' && pendingActivation?.worker === worker) {
          pendingActivation.finish({ error: new Error('The selected update was replaced or could not activate. Try again.') });
        }
        synchronize();
        if (stopped && !superseded && !reportedFailures.has(worker) && !disposed) {
          // Redundant is a terminal state, NOT an exception or its cause. A
          // failed install, registration removal or browser termination can all
          // end here. Prefer an actual Workbox failure message when available;
          // otherwise record an honest warning, not a synthetic Error stack.
          onDiagnostic({
            level: 'warn', message: 'Offline preparation ended before readiness was confirmed; the browser did not provide a cause.',
            details: { kind: 'worker-became-redundant', workerScriptUrl: worker.scriptURL, scope: baseUrl.href, pageBuildId: buildId },
          });
        }
      };
      worker.addEventListener('statechange', listener);
      workers.set(worker, listener);
    }
    // Continue tracking worker lifetimes while a click/probe blocks UI changes.
    // Otherwise an installer appearing mid-click can fail without being observed.
    if (operation) return;
    const pending = updateCandidate();
    const candidate = pending?.worker;
    const ready = pending?.ready ?? false;
    if (candidate && current.active && current.active !== candidate) {
      failedUpdate = undefined;
      if (online()) {
        void workerInfo({ worker: candidate }).then(({ buildId: candidateId }) => {
          if (disposed || revision !== generation || !online()) return;
          if (candidateId === buildId) {
            onState({ next: { kind: 'idle' } });
            if (ready && current.waiting === candidate && promotionWorker !== candidate) {
              promotionWorker = candidate;
              // The user already selected this exact running version. Restoring
              // its FULL offline cache requires no second reload and no new click.
              candidate.postMessage({ type: 'SKIP_WAITING' });
            }
          } else publishCandidate({ candidate, ready });
        }).catch((error: unknown) => {
          if (disposed || revision !== generation) return;
          report({ message: 'Failed to identify the prepared update.', error });
          // An unknown/legacy identity cannot be auto-promoted, but an explicit
          // action remains valid through the normal waiting or network path.
          publishCandidate({ candidate, ready });
        });
        return;
      }
      publishCandidate({ candidate, ready });
      return;
    }
    if (failedUpdate && current.active && supportsNetworkUpdate && !online()) {
      // An optional resource can break FULL offline installation while the new
      // app is already usable online. Preserve the explicit network choice.
      publishCandidate({ candidate: failedUpdate, ready: false });
      return;
    }
    onState({ next: { kind: 'idle' } });
    if (current.active?.state === 'activated' && !online() && !sw.controller) announceOffline();
  }

  function publishCandidate({ candidate, ready }: { candidate: ServiceWorker; ready: boolean }): void {
    if (ready) onState({ next: { kind: 'ready', handler: () => apply({ worker: candidate, ready: true }) } });
    else if (supportsNetworkUpdate) onState({ next: { kind: 'preparing', handler: () => apply({ worker: candidate, ready: false }) } });
    else onState({ next: { kind: 'preparing' } });
  }

  function attach({ next }: { next: ServiceWorkerRegistration }): void {
    if (disposed || next.scope !== baseUrl.href) return;
    registration?.removeEventListener('updatefound', synchronize);
    registration = next;
    next.addEventListener('updatefound', synchronize);
    observeController();
  }

  sw.addEventListener('controllerchange', observeController);
  sw.addEventListener('message', observeInstallFailure);
  // Subscribe to the EXISTING registration before register()/update(). A browser-
  // initiated install may already be downloading; queuing register() first can
  // delay our callback until that whole install finishes, defeating early notice.
  void sw.getRegistration(baseUrl.href).then((existing) => {
    if (disposed) return;
    if (existing?.scope === baseUrl.href) attach({ next: existing });
    return sw.register(new URL('sw.js', baseUrl).href, { scope: baseUrl.href, updateViaCache: 'none' });
  }).then((next) => {
    if (next && !disposed) attach({ next });
  }).catch((error: unknown) => report({ message: 'Failed to register the service worker.', error }));

  return {
    dispose() {
      disposed = true;
      generation++;
      pendingActivation?.finish({ error: new Error('The update runtime was stopped.') });
      sw.removeEventListener('controllerchange', observeController);
      sw.removeEventListener('message', observeInstallFailure);
      registration?.removeEventListener('updatefound', synchronize);
      for (const [worker, listener] of workers) worker.removeEventListener('statechange', listener);
      workers.clear();
    },
  };
}

export const TEST_ONLY = {
};
