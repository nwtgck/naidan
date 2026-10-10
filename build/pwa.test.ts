// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { buildPWAFixture } from './test-support/pwa-fixture';
import { createWorkerHarness, MemoryCacheStorage, TestClients } from './test-support/pwa-worker-platform';
import { ACTIVATE_BUILD_MESSAGE, BUILD_ID_MESSAGE, COMPLETE_OFFLINE_MESSAGE, USE_NETWORK_MESSAGE } from '../src/logic/pwa/protocol';
import { createRegistrationPlatform } from './test-support/pwa-registration-platform';
import { createPWAUpdateController } from '../src/logic/pwa/update-controller';
import type { PWAUpdateState } from '../src/logic/pwa/update-state';
import { UI_LOCALES } from '../src/01-models/ui-locale';

import { serveByteStream, receiveByteStream, BYTE_STREAM_CHUNK_BYTES } from '../src/utils/byte-stream-port';
import { downloadStatusSchema, createDownloadUrl, DOWNLOAD_ROOT } from '../src/utils/download/protocol';

let root: string;
let a: Awaited<ReturnType<typeof buildPWAFixture>>;
let b: Awaited<ReturnType<typeof buildPWAFixture>>;
let c: Awaited<ReturnType<typeof buildPWAFixture>>;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'naidan-pwa-builds-'));
  a = await buildPWAFixture({ root: path.join(root, 'a'), buildId: 'version-a' });
  b = await buildPWAFixture({ root: path.join(root, 'b'), buildId: 'version-b' });
  c = await buildPWAFixture({ root: path.join(root, 'c'), buildId: 'version-c' });
}, 60000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const scope = 'https://example.test/naidan/';

function setup() {
  let deployed = a;
  let offline = false;
  let hold: Promise<void> | undefined;
  let release: (() => void) | undefined;
  let delayed: (() => void) | undefined;
  const requested: Array<{ path: string; cache: RequestCache | undefined }> = [];
  const storage = new MemoryCacheStorage();
  const clients = new TestClients();
  clients.clients.set('page', { id: 'page', type: 'window', url: scope });
  clients.clients.set('other-tab', { id: 'other-tab', type: 'window', url: scope });
  clients.clients.set('other-app', { id: 'other-app', type: 'window', url: 'https://example.test/another/' });
  const network: typeof fetch = async (input, init) => {
    if (offline) throw new TypeError('offline');
    const url = new URL(input instanceof Request ? input.url : String(input));
    const file = url.pathname.slice('/naidan/'.length) || 'index.html';
    requested.push({ path: file, cache: init?.cache ?? (input instanceof Request ? input.cache : undefined) });
    if (file === 'naidan-standalone.zip' && hold) {
      delayed?.(); await hold;
    }
    const bytes = deployed.files.get(file);
    return new Response(bytes ? new Uint8Array(bytes) : 'missing', {
      status: bytes ? 200 : 404,
      headers: { 'content-type': file === 'index.html' ? 'text/html' : 'application/octet-stream', 'cross-origin-embedder-policy': 'require-corp' },
    });
  };
  const make = (version: typeof a) => createWorkerHarness({ script: version.script, scope, cacheStorage: storage, clients, fetch: network });
  const holdInstall = () => {
    hold = new Promise<void>(resolve => {
      release = resolve;
    });
    return new Promise<void>(resolve => {
      delayed = resolve;
    });
  };
  return {
    storage,
    clients,
    network,
    requested,
    make,
    holdInstall,
    release: () => {
      release?.(); hold = undefined;
    },
    deployC: () => {
      deployed = c;
    },
    deployB: () => {
      deployed = b;
    },
    offline: () => {
      offline = true;
    },
    online: () => {
      offline = false;
    },
  };
}

