/// <reference lib="webworker" />
import { PrecacheController, PrecacheRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { NavigationRoute, Router } from 'workbox-routing';
import { PWA_PROTOCOL } from '../src/logic/pwa/protocol';
import { createNetworkUpdatePolicy } from './network-policy';
import { createInstallFailureReporter } from './install-diagnostics';

declare const __PWA_BUILD_ID__: string;
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// Keep the full, automatically generated precache manifest. Explicit online
// updating is a routing choice; it does not split, skip or truncate installation.
const reportInstallFailure = createInstallFailureReporter({
  scope: self.registration.scope, buildId: __PWA_BUILD_ID__, clients: self.clients,
});
const precache = new PrecacheController({
  plugins: [{
    async handlerDidError({ request, error, event }) {
      if (event.type === 'install') {
        await reportInstallFailure({ resourceUrl: request.url, error });
      }
      // Do not return a fallback Response: Workbox must still reject the FULL
      // installation. Reporting a failure never makes an incomplete cache ready.
      return undefined;
    },
  }],
});
precache.precache(self.__WB_MANIFEST);
cleanupOutdatedCaches();
const router = new Router();
router.registerRoute(new PrecacheRoute(precache));
router.registerRoute(new NavigationRoute(precache.createHandlerBoundToURL('index.html')));
const policy = createNetworkUpdatePolicy({
  scope: self.registration.scope,
  buildId: __PWA_BUILD_ID__,
  clients: self.clients,
  storage: self.caches,
});

// One dispatcher owns respondWith. An async match callback registered after
// Workbox's precache route would be too late to prevent the old-cache response.
self.addEventListener('fetch', (event) => {
  const response = (async () => {
    if (await policy.needsNetwork({ event })) {
      return fetch(event.request, { cache: 'no-store' });
    }
    return router.handleRequest({ request: event.request, event }) ?? fetch(event.request);
  })();
  event.respondWith(response);
  // Keep the event extendable while policy IO completes; Workbox may add its own
  // waitUntil work when the asynchronous dispatcher reaches its handler.
  event.waitUntil(response.then(() => undefined, () => undefined));
});

self.addEventListener('message', (event) => {
  const data: unknown = event.data;
  if (typeof data !== 'object' || data === null || !('type' in data)) return;
  if (data.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (!('protocol' in data) || data.protocol !== PWA_PROTOCOL) return;
  const source = event.source;
  if (!source || !('id' in source)) return;
  event.waitUntil((async () => {
    let ok = false;
    switch (data.type) {
    case 'info':
      ok = true;
      break;
    case 'bind-page':
    case 'complete-page':
      if ('buildId' in data && typeof data.buildId === 'string') {
        ok = await policy.bindPage({ clientId: source.id, pageBuildId: data.buildId, complete: data.type === 'complete-page' });
      }
      break;
    default: return;
    }
    // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- Versioned one-shot SW reply; input and source are validated above, no Comlink endpoint.
    event.ports[0]?.postMessage({ protocol: PWA_PROTOCOL, buildId: __PWA_BUILD_ID__, ok });
    if (data.type === 'complete-page' && ok) await policy.collectClosedClients();
  })().catch((error: unknown) => {
    console.error('[PWA] Network update coordination failed.', error);
    // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- Versioned one-shot SW reply; input and source are validated above, no Comlink endpoint.
    event.ports[0]?.postMessage({ protocol: PWA_PROTOCOL, buildId: __PWA_BUILD_ID__, ok: false });
  }));
});
