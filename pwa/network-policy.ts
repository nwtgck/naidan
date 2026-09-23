/// <reference lib="webworker" />
import { networkUpdateToken } from '../src/logic/pwa/protocol';

type ClientRecord = { rootId: string; buildId?: string; complete?: boolean };

/**
 * Only this small, scope-specific coordination cache is written here. Application
 * precaches, model stores, IndexedDB, OPFS and localStorage are never cleared.
 * Persist child->page links: a service worker's in-memory Map does not survive
 * suspension. No handwritten list of required or deferred application files.
 */
export function createNetworkUpdatePolicy({ scope, buildId, clients, storage }: {
  scope: string;
  buildId: string;
  clients: Clients;
  storage: CacheStorage;
}) {
  const scopeUrl = new URL(scope);
  const cacheName = `naidan-pwa-update-coordination-v1:${scope}`;
  const key = (id: string) => new URL(`.pwa-client/${encodeURIComponent(id)}`, scope).href;
  let cache: Promise<Cache> | undefined;
  const records = new Map<string, ClientRecord>();
  const ordinaryWindows = new Set<string>();
  const open = () => cache ??= storage.open(cacheName);
  let reportedStorageFailure = false;
  function storageFailure(error: unknown): void {
    if (!reportedStorageFailure) console.warn('[PWA] Update coordination storage is unavailable; using live client state.', error);
    reportedStorageFailure = true;
  }

  async function read(id: string): Promise<ClientRecord | undefined> {
    if (!id) return undefined;
    if (records.has(id)) return records.get(id);
    const response = await open().then(cache => cache.match(key(id))).catch((error: unknown) => {
      storageFailure(error);
      return undefined;
    });
    // Do not negatively cache missing rows: another worker version can create
    // a page binding after this version has already seen its first request.
    if (!response) return undefined;
    const value: unknown = await response.json().catch((error: unknown) => {
      storageFailure(error); return undefined;
    });
    if (typeof value !== 'object' || value === null || !('rootId' in value) || typeof value.rootId !== 'string') return undefined;
    const record: ClientRecord = {
      rootId: value.rootId,
      ...('buildId' in value && typeof value.buildId === 'string' ? { buildId: value.buildId } : {}),
      ...('complete' in value && value.complete === true ? { complete: true } : {}),
    };
    // Read mutable root bindings afresh. A different service-worker version may
    // have completed them since this worker last handled a request.
    if (record.rootId !== id) records.set(id, record);
    return record;
  }

  async function write({ id, record }: { id: string; record: ClientRecord }): Promise<void> {
    if (!id) return;
    ordinaryWindows.delete(id);
    records.set(id, record);
    try {
      await (await open()).put(key(id), new Response(JSON.stringify(record)));
      if (record.rootId === id) records.delete(id);
    } catch (error) {
      storageFailure(error);
    }
  }

  function isAppUrl(url: URL): boolean {
    return url.origin === scopeUrl.origin && url.pathname.startsWith(scopeUrl.pathname);
  }

  function isEntry(url: URL): boolean {
    return url.pathname === scopeUrl.pathname || url.pathname === `${scopeUrl.pathname}index.html`;
  }

  async function rootForClient(id: string): Promise<string | undefined> {
    // A deliberate update navigates to a NEW document/client. Remember known
    // ordinary windows so their initial chunks do not each await bookkeeping IO.
    // Never cache a missing reserved/worker client: another SW can bind it later.
    if (ordinaryWindows.has(id)) return undefined;
    const record = await read(id);
    if (record) return record.rootId;
    const client = id ? await clients.get(id) : undefined;
    if (!client || client.type !== 'window') return undefined;
    const url = new URL(client.url);
    if (!isAppUrl(url) || !networkUpdateToken({ url })) {
      ordinaryWindows.add(id);
      return undefined;
    }
    await write({ id, record: { rootId: id } });
    return id;
  }

  async function referencedRoot({ referrer }: { referrer: string }): Promise<string | undefined> {
    if (!referrer) return undefined;
    const ref = new URL(referrer);
    if (!isAppUrl(ref) || !networkUpdateToken({ url: ref })) return undefined;
    ref.hash = '';
    for (const client of await clients.matchAll({ type: 'window' })) {
      const url = new URL(client.url);
      url.hash = '';
      if (url.href === ref.href) return rootForClient(client.id);
    }
    return undefined;
  }

  async function needsNetwork({ event }: { event: FetchEvent }): Promise<boolean> {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || !isAppUrl(url)) return false;

    // An explicit navigation/probe always goes to the network, even if the old
    // worker happens to have a matching entry. The probe cannot silently succeed
    // with cached HTML when offline. All original response/security headers survive.
    if (isEntry(url) && networkUpdateToken({ url })) {
      if (event.request.mode === 'navigate' && event.resultingClientId) {
        await write({ id: event.resultingClientId, record: { rootId: event.resultingClientId } });
      }
      return true;
    }

    // A normal top-level navigation is not an opted-in descendant. In
    // particular, returning to the fully prepared canonical URL must work offline.
    if (event.request.mode === 'navigate' && event.request.destination === 'document') return false;

    const rootId = await rootForClient(event.clientId)
      ?? await referencedRoot({ referrer: event.request.referrer });
    if (rootId) {
      if (event.resultingClientId) await write({ id: event.resultingClientId, record: { rootId } });
      const root = await read(rootId);
      return root?.complete !== true && root?.buildId !== buildId;
    }

    // Blob workers have no script fetch from which to retain a parent link, and
    // the platform exposes no owner relationship. While a network-update window
    // is live, never feed an unattributed worker unversioned OLD runtime bytes.
    // This conservative fallback can also make another tab's unattributed worker
    // network-dependent during that interval; ordinary window clients stay cached.
    const client = event.clientId ? await clients.get(event.clientId) : undefined;
    if (client && client.type !== 'window') {
      for (const windowClient of await clients.matchAll({ type: 'window' })) {
        const root = await rootForClient(windowClient.id);
        if (!root) continue;
        const record = await read(root);
        if (record?.complete !== true && record?.buildId !== buildId) return true;
      }
    }
    return false;
  }

  async function bindPage({ clientId, pageBuildId, complete }: {
    clientId: string;
    pageBuildId: string;
    complete: boolean;
  }): Promise<boolean> {
    const client = await clients.get(clientId);
    if (!client || client.type !== 'window' || !isAppUrl(new URL(client.url))) return false;
    const rootId = await rootForClient(clientId);
    if (rootId !== clientId || (complete && pageBuildId !== buildId)) return false;
    await write({ id: clientId, record: { rootId: clientId, buildId: pageBuildId, complete } });
    return true;
  }

  async function collectClosedClients(): Promise<void> {
    const cache = await open().catch((error: unknown) => {
      storageFailure(error); return undefined;
    });
    if (!cache) return;
    const live = new Set((await clients.matchAll({ type: 'all', includeUncontrolled: true })).map(client => client.id));
    for (const id of ordinaryWindows) if (!live.has(id)) ordinaryWindows.delete(id);
    // Delete ONLY obsolete bookkeeping rows in OUR cache, never application assets.
    // Also retain root records referenced by a still-live child client.
    for (const id of Array.from(live)) {
      const record = await read(id);
      if (record) live.add(record.rootId);
    }
    for (const request of await cache.keys()) {
      const id = decodeURIComponent(new URL(request.url).pathname.split('/').at(-1) ?? '');
      if (!live.has(id)) await cache.delete(request);
    }
  }

  return { needsNetwork, bindPage, collectClosedClients };
}

export const TEST_ONLY = {};
