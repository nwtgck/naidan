import {
  READ_ASSET_SELECTION, assetSelectionSchema,
  type AssetSelection, type DeferredAssetMetadata, type PrepareOfflineAssetsReply, type PrepareOfflineAssetsRequest,
} from '../src/logic/pwa/asset-cache-protocol';
import { isDocsUrl } from './docs-routing';

type OfflineAsset = DeferredAssetMetadata & { url: string; key: string };
const downloadTimeout = 120_000;

function needsAsset({ asset, selections }: { asset: OfflineAsset; selections: AssetSelection[] | undefined }): boolean {
  const group = asset.group;
  switch (group.kind) {
  case 'standalone-package': return false;
  case 'locale': return selections === undefined || selections.some(selection => selection.locales.includes(group.locale));
  case 'transformers': return selections === undefined || selections.some(selection =>
    selection.transformers === undefined || selection.transformers === group.variant);
  case 'llama': return selections === undefined || selections.some(selection =>
    selection.llama === undefined || selection.llama.includes(group.profile));
  default: {
    const exhaustive: never = group;
    throw new Error(String(exhaustive));
  }
  }
}

function queryClient({ client }: { client: Client }): Promise<AssetSelection | undefined> {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => finish({ selection: undefined }), 750);
    function finish({ selection }: { selection: AssetSelection | undefined }) {
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      resolve(selection);
    }
    // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- Each one-shot reply is schema checked and the port is closed on all outcomes.
    channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
      const reply = assetSelectionSchema.safeParse(data);
      finish({ selection: reply.success ? reply.data : undefined });
    };
    channel.port1.onmessageerror = () => finish({ selection: undefined });
    try {
      client.postMessage({ type: READ_ASSET_SELECTION }, [channel.port2]);
    } catch {
      finish({ selection: undefined });
    }
  });
}

