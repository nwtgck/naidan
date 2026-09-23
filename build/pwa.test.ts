// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest';
import { pwaInstallFailureSchema } from '../src/logic/pwa/install-diagnostics';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { build } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { createPWABuild } from './pwa';
import { createWorkerHarness, MemoryCacheStorage, TestClients } from './test-support/pwa-worker-platform';
import { NETWORK_UPDATE_PARAMETER, PWA_PROTOCOL } from '../src/logic/pwa/protocol';
import { UI_LOCALES } from '../src/01-models/ui-locale';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function bundle({ buildId }: { buildId: string }) {
  const projectRoot = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), 'naidan-pwa-real-worker-'));
  roots.push(root);
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, 'index.html'), `<html data-build="${buildId}"><script type="module" src="/entry.js"></script></html>`);
  await writeFile(path.join(root, 'entry.js'), 'console.log(__PWA_BUILD_ID__);');
  // Derive locale fixtures from the app's supported locales so newly added
  // languages are covered without maintaining a separate test-only list.
  for (const name of [
    'future-format.arbitrary', 'runtime.wasm.gz', 'naidan-standalone.zip', 'favicon.svg', 'ignored.map',
    ...UI_LOCALES.map(locale => `naidan-standalone-${locale}.zip`),
  ]) {
    await writeFile(path.join(root, 'public', name), `${buildId}:${name}`);
  }
  const config = createPWABuild({ buildId });
  const outDir = path.join(root, 'dist');
  await build({
    root, configFile: false, logLevel: 'silent', base: './',
    define: config.define,
    plugins: [VitePWA({ ...config.options, srcDir: path.join(projectRoot, 'pwa') })],
    build: { outDir, emptyOutDir: true },
  });
  const files = new Map<string, Buffer>();
  async function collect(directory: string) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) await collect(absolute);
      else files.set(path.relative(outDir, absolute).replaceAll('\\', '/'), await readFile(absolute));
    }
  }
  await collect(outDir);
  return { files, script: (await readFile(path.join(outDir, 'sw.js'), 'utf8')) };
}