describe('real generated Workbox worker', () => {
  it.each([['cache-first', 1], ['network-only', 1], ['cache-first', 2], ['network-only', 2]] as const)('streams a multi-hop 64 MiB download locally in %s mode with v%i', async (mode, version) => {
    const f = setup(), worker = f.make(a);
    await worker.lifecycle('install'); await worker.lifecycle('activate');
    if (mode === 'network-only') await worker.message({ clientId: 'page', data: { type: USE_NETWORK_MESSAGE } });
    f.requested.length = 0;
    f.offline();
    const chunks = 256;
    let produced = 0, consumed = 0, maximumAhead = 0;
    const firstHop = new MessageChannel(), secondHop = new MessageChannel(), control = new MessageChannel();
    const source = serveByteStream({
      port: firstHop.port1,
      signal: undefined,
      openStream: async () => new ReadableStream<Uint8Array>({
        pull(controller) {
          if (produced === chunks) {
            controller.close(); return;
          }
          controller.enqueue(new Uint8Array(BYTE_STREAM_CHUNK_BYTES).fill(produced % 251));
          produced += 1; maximumAhead = Math.max(maximumAhead, produced - consumed);
        },
      }, { highWaterMark: 0 }),
    });
    const intermediate = receiveByteStream({ port: firstHop.port2 });
    const sender = serveByteStream({ port: secondHop.port1, signal: undefined, openStream: async () => intermediate.stream });
    const statuses: Array<ReturnType<typeof downloadStatusSchema.parse>> = [];
    control.port1.onmessage = event => {
      statuses.push(downloadStatusSchema.parse(event.data));
    };
    const token = crypto.randomUUID();
    const downloadUrl = createDownloadUrl({ base: new URL(scope), token, version }).href;
    const prepared = worker.messageWithPorts({
      clientId: 'page',
      ports: [control.port2, secondHop.port2],
      data: { type: 'naidan-download/prepare', version, token, metadata: { filename: 'large.bin', size: chunks * BYTE_STREAM_CHUNK_BYTES } },
    });
    try {
      await vi.waitFor(() => expect(statuses).toContainEqual({ type: 'ready', version, token }));
      expect(produced).toBe(0);
      // A newly created iframe has its own ID, not the initiating page's ID.
      const { response, completed } = await worker.streamRequest({
        url: downloadUrl,
        clientId: 'new-download-frame',
        resultingClientId: 'next-frame',
        navigation: true,
        referrer: version === 2 ? '' : scope,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('content-disposition')).toContain('attachment;');
      expect(response.headers.get('content-length')).toBe(String(chunks * BYTE_STREAM_CHUNK_BYTES));
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox allow-downloads");
      expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
      expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      await prepared; // Preparation lease ends at claim, NOT at download EOF.
      const reader = response.body!.getReader();
      let total = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        expect(part.value.byteLength).toBe(BYTE_STREAM_CHUNK_BYTES);
        expect(part.value[0]).toBe(consumed % 251);
        expect(part.value.at(-1)).toBe(consumed % 251);
        total += part.value.byteLength; consumed += 1;
        if (consumed === 1) {
          const pausedAt = produced;
          await new Promise(resolve => setTimeout(resolve, 20));
          expect(produced).toBe(pausedAt);
        }
      }
      reader.releaseLock();
      await completed; await sender.completed; await source.completed;
      expect(total).toBe(64 * 1024 * 1024);
      expect(maximumAhead).toBeLessThanOrEqual(3);
      expect(f.requested).toEqual([]);
      expect(await f.storage.keys()).not.toContain(expect.stringContaining(DOWNLOAD_ROOT));
      expect((await worker.request({ url: downloadUrl })).status).toBe(410);
    } finally {
      control.port1.postMessage({ type: 'cancel' });
      sender.abort({ reason: new Error('test cleanup') }); source.abort({ reason: new Error('test cleanup') });
      control.port1.close();
      await prepared;
    }
  });

  it('never sends invalid/expired download paths to the network, including after an update', async () => {
    const f = setup(), old = f.make(a), next = f.make(b);
    await old.message({ clientId: 'page', data: { type: USE_NETWORK_MESSAGE } });
    f.offline();
    for (const worker of [old, next]) for (const suffix of ['', 'v0/old', 'v1/missing', 'v99/future', 'v1/missing?invalid=1', 'v2/', 'v2/#?id=missing', 'v2/?id=private', 'v2/private']) {
      expect((await worker.request({ url: `${scope}${DOWNLOAD_ROOT}${suffix}`, navigation: true })).status).toBe(410);
    }
    expect((await old.request({ url: `${scope}${DOWNLOAD_ROOT}v1/missing`, method: 'POST' })).status).toBe(405);
    expect((await old.request({ url: `${scope}${DOWNLOAD_ROOT.slice(0, -1)}`, navigation: true })).status).toBe(410);
    expect(f.requested).toEqual([]);
  });

  it('keeps every automatic precache resource but excludes locale packages and source maps', async () => {
    const f = setup(), worker = f.make(a);
    await worker.lifecycle('install'); await worker.lifecycle('activate');
    const downloaded = f.requested.map(item => item.path);
    for (const file of ['runtime.wasm.gz', 'future-format.arbitrary', 'naidan-standalone.zip', 'worker.js']) expect(downloaded).toContain(file);
    for (const locale of UI_LOCALES) {
      const file = `naidan-standalone-${locale}.zip`;
      expect(a.files.has(file)).toBe(true);
      expect(downloaded).not.toContain(file);
    }
    expect(downloaded).not.toContain('ignored.map');
    f.offline();
    expect(await (await worker.request({ url: scope, navigation: true })).text()).toContain('version-a');
    expect(await (await worker.request({ url: `${scope}naidan-standalone.zip` })).text()).toBe('version-a:naidan-standalone.zip');
  });

  it('serves B before full installation, survives worker restart, and returns to offline only with B', async () => {
    const f = setup();
    await (await f.storage.open('user-model-sentinel')).put(`${scope}saved-model`, new Response('keep-model'));
    const old = f.make(a); await old.lifecycle('install'); await old.lifecycle('activate');
    const originalCacheNames = await f.storage.keys();
    const deleted = vi.spyOn(f.storage, 'delete');
    f.deployB(); const delayed = f.holdInstall();
    const next = f.make(b); let prepared = false;
    const installing = next.lifecycle('install').then(() => {
      prepared = true;
    });
    await delayed;
    expect(prepared).toBe(false);
    expect(await (await old.request({ url: scope, navigation: true })).text()).toContain('version-a');
    expect(await old.message({ clientId: 'page', data: { type: USE_NETWORK_MESSAGE } })).toBe(USE_NETWORK_MESSAGE);
    expect(await (await old.request({ url: scope, navigation: true })).text()).toContain('version-b');
    const restarted = f.make(a);
    for (const clientId of ['', 'page', 'other-tab', 'unattributed-worker']) {
      expect(await (await restarted.request({ url: `${scope}runtime.wasm.gz`, clientId })).text()).toBe('version-b:runtime.wasm.gz');
    }
    expect(deleted).not.toHaveBeenCalled();
    expect(await f.storage.keys()).toEqual(expect.arrayContaining(originalCacheNames));
    f.offline();
    await expect(restarted.request({ url: scope, navigation: true })).rejects.toThrow('offline');
    f.online(); f.release(); await installing; await next.lifecycle('activate');
    expect(prepared).toBe(true);
    f.offline();
    expect(await (await next.request({ url: scope, navigation: true })).text()).toContain('version-b');
    expect(await (await next.request({ url: `${scope}runtime.wasm.gz` })).text()).toBe('version-b:runtime.wasm.gz');
    expect(await (await (await f.storage.open('user-model-sentinel')).match(`${scope}saved-model`))?.text()).toBe('keep-model');
    expect(f.requested.some(item => item.path === 'runtime.wasm.gz' && item.cache === 'no-store')).toBe(true);
  });

  it('reports unreadable mode metadata and still loads the online version, never stale HTML', async () => {
    const f = setup(), old = f.make(a); await old.lifecycle('install'); await old.lifecycle('activate');
    const cache = await f.storage.open(`naidan-pwa-network-mode:${scope}`);
    const match = vi.spyOn(cache, 'match').mockRejectedValue(new Error('storage read failed'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      f.deployB();
      const restarted = f.make(a);
      expect(await (await restarted.request({ url: scope, navigation: true })).text()).toContain('version-b');
      expect(logged).toHaveBeenCalledWith('[PWA] Failed to read network update mode; using the network.', expect.any(Error));
      f.offline();
      await expect(restarted.request({ url: scope, navigation: true })).rejects.toThrow('offline');
    } finally {
      match.mockRestore(); logged.mockRestore();
    }
  });

  it('cannot enable network mode from another application or an unrecognized command', async () => {
    const f = setup(), worker = f.make(a); await worker.lifecycle('install'); await worker.lifecycle('activate'); f.deployB();
    expect(await worker.message({ clientId: 'other-app', data: { type: USE_NETWORK_MESSAGE } })).toBeUndefined();
    expect(await worker.message({ clientId: 'page', data: { type: 'unexpected' } })).toBeUndefined();
    expect(await (await worker.request({ url: scope, navigation: true })).text()).toContain('version-a');
  });

  it('acknowledges network mode only after its write is durable', async () => {
    const f = setup(), worker = f.make(a); await worker.lifecycle('install'); await worker.lifecycle('activate'); f.deployB();
    const cache = await f.storage.open(`naidan-pwa-network-mode:${scope}`);
    const realPut = cache.put.bind(cache);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const put = vi.spyOn(cache, 'put').mockImplementation(async (...args) => {
      await gate; await realPut(...args);
    });
    let acknowledged = false;
    const operation = worker.message({ clientId: 'page', data: { type: USE_NETWORK_MESSAGE } }).then(reply => {
      acknowledged = true; return reply;
    });
    try {
      expect(acknowledged).toBe(false);
      expect(await (await worker.request({ url: scope, navigation: true })).text()).toContain('version-a');
      release(); expect(await operation).toBe(USE_NETWORK_MESSAGE);
      expect(await (await f.make(a).request({ url: scope, navigation: true })).text()).toContain('version-b');
    } finally {
      release(); await operation; put.mockRestore();
    }
  });

  it('does not intercept foreign origins, sibling scopes or non-GET requests', async () => {
    const storage = new MemoryCacheStorage(), clients = new TestClients();
    clients.clients.set('page', { id: 'page', type: 'window', url: scope });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('untouched'));
    const worker = createWorkerHarness({ script: a.script, scope, cacheStorage: storage, clients, fetch });
    await worker.message({ clientId: 'page', data: { type: USE_NETWORK_MESSAGE } });
    const reply = new Response('stream');
    for (const [url, method] of [
      ['https://models.example/model.gguf', 'GET'],
      ['https://example.test/naidan-other/data', 'GET'],
      [`${scope}api`, 'POST'],
    ]) {
      fetch.mockClear(); fetch.mockResolvedValue(reply);
      expect(await worker.request({ url: url!, method: method! })).toBe(reply);
      // An unhandled fetch uses the browser default: no no-store override,
      // response wrapper, cloned stream or involvement of the Workbox router.
      expect(fetch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ url, method }));
    }
  });

  it.each(['foreign-origin', 'worker-source', 'missing-port'] as const)('rejects %s network opt-ins', async kind => {
    const f = setup(), worker = f.make(a); await worker.lifecycle('install'); await worker.lifecycle('activate'); f.deployB();
    f.clients.clients.set('worker', { id: 'worker', type: 'worker', url: `${scope}worker.js` });
    expect(await worker.message({
      clientId: kind === 'worker-source' ? 'worker' : 'page',
      origin: kind === 'foreign-origin' ? 'https://other.example' : new URL(scope).origin,
      replyPort: kind !== 'missing-port',
      data: { type: USE_NETWORK_MESSAGE },
    })).toBeUndefined();
    expect(await (await worker.request({ url: scope, navigation: true })).text()).toContain('version-a');
  });

  it('does not acknowledge a failed opt-in write or change the working cache path', async () => {
    const f = setup(), worker = f.make(a); await worker.lifecycle('install'); await worker.lifecycle('activate');
    const cache = await f.storage.open(`naidan-pwa-network-mode:${scope}`);
    const put = vi.spyOn(cache, 'put').mockRejectedValue(new Error('storage full'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await worker.message({ clientId: 'page', data: { type: USE_NETWORK_MESSAGE } })).toBe(false);
      f.offline();
      expect(await (await worker.request({ url: scope, navigation: true })).text()).toContain('version-a');
    } finally {
      put.mockRestore(); logged.mockRestore();
    }
  });

  it.each(['http', 'network', 'quota'] as const)('retains original %s errors and rejects incomplete installs', async mode => {
    const f = setup();
    const error = new Error('injected resource failure');
    if (mode === 'quota') {
      const open = f.storage.open.bind(f.storage);
      vi.spyOn(f.storage, 'open').mockImplementation(async name => {
        const cache = await open(name);
        if (name.startsWith('workbox-precache')) vi.spyOn(cache, 'put').mockRejectedValue(error);
        return cache;
      });
    }
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith('/naidan-standalone.zip')) {
        if (mode === 'http') return new Response('missing', { status: 404 });
        if (mode === 'network') throw error;
      }
      return f.network(input, init);
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const worker = createWorkerHarness({ script: a.script, scope, cacheStorage: f.storage, clients: f.clients, fetch });
      await expect(worker.lifecycle('install')).rejects.toThrow();
      expect(log).toHaveBeenCalledWith('[PWA] Failed to precache an application resource.', expect.any(String), expect.any(Error));
      if (mode !== 'http') expect(log.mock.calls.some(call => call[2] === error)).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('page reloads using real generated workers', () => {
  it('injects the same identity into compiled page code and the installing worker', async () => {
    const f = setup();
    for (const version of [a, b, c]) {
      const worker = f.make(version);
      expect(await worker.message({ clientId: 'page', data: { type: BUILD_ID_MESSAGE } })).toEqual({ type: BUILD_ID_MESSAGE, buildId: version.pageBuildId });
    }
  });

  it('reloads once into B, completes B offline without another action, then announces C', async () => {
    const f = setup();
    const native = createRegistrationPlatform({ scope, fetch: f.network });
    native.addWorker({ key: 'worker-a', script: a.script });
    await native.install({ key: 'worker-a' });
    const reload = vi.fn(), onError = vi.fn(), onWarning = vi.fn(), onOfflineReady = vi.fn();
    const statesA: PWAUpdateState[] = [], statesB: PWAUpdateState[] = [];
    const pageA = native.page({ key: 'page-a' });
    const controllerA = createPWAUpdateController({ platform: { serviceWorkers: pageA, reload }, baseUrl: new URL(scope), pageBuildId: a.pageBuildId, onState: ({ next }) => statesA.push(next), onError, onWarning, onOfflineReady });
    let controllerB: ReturnType<typeof createPWAUpdateController> | undefined;
    f.deployB(); const delayed = f.holdInstall();
    native.addWorker({ key: 'worker-b', script: b.script });
    const installing = native.install({ key: 'worker-b' });
    try {
      await delayed;
      await vi.waitFor(() => expect(statesA.at(-1)?.kind).toBe('preparing'));
      const action = statesA.at(-1)!;
      if (action.kind === 'idle') throw new Error('Missing update');
      await action.handler!();
      expect(reload).toHaveBeenCalledOnce();
      expect(native.workers.get('worker-b')!.state).toBe('installing');
      // Do not invent the next page identity based on the button click.
      expect(await (await native.request({ pageKey: 'page-a', navigation: true })).text()).toContain(b.pageBuildId);
      controllerA.dispose();
      const pageB = native.page({ key: 'page-b' });
      expect(pageB.controller?.state).toBe('activated');
      expect(native.workers.get('worker-a')!.state).toBe('activated');
      controllerB = createPWAUpdateController({ platform: { serviceWorkers: pageB, reload }, baseUrl: new URL(scope), pageBuildId: b.pageBuildId, onState: ({ next }) => statesB.push(next), onError, onWarning, onOfflineReady });
      await vi.waitFor(() => expect(statesB.length).toBeGreaterThan(1));
      expect(statesB.every(state => state.kind === 'idle')).toBe(true);
      expect(native.workers.get('worker-b')!.skipped).toBe(false);
      f.release(); await installing;
      await vi.waitFor(() => expect(native.workers.get('worker-b')!.state).toBe('activated'));
      expect(native.workers.get('worker-a')!.state).toBe('redundant');
      expect(pageB.controller).toBe(native.registration({ viewer: 'page-b' }).active);
      expect(statesB.every(state => state.kind === 'idle')).toBe(true);
      expect(reload).toHaveBeenCalledOnce();
      f.offline();
      expect(await (await native.request({ pageKey: 'page-b', navigation: true })).text()).toContain(b.pageBuildId);
      expect(await (await native.request({ pageKey: 'page-b', path: 'runtime.wasm.gz' })).text()).toBe('version-b:runtime.wasm.gz');
      f.online(); f.deployC();
      native.addWorker({ key: 'worker-c', script: c.script });
      await native.install({ key: 'worker-c' });
      await vi.waitFor(() => expect(statesB.at(-1)?.kind).toBe('ready'));
      expect(native.workers.get('worker-c')!.skipped).toBe(false);
      expect(reload).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
      expect(onWarning).not.toHaveBeenCalled();
      expect(native.failures).toEqual([]);
    } finally {
      controllerA.dispose(); controllerB?.dispose(); f.release(); await installing;
    }
  });

  it('waits for an old-worker stream to finish before automatic activation', async () => {
    const f = setup();
    const native = createRegistrationPlatform({ scope, fetch: f.network });
    native.addWorker({ key: 'worker-a', script: a.script });
    await native.install({ key: 'worker-a' });
    native.page({ key: 'download-page' });
    f.deployB();
    native.addWorker({ key: 'worker-b', script: b.script });
    await native.install({ key: 'worker-b' });
    const old = native.workers.get('worker-a')!;
    const control = new MessageChannel(), data = new MessageChannel();
    const statuses: Array<{ type: string }> = [];
    control.port1.onmessage = event => statuses.push(downloadStatusSchema.parse(event.data));
    const release = Promise.withResolvers<void>();
    const sender = serveByteStream({
      port: data.port1,
      signal: undefined,
      openStream: async () => new ReadableStream<Uint8Array>({
        async start(controller) {
          await release.promise; controller.enqueue(new Uint8Array([1, 2, 3])); controller.close();
        },
      }),
    });
    const token = crypto.randomUUID();
    const prepared = old.runtime.messageWithPorts({ clientId: 'download-page', data: { type: 'naidan-download/prepare', version: 2, token, metadata: { filename: 'in-flight.bin', size: 3 } }, ports: [control.port2, data.port2] });
    let settled: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await vi.waitFor(() => expect(statuses).toContainEqual(expect.objectContaining({ type: 'ready' })));
      const result = await old.runtime.streamRequest({ url: createDownloadUrl({ base: new URL(scope), token, version: 2 }).href, clientId: 'download-page', navigation: true });
      const bytes = result.response.arrayBuffer();
      // Keep failure-path cleanup observed too: a guard-removal regression
      // should fail its assertion, not leak an unrelated rejected stream.
      settled = Promise.allSettled([bytes, sender.completed, result.completed]);
      expect(await old.runtime.message({ clientId: 'download-page', data: { type: COMPLETE_OFFLINE_MESSAGE, buildId: b.pageBuildId } })).toBe(COMPLETE_OFFLINE_MESSAGE);
      expect(native.workers.get('worker-b')!.skipped).toBe(false);
      expect(old.state).toBe('activated');
      release.resolve();
      expect([...new Uint8Array(await bytes)]).toEqual([1, 2, 3]);
      await sender.completed; await result.completed;
      await vi.waitFor(() => expect(native.workers.get('worker-b')!.state).toBe('activated'));
      await vi.waitFor(() => expect(statuses).toContainEqual({ type: 'consumed' }));
      expect(native.failures).toEqual([]);
    } finally {
      release.resolve(); control.port1.postMessage({ type: 'cancel' });
      await prepared; sender.abort({ reason: new Error('cleanup') }); await settled; control.port1.close();
    }
  });

  it('does not clean away C entries when C is installing before B activates', async () => {
    const f = setup(), native = createRegistrationPlatform({ scope, fetch: f.network });
    native.addWorker({ key: 'worker-a', script: a.script }); await native.install({ key: 'worker-a' });
    native.page({ key: 'page' });
    f.deployB(); native.addWorker({ key: 'worker-b', script: b.script }); await native.install({ key: 'worker-b' });
    f.deployC(); const delayed = f.holdInstall();
    native.addWorker({ key: 'worker-c', script: c.script }); const installation = native.install({ key: 'worker-c' });
    try {
      await delayed;
      native.registration({ viewer: 'page' }).waiting!.postMessage({ type: 'SKIP_WAITING' });
      await vi.waitFor(() => expect(native.workers.get('worker-b')!.state).toBe('activated'));
      f.release(); await installation;
      f.offline();
      native.registration({ viewer: 'page' }).waiting!.postMessage({ type: 'SKIP_WAITING' });
      await vi.waitFor(() => expect(native.workers.get('worker-c')!.state).toBe('activated'));
      expect(await (await native.request({ pageKey: 'page', navigation: true })).text()).toContain('version-c');
      expect(await (await native.request({ pageKey: 'page', path: 'runtime.wasm.gz' })).text()).toBe('version-c:runtime.wasm.gz');
      expect(native.failures).toEqual([]);
    } finally {
      f.release(); await installation;
    }
  });

  it('delays C writes if B cleanup started first, then serves C offline', async () => {
    const f = setup(), native = createRegistrationPlatform({ scope, fetch: f.network });
    native.addWorker({ key: 'worker-a', script: a.script }); await native.install({ key: 'worker-a' });
    native.page({ key: 'page' });
    f.deployB(); native.addWorker({ key: 'worker-b', script: b.script }); await native.install({ key: 'worker-b' });
    const cache = [...native.storage.stores.values()].find(item => [...item.entries.keys()].some(key => key.includes('__WB_REVISION__')))!;
    const originalKeys = cache.keys.bind(cache);
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const cleanup = vi.spyOn(cache, 'keys').mockImplementation(async () => {
      // Hold BEFORE collecting deletion keys: unguarded C writes would be
      // included in B's cleanup, not merely arrive after a harmless snapshot.
      started.resolve(); await release.promise; return originalKeys();
    });
    let installation: Promise<void> | undefined;
    try {
      native.registration({ viewer: 'page' }).waiting!.postMessage({ type: 'SKIP_WAITING' });
      await started.promise;
      expect(native.workers.get('worker-b')!.state).toBe('activating');
      f.deployC(); f.requested.length = 0;
      native.addWorker({ key: 'worker-c', script: c.script }); installation = native.install({ key: 'worker-c' });
      // Drain queued stream/cache/message tasks, not only two Promise callbacks.
      // Removing the install barrier must expose actual C network requests.
      for (let turn = 0; turn < 12; turn++) await setImmediate();
      expect(f.requested).toEqual([]);
      release.resolve(); await installation;
      f.offline();
      native.registration({ viewer: 'page' }).waiting!.postMessage({ type: 'SKIP_WAITING' });
      await vi.waitFor(() => expect(native.workers.get('worker-c')!.state).toBe('activated'));
      expect(await (await native.request({ pageKey: 'page', navigation: true })).text()).toContain('version-c');
      expect(await (await native.request({ pageKey: 'page', path: 'runtime.wasm.gz' })).text()).toBe('version-c:runtime.wasm.gz');
      expect(native.failures).toEqual([]);
    } finally {
      release.resolve(); await installation; cleanup.mockRestore();
    }
  });

  it('does not let a waiting worker approve completion using its empty download session map', async () => {
    const f = setup(), native = createRegistrationPlatform({ scope, fetch: f.network });
    native.addWorker({ key: 'worker-a', script: a.script }); await native.install({ key: 'worker-a' });
    native.page({ key: 'page' });
    f.deployB(); native.addWorker({ key: 'worker-b', script: b.script }); await native.install({ key: 'worker-b' });
    const next = native.workers.get('worker-b')!;
    expect(await next.runtime.message({ clientId: 'page', data: { type: COMPLETE_OFFLINE_MESSAGE, buildId: b.pageBuildId } })).toBe(false);
    expect(next.skipped).toBe(false);
    expect(next.state).toBe('installed');
  });

  it('requires both the active-worker sender and the exact build for automatic activation', async () => {
    const f = setup(), native = createRegistrationPlatform({ scope, fetch: f.network });
    native.addWorker({ key: 'worker-a', script: a.script }); await native.install({ key: 'worker-a' });
    native.page({ key: 'page' });
    f.deployB(); native.addWorker({ key: 'worker-b', script: b.script }); await native.install({ key: 'worker-b' });
    const next = native.workers.get('worker-b')!;
    await next.runtime.messageWithPorts({ clientId: 'page', data: { type: ACTIVATE_BUILD_MESSAGE, buildId: b.pageBuildId }, ports: [] });
    expect(next.skipped).toBe(false);
    const active = native.registration({ viewer: 'worker-b' }).active!;
    await next.runtime.messageWithPorts({ clientId: '', source: active, data: { type: ACTIVATE_BUILD_MESSAGE, buildId: c.pageBuildId }, ports: [] });
    expect(next.skipped).toBe(false);
    await next.runtime.messageWithPorts({ clientId: '', source: active, data: { type: ACTIVATE_BUILD_MESSAGE, buildId: b.pageBuildId }, ports: [] });
    await vi.waitFor(() => expect(next.state).toBe('activated'));
    expect(native.failures).toEqual([]);
  });

  it('does not implicitly claim a document during first installation', async () => {
    const f = setup(), native = createRegistrationPlatform({ scope, fetch: f.network });
    const page = native.page({ key: 'first-page' });
    native.addWorker({ key: 'worker-a', script: a.script }); await native.install({ key: 'worker-a' });
    expect(native.workers.get('worker-a')!.state).toBe('activated');
    expect(page.controller).toBeNull();
    const second = native.page({ key: 'second-page' });
    expect(second.controller).not.toBeNull();
  });
});