export function createOfflineAssets({ entries, clients, scope }: {
  entries: readonly { url: string; deferred?: DeferredAssetMetadata }[];
  clients: Clients;
  scope: URL;
}) {
  // A separate cache makes verification provenance independent of legacy Workbox entries.
  const cacheName = `naidan-pwa-verified-assets-v1:${scope.href}`;
  const assets = new Map<string, OfflineAsset>();
  for (const entry of entries) {
    if (!entry.deferred) {
      continue;
    }
    const url = new URL(entry.url, scope);
    const key = new URL(url);
    key.searchParams.set('__naidan_asset_integrity', entry.deferred.integrity);
    assets.set(url.href, { ...entry.deferred, url: url.href, key: key.href });
  }
  const installable = [...assets.values()].filter(asset => asset.group.kind !== 'standalone-package');
  const expectedKeys = new Set([...assets.values()].map(asset => asset.key));
  let selectionChanged: AbortController | undefined;
  const saves = new Map<OfflineAsset, Promise<void>>();
  const activePreparation = new AbortController();

  async function selectedAssets(): Promise<OfflineAsset[]> {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true }).catch(() => []);
    const pages = allClients.filter(client => {
      const url = new URL(client.url);
      return client.frameType !== 'nested' && url.origin === scope.origin
        && url.pathname.startsWith(scope.pathname) && !isDocsUrl({ url, scope })
        && !['privacy-fetch-broker', 'privacy-fetch-broker.html'].some(file =>
          url.pathname === new URL(file, scope).pathname);
    });
    const replies = await Promise.all(pages.map(client => queryClient({ client })));
    const known = replies.filter(reply => reply !== undefined);
    const selections = known.length > 0 && known.length === replies.length ? known : undefined;
    return installable.filter(asset => needsAsset({ asset, selections }));
  }

  async function fetchVerified({ asset, request, signal }: {
    asset: OfflineAsset;
    request: Request | undefined;
    signal: AbortSignal | undefined;
  }): Promise<Response> {
    const deadline = AbortSignal.timeout(downloadTimeout);
    const response = await fetch(request ?? asset.url, {
      cache: 'reload',
      integrity: asset.integrity,
      redirect: 'error',
      signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
    });
    const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    const encoding = response.headers.get('content-encoding');
    const module = asset.url.endsWith('.js') || asset.url.endsWith('.mjs');
    if (response.status !== 200 || response.redirected || !response.body || mediaType === 'text/html'
      || (module && !(mediaType?.includes('javascript') || mediaType?.includes('ecmascript')))
      || (asset.url.endsWith('.wasm.gz') && encoding !== null && encoding !== 'identity')) {
      throw new Error(`Unexpected response for offline asset: ${asset.url}`);
    }
    return response;
  }

  async function save({ cache, asset, signal }: { cache: Cache; asset: OfflineAsset; signal: AbortSignal | undefined }) {
    if (await cache.match(asset.key)) {
      return;
    }
    const response = await fetchVerified({ asset, request: undefined, signal });
    await cache.put(asset.key, response);
  }

  return {
    selectionChanged() {
      selectionChanged?.abort();
    },
    stopActivePreparation() {
      activePreparation.abort();
    },
    async install() {
      if (installable.length === 0) {
        return;
      }
      const cache = await caches.open(cacheName);
      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          const change = new AbortController();
          selectionChanged = change;
          const desired = await selectedAssets();
          const failures = new Map<OfflineAsset, unknown>();
          for (const asset of desired) {
            if (change.signal.aborted) {
              break;
            }
            try {
              await save({ cache, asset, signal: change.signal });
            } catch (error) {
              failures.set(asset, error);
            }
          }
          if (change.signal.aborted) {
            continue;
          }
          const latest = await selectedAssets();
          if (change.signal.aborted || latest.some(asset => !desired.includes(asset))) {
            continue;
          }
          const cachedKeys = new Set((await cache.keys()).map(request => request.url));
          if (change.signal.aborted) {
            continue;
          }
          const missing = latest.find(asset => !cachedKeys.has(asset.key));
          if (missing) {
            throw failures.get(missing) ?? new Error(`Offline asset was not stored: ${missing.url}`);
          }
          return;
        }
        // Rapid changes must converge to a valid install without waiting for a quiet tab.
        for (const asset of installable) {
          await save({ cache, asset, signal: undefined });
        }
      } finally {
        selectionChanged = undefined;
      }
    },
    async cleanObsolete() {
      if (!(await caches.keys()).includes(cacheName)) {
        return;
      }
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        if (!expectedKeys.has(request.url)) {
          await cache.delete(request);
        }
      }
    },
    handleFetch({ request, event }: { request: Request; event: FetchEvent }): Promise<Response> | undefined {
      const asset = assets.get(request.url);
      if (!asset || request.headers.has('range') || (request.integrity && request.integrity !== asset.integrity)) {
        return undefined;
      }
      const response = (async () => {
        const cache = await caches.open(cacheName).catch(() => undefined);
        const cached = await cache?.match(asset.key).catch(() => undefined);
        if (cached) {
          return cached;
        }
        if (asset.group.kind === 'standalone-package' || request.mode === 'no-cors') {
          return fetch(request);
        }
        const verified = await fetchVerified({ asset, request, signal: undefined });
        if (cache) {
          event.waitUntil(cache.put(asset.key, verified.clone()).catch(error => {
            console.warn('[PWA] Could not save an offline asset.', asset.url, error);
          }));
        }
        return verified;
      })();
      return response;
    },
    async prepareNext({ target }: { target: PrepareOfflineAssetsRequest['target'] }): Promise<PrepareOfflineAssetsReply> {
      const cache = await caches.open(cacheName);
      const requested = (() => {
        switch (target.kind) {
        case 'remaining': return [...assets.values()];
        case 'selection': return installable.filter(asset => needsAsset({ asset, selections: [target.selection] }));
        default: {
          const exhaustive: never = target;
          throw new Error(String(exhaustive));
        }
        }
      })();
      const stored = new Set((await cache.keys()).map(request => request.url));
      const missing = requested.filter(asset => !stored.has(asset.key));
      const asset = missing[0];
      if (!asset) {
        return 'complete';
      }
      let pending = saves.get(asset);
      if (!pending) {
        pending = save({ cache, asset, signal: activePreparation.signal }).finally(() => saves.delete(asset));
        saves.set(asset, pending);
      }
      await pending;
      return { remaining: missing.length - 1 };
    },
  };
}

export const TEST_ONLY = {
};