describe('production PWA build and generated worker', () => {
  it('keeps the all-assets cache, bypasses it deliberately during installation, and restores it without clearing user data', async () => {
    const versionA = await bundle({ buildId: 'version-a' });
    const versionB = await bundle({ buildId: 'version-b' });
    let deployed = versionA.files;
    let offline = false;
    let releaseSlow: (() => void) | undefined;
    const requested: Array<{ path: string; cache: RequestCache | undefined }> = [];
    const scope = 'https://example.test/naidan/';
    const network: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (offline) throw new TypeError('offline');
      const file = url.pathname.slice('/naidan/'.length) || 'index.html';
      requested.push({ path: file, cache: init?.cache ?? (input instanceof Request ? input.cache : undefined) });
      if (deployed === versionB.files && file === 'naidan-standalone.zip' && !url.searchParams.has(NETWORK_UPDATE_PARAMETER)) {
        await new Promise<void>(resolve => {
          releaseSlow = resolve;
        });
      }
      const body = deployed.get(file);
      return new Response(body ? new Uint8Array(body) : 'missing', {
        status: body ? 200 : 404,
        headers: {
          'content-type': file === 'index.html' ? 'text/html' : 'application/octet-stream',
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-embedder-policy': 'require-corp',
        },
      });
    };
    const cacheStorage = new MemoryCacheStorage();
    await (await cacheStorage.open('user-model-sentinel')).put(new Request(`${scope}saved-model`), new Response('keep-model'));
    const clients = new TestClients();
    clients.clients.set('old-tab', { id: 'old-tab', type: 'window', url: scope });
    const oldWorker = createWorkerHarness({ script: versionA.script, scope, cacheStorage, clients, fetch: network });
    await oldWorker.lifecycle('install'); await oldWorker.lifecycle('activate');
    const precachePaths = requested.map(item => item.path);
    const pageEntry = Array.from(versionA.files).find(([file]) => file.startsWith('assets/') && file.endsWith('.js'));
    expect(pageEntry?.[1].toString()).toContain('version-a');
    expect(versionA.files.has('registerSW.js')).toBe(false);
    expect(precachePaths).toContain('future-format.arbitrary');
    expect(precachePaths).toContain('naidan-standalone.zip');
    expect(precachePaths).not.toContain('ignored.map');
    for (const locale of UI_LOCALES) {
      const fileName = `naidan-standalone-${locale}.zip`;
      // Absence from the cache must not be explained by absence from the
      // hosted output: these downloads remain available over the network.
      expect(versionA.files.has(fileName), fileName).toBe(true);
      expect(precachePaths, fileName).not.toContain(fileName);
      const download = await oldWorker.request({ url: `${scope}${fileName}`, clientId: 'old-tab' });
      expect(await download.text()).toBe(`version-a:${fileName}`);
    }

    deployed = versionB.files;
    const newWorker = createWorkerHarness({ script: versionB.script, scope, cacheStorage, clients, fetch: network });
    let installed = false;
    const install = newWorker.lifecycle('install').then(() => {
      installed = true;
    });
    for (let i = 0; !releaseSlow && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(releaseSlow).toBeTypeOf('function');
    expect(installed).toBe(false);
    const cachedOld = await oldWorker.request({ url: scope, navigation: true, destination: 'document' });
    expect(await cachedOld.text()).toContain('version-a');

    const onlineUrl = `${scope}?${NETWORK_UPDATE_PARAMETER}=01234567-1234-1234-1234-0123456789ab`;
    const newDocument = await oldWorker.request({ url: onlineUrl, navigation: true, destination: 'document', resultingClientId: 'new-tab' });
    expect(await newDocument.text()).toContain('version-b');
    expect(newDocument.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(installed).toBe(false);
    clients.clients.set('new-tab', { id: 'new-tab', type: 'window', url: onlineUrl });
    const appRuntime = await oldWorker.request({ url: `${scope}runtime.wasm.gz`, clientId: 'new-tab' });
    expect(await appRuntime.text()).toBe('version-b:runtime.wasm.gz');
    const oldRuntime = await oldWorker.request({ url: `${scope}runtime.wasm.gz`, clientId: 'old-tab' });
    expect(await oldRuntime.text()).toBe('version-a:runtime.wasm.gz');

    await oldWorker.request({ url: `${scope}future-format.arbitrary`, clientId: 'new-tab', resultingClientId: 'worker-client', destination: 'worker' });
    clients.clients.set('worker-client', { id: 'worker-client', type: 'worker', url: `${scope}future-format.arbitrary` });
    const restarted = createWorkerHarness({ script: versionA.script, scope, cacheStorage, clients, fetch: network });
    expect(await (await restarted.request({ url: `${scope}runtime.wasm.gz`, clientId: 'worker-client' })).text()).toBe('version-b:runtime.wasm.gz');
    expect(await restarted.message({ clientId: 'new-tab', data: { protocol: PWA_PROTOCOL, type: 'bind-page', buildId: 'version-b' } })).toEqual({ protocol: PWA_PROTOCOL, buildId: 'version-a', ok: true });

    offline = true;
    await expect(restarted.request({ url: onlineUrl })).rejects.toThrow('offline');
    expect(await (await restarted.request({ url: scope, navigation: true, destination: 'document', referrer: onlineUrl })).text()).toContain('version-a');
    offline = false;
    // Release the unrelated ZIP; the original FULL installation, not a partial
    // manifest, now finishes. No application cache was explicitly discarded.
    deployed = versionB.files;
    releaseSlow!(); await install; await newWorker.lifecycle('activate');
    expect(installed).toBe(true);
    expect(await newWorker.message({ clientId: 'new-tab', data: { protocol: PWA_PROTOCOL, type: 'complete-page', buildId: 'wrong-version' } })).toEqual({ protocol: PWA_PROTOCOL, buildId: 'version-b', ok: false });
    expect(await newWorker.message({ clientId: 'new-tab', data: { protocol: PWA_PROTOCOL, type: 'complete-page', buildId: 'version-b' } })).toEqual({ protocol: PWA_PROTOCOL, buildId: 'version-b', ok: true });
    clients.clients.set('new-tab', { id: 'new-tab', type: 'window', url: scope });
    offline = true;
    expect(await (await newWorker.request({ url: `${scope}runtime.wasm.gz`, clientId: 'new-tab' })).text()).toBe('version-b:runtime.wasm.gz');
    expect(await (await newWorker.request({ url: `${scope}runtime.wasm.gz`, clientId: 'worker-client' })).text()).toBe('version-b:runtime.wasm.gz');
    expect(await (await newWorker.request({ url: `${scope}naidan-standalone.zip`, clientId: 'new-tab' })).text()).toBe('version-b:naidan-standalone.zip');
    expect(await (await (await cacheStorage.open('user-model-sentinel')).match(`${scope}saved-model`))?.text()).toBe('keep-model');
    expect(requested.some(item => item.path === 'runtime.wasm.gz' && item.cache === 'no-store')).toBe(true);
  }, 60000);
  it('reports actual HTTP, network and cache failures while rejecting the generated worker installation', async () => {
    const version = await bundle({ buildId: 'failed-install' });
    const scope = 'https://example.test/naidan/';
    const resourceUrl = `${scope}naidan-standalone.zip`;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const mode of ['http-404', 'http-503', 'network', 'quota'] as const) {
        const delivered: unknown[] = [];
        const unrelated = vi.fn();
        const clients = new TestClients();
        const matchAll = vi.spyOn(clients, 'matchAll');
        clients.clients.set('closing-tab', { id: 'closing-tab', type: 'window', url: scope, postMessage: () => {
          throw new Error('window closed');
        } });
        clients.clients.set('old-tab', { id: 'old-tab', type: 'window', url: scope, postMessage: message => delivered.push(message) });
        clients.clients.set('other-app', { id: 'other-app', type: 'window', url: 'https://example.test/other/', postMessage: unrelated });
        const cacheStorage = new MemoryCacheStorage();
        const cacheError = Object.assign(new Error('Cache storage is full'), { name: 'QuotaExceededError' });
        const fetchError = new TypeError('Failed to fetch');
        if (mode === 'quota') {
          const open = cacheStorage.open.bind(cacheStorage);
          const wrapped = new WeakSet<Cache>();
          vi.spyOn(cacheStorage, 'open').mockImplementation(async name => {
            const cache = await open(name);
            if (!wrapped.has(cache)) {
              wrapped.add(cache);
              const put = cache.put.bind(cache);
              vi.spyOn(cache, 'put').mockImplementation(async (request, response) => {
                const url = request instanceof Request ? request.url : String(request);
                if (new URL(url).pathname === new URL(resourceUrl).pathname) throw cacheError;
                await put(request, response);
              });
            }
            return cache;
          });
        }
        const network: typeof fetch = async input => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.href === resourceUrl) {
            switch (mode) {
            case 'http-404': return new Response('missing', { status: 404 });
            case 'http-503': return new Response('unavailable', { status: 503 });
            case 'network': throw fetchError;
            case 'quota': break;
            default: {
              const exhaustive: never = mode;
              throw new Error(`Unexpected failure mode: ${exhaustive}`);
            }
            }
          }
          const file = url.pathname.slice('/naidan/'.length) || 'index.html';
          const bytes = version.files.get(file);
          return new Response(bytes ? new Uint8Array(bytes) : 'missing', { status: bytes ? 200 : 404 });
        };
        const worker = createWorkerHarness({ script: version.script, scope, cacheStorage, clients, fetch: network });
        const installation = worker.lifecycle('install');
        if (mode === 'network') await expect(installation).rejects.toBe(fetchError);
        else if (mode === 'quota') await expect(installation).rejects.toBe(cacheError);
        else await expect(installation).rejects.toMatchObject({ name: 'bad-precaching-response' });
        expect(delivered, mode).toHaveLength(1);
        const failure = pwaInstallFailureSchema.parse(delivered[0]);
        expect(failure).toMatchObject({ resourceUrl, scope, buildId: 'failed-install' });
        expect(failure.error.name).toBe(mode === 'quota' ? 'QuotaExceededError' : mode === 'network' ? 'TypeError' : 'bad-precaching-response');
        if (mode === 'http-404' || mode === 'http-503') expect(failure.error.status).toBe(mode === 'http-404' ? 404 : 503);
        else expect(failure.error.status).toBeUndefined();
        expect(matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
        expect(unrelated).not.toHaveBeenCalled();
      }
    } finally {
      consoleError.mockRestore();
      vi.restoreAllMocks();
    }
  }, 60000);

});
