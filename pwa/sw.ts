/// <reference lib="webworker" />
import { PrecacheController, PrecacheRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { NavigationRoute, Router } from 'workbox-routing';
import { USE_NETWORK_MESSAGE } from '../src/logic/pwa/protocol';

declare const __PWA_BUILD_ID__: string;
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// One opt-in record per application scope, NOT per tab/resource. Its value is
// THIS worker's build ID. A replacement worker starts cache-first, even after a
// browser restart. The page never negotiates versions or tries to restore mode.
const scope = new URL(self.registration.scope);
const modeCache = `naidan-pwa-network-mode:${scope.href}`;
const modeKey = new URL('__network_mode__', scope).href;
let networkOnly = caches.open(modeCache).then(async cache =>
  (await (await cache.match(modeKey))?.text()) === __PWA_BUILD_ID__).catch(error => {
  // An unreadable opt-in must not serve stale HTML as a successful update, but
  // must not block the online application either. There is no cache fallback.
  console.error('[PWA] Failed to read network update mode; using the network.', error);
  return true;
});

const precache = new PrecacheController({
  plugins: [{ async handlerDidError({ request, error, event }) {
    if (event.type === 'install') console.error('[PWA] Failed to precache an application resource.', request.url, error);
    // Report the ORIGINAL error; never turn an incomplete install into success.
    return undefined;
  } }],
});
// Full, automatically generated manifest: no minimum-files list or partial install.
precache.precache(self.__WB_MANIFEST);
cleanupOutdatedCaches();
const router = new Router();
router.registerRoute(new PrecacheRoute(precache));
router.registerRoute(new NavigationRoute(precache.createHandlerBoundToURL('index.html')));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Leave other origins, scopes and methods to the browser. In particular,
  // this worker does not wrap model/API requests or their response streams.
  if (event.request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const response = (async () => {
    // The deliberate tradeoff is SCOPE-wide: all tabs/workers still controlled
    // by this generation use the network. This avoids guessing worker ancestry,
    // mixing old fixed-name runtime files, or changing any model/user cache.
    if (await networkOnly) return fetch(event.request, { cache: 'no-store' });
    return router.handleRequest({ request: event.request, event }) ?? fetch(event.request);
  })();
  event.respondWith(response);
  event.waitUntil(response.then(() => undefined, () => undefined));
});

self.addEventListener('message', event => {
  const source = event.source;
  if (event.origin !== scope.origin || !source || !('url' in source) || !('type' in source) || source.type !== 'window') return;
  if (!source.url.startsWith(scope.href)) return;
  const data: unknown = event.data;
  if (!data || typeof data !== 'object' || !('type' in data)) return;
  if (data.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting()); return;
  }
  if (data.type !== USE_NETWORK_MESSAGE) return;
  // Do not switch mode without a caller that can receive the acknowledgement.
  const reply = event.ports[0];
  if (!reply) return;
  event.waitUntil((async () => {
    try {
      // Persist BEFORE acknowledging, so a reload/worker restart cannot return
      // to old caches. Installation uses native fetch and is unaffected.
      await (await caches.open(modeCache)).put(modeKey, new Response(__PWA_BUILD_ID__));
      networkOnly = Promise.resolve(true);
      // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- One scoped command with a literal acknowledgement, not a long-lived worker API.
      reply.postMessage(USE_NETWORK_MESSAGE);
    } catch (error) {
      console.error('[PWA] Failed to enable network updating.', error);
      // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- Failure acknowledgement lets the page stay usable and offer a retry.
      reply.postMessage(false);
    } finally {
      reply.close();
    }
  })());
});
