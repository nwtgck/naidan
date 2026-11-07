// @vitest-environment node
import { rm } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { build, createServer } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { createPrivacyFetchBrokerDevPlugin, TEST_ONLY } from './privacy-fetch-broker-dev';
import { createBrokerDevFixture } from './privacy-fetch-broker-dev.test-support';
import { createBuildDom } from './jsdom';

const poll = { timeout: 15_000, interval: 50 };

function expectBrokerHeaders({ response }: { response: Response }) {
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
}

function isHotMessage({ event, type }: { event: unknown, type: string }): boolean {
  return event !== null && typeof event === 'object' && 'type' in event && event.type === type;
}

async function evaluate({ source }: { source: string }) {
  const context = vm.createContext({});
  const module = new vm.SourceTextModule(source, { context });
  await module.link(specifier => {
    throw new Error(`Unexpected unbundled import: ${specifier}`);
  });
  await module.evaluate();
  return context;
}

describe('privacy broker bundled development server', () => {
  it('serves the first opaque-origin request without warming a module graph', async () => {
    await using fixture = await createBrokerDevFixture();
    const response = await fixture.request();
    expect(response.status).toBe(200);
    expectBrokerHeaders({ response });
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(await response.text()).toContain('initial-broker');
    const html = await fixture.request({ file: 'privacy-fetch-broker.html' });
    expect(html.status).toBe(200);
    expect(html.headers.get('access-control-allow-origin')).toBeNull();
    expect(await html.text()).toContain('src="/assets/privacy-fetch-broker/broker.js"');
    const raw = await fixture.request({ file: 'src/unrelated.ts' });
    expect(raw.status).toBe(200);
    expect(raw.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('does not run HTML injection plugins in the sandbox but keeps them for the app', async () => {
    await using fixture = await createBrokerDevFixture({ plugins: [{ name: 'injected-probe', transformIndexHtml: html => html + '<script src="/devtools-probe.js"></script>' }] });
    const broker = await (await fixture.request({ file: 'privacy-fetch-broker.html' })).text();
    expect(broker).not.toContain('/@vite/client');
    expect(broker).not.toContain('devtools-probe');
    const app = await (await fixture.request({ file: '' })).text();
    expect(app).toContain('/@vite/client');
    expect(app).toContain('devtools-probe');
  });

  it('handles HEAD, cache validators and query strings without a separate 304 path', async () => {
    await using fixture = await createBrokerDevFixture();
    const response = await fixture.request({ headers: { 'If-None-Match': '*', 'If-Modified-Since': new Date().toUTCString() } });
    expect(response.status).toBe(200);
    const body = await response.text();
    const head = await fixture.request({ method: 'HEAD', file: 'assets/privacy-fetch-broker/broker.js?t=123' });
    expect(head.status).toBe(200);
    expectBrokerHeaders({ response: head });
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
    expect(await head.text()).toBe('');
    const htmlHead = await fixture.request({ method: 'HEAD', file: 'privacy-fetch-broker.html?t=123' });
    expect(htmlHead.status).toBe(200);
    expect(htmlHead.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(htmlHead.headers.get('access-control-allow-origin')).toBeNull();
    expect(await htmlHead.text()).toBe('');
  });

  it('rejects unsupported methods and unknown assets instead of falling through to application HTML', async () => {
    await using fixture = await createBrokerDevFixture();
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await fixture.request({ method });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
      expectBrokerHeaders({ response });
    }
    // Vite's earlier CORS middleware owns OPTIONS; null is not granted there.
    const preflight = await fixture.request({ method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    for (const file of ['missing.js', 'broker.js/other', '%2e%2e%2fsrc%2funrelated.ts', '%2e%2e%5csrc%5cunrelated.ts', 'broker.js%00']) {
      const response = await fixture.request({ file: `assets/privacy-fetch-broker/${file}` });
      expect(response.status, file).toBe(404);
      expectBrokerHeaders({ response });
      expect(await response.text()).not.toContain('unrelated-source');
    }
    const similar = await fixture.request({ file: 'assets/privacy-fetch-broker-other/broker.js' });
    expect(similar.headers.get('access-control-allow-origin')).toBeNull();
    const similarHtml = await fixture.request({ file: 'privacy-fetch-broker.html.extra?t=1' });
    expect(similarHtml.headers.get('cross-origin-resource-policy')).toBeNull();
    expect(similarHtml.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('supports a development base prefix', async () => {
    await using fixture = await createBrokerDevFixture({ base: '/nested/' });
    expect((await fixture.request()).status).toBe(200);
    expect(await (await fixture.request({ file: 'privacy-fetch-broker.html' })).text()).toContain('src="/nested/assets/privacy-fetch-broker/broker.js"');
  });

  it('collects new static and lazy dependencies without a CORS path list and preserves lazy side effects', async () => {
    await using fixture = await createBrokerDevFixture({
      entry: 'import { value } from "@/shared/value"; globalThis.brokerProbe = value; globalThis.loadProbe = () => import("@/shared/lazy");',
      files: {
        'src/shared/value.ts': 'export const value: string = "shared-value";',
        'src/shared/lazy.ts': 'globalThis.lazyProbe = "lazy-value"; export const value = "lazy-result";',
      },
    });
    const response = await fixture.request();
    expect(response.status).toBe(200);
    const context = await evaluate({ source: await response.text() });
    expect(context.brokerProbe).toBe('shared-value');
    expect(context.lazyProbe).toBeUndefined();
    await context.loadProbe();
    expect(context.lazyProbe).toBe('lazy-value');
    const source = await fixture.request({ file: 'src/shared/value.ts' });
    expect(source.headers.get('access-control-allow-origin')).toBeNull();
    await fixture.write({ file: 'src/shared/lazy.ts', source: 'globalThis.lazyProbe = "updated-lazy";' });
    await vi.waitFor(async () => expect(await (await fixture.request()).text()).toContain('updated-lazy'), poll);
    expect(fixture.send).toHaveBeenCalledWith({ type: 'full-reload' });
  }, 25_000);

  it('reuses development environment flags and application defines', async () => {
    await using fixture = await createBrokerDevFixture({ entry: 'globalThis.brokerProbe = { dev: import.meta.env.DEV, prod: import.meta.env.PROD, mode: import.meta.env.MODE, value: __BROKER_PROBE__ };' });
    const context = await evaluate({ source: await (await fixture.request()).text() });
    expect(context.brokerProbe).toEqual({ dev: true, prod: false, mode: 'development', value: 'shared-define' });
    expect(fixture.server.config.isProduction).toBe(false);
  });

  it('does not reload when the completed output is unchanged', async () => {
    await using fixture = await createBrokerDevFixture();
    const source = await (await fixture.request()).text();
    await fixture.write({
      file: 'src/features/privacy-fetch/broker-entry.ts',
      source: `\
// comment only
globalThis.brokerProbe = "initial-broker";`,
    });
    // Give the shared watcher a quiet interval, then check the complete message
    // sequence again after an observable, content-changing build below.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await (await fixture.request()).text()).toBe(source);
    expect(fixture.send.mock.calls.some(([event]) => isHotMessage({ event, type: 'full-reload' }))).toBe(false);
    await fixture.write({ file: 'src/features/privacy-fetch/broker-entry.ts', source: 'globalThis.brokerProbe = "changed-broker";' });
    await vi.waitFor(async () => expect(await (await fixture.request()).text()).toContain('changed-broker'), poll);
    expect(fixture.send.mock.calls.filter(([event]) => isHotMessage({ event, type: 'full-reload' }))).toHaveLength(1);
  }, 25_000);

  it('fails closed after syntax errors and reloads on recovery even when restored bytes are identical', async () => {
    await using fixture = await createBrokerDevFixture();
    const original = await (await fixture.request()).text();
    await fixture.write({ file: 'src/features/privacy-fetch/broker-entry.ts', source: 'const broken: = ;' });
    await vi.waitFor(async () => expect((await fixture.request()).status).toBe(503), poll);
    expect((await fixture.request({ file: 'privacy-fetch-broker.html' })).status).toBe(503);
    expectBrokerHeaders({ response: await fixture.request() });
    expect(fixture.send.mock.calls.some(([event]) => isHotMessage({ event, type: 'error' }))).toBe(true);
    fixture.send.mockClear();
    await fixture.write({ file: 'src/features/privacy-fetch/broker-entry.ts', source: 'globalThis.brokerProbe = "initial-broker";' });
    await vi.waitFor(async () => expect((await fixture.request()).status).toBe(200), poll);
    expect(await (await fixture.request()).text()).toBe(original);
    expect(fixture.send).toHaveBeenCalledWith({ type: 'full-reload' });
  }, 25_000);

  it('starts with a compile error and recovers without restarting Vite', async () => {
    await using fixture = await createBrokerDevFixture({ entry: 'const broken: = ;' });
    expect((await fixture.request()).status).toBe(503);
    await fixture.write({ file: 'src/features/privacy-fetch/broker-entry.ts', source: 'globalThis.brokerProbe = "repaired-broker";' });
    await vi.waitFor(async () => expect(await (await fixture.request()).text()).toContain('repaired-broker'), poll);
  }, 25_000);

  it('rejects extra CSS/assets instead of silently dropping them', async () => {
    await using fixture = await createBrokerDevFixture({ entry: 'import "./style.css";', files: { 'src/features/privacy-fetch/style.css': 'body { color: red; }' } });
    expect((await fixture.request()).status).toBe(503);
    await fixture.write({ file: 'src/features/privacy-fetch/broker-entry.ts', source: 'globalThis.brokerProbe = "no-css";' });
    await vi.waitFor(async () => expect(await (await fixture.request()).text()).toContain('no-css'), poll);
  }, 25_000);

  it('watches the canonical HTML, surfaces invalid templates, and recovers', async () => {
    await using fixture = await createBrokerDevFixture();
    await fixture.write({ file: 'privacy-fetch-broker.html', source: fixture.html.replace('Privacy fetch broker', 'Updated title') });
    await vi.waitFor(async () => expect(await (await fixture.request({ file: 'privacy-fetch-broker.html' })).text()).toContain('Updated title'), poll);
    await fixture.write({ file: 'privacy-fetch-broker.html', source: '<script src="/other.ts"></script>' });
    await vi.waitFor(async () => expect((await fixture.request()).status).toBe(503), poll);
    await fixture.write({ file: 'privacy-fetch-broker.html', source: fixture.html });
    await vi.waitFor(async () => expect((await fixture.request()).status).toBe(200), poll);
  }, 25_000);

  it('handles deletion and restoration of an existing dependency', async () => {
    await using fixture = await createBrokerDevFixture({ entry: 'import { value } from "./dep"; globalThis.brokerProbe = value;', files: { 'src/features/privacy-fetch/dep.ts': 'export const value = "first-dependency";' } });
    await rm(path.join(fixture.root, 'src/features/privacy-fetch/dep.ts'));
    await vi.waitFor(async () => expect((await fixture.request()).status).toBe(503), poll);
    await fixture.write({ file: 'src/features/privacy-fetch/dep.ts', source: 'export const value = "restored-dependency";' });
    await vi.waitFor(async () => expect(await (await fixture.request()).text()).toContain('restored-dependency'), poll);
  }, 25_000);

  it('recovers when a newly imported missing dependency is created', async () => {
    await using fixture = await createBrokerDevFixture();
    await fixture.write({ file: 'src/features/privacy-fetch/broker-entry.ts', source: 'import { value } from "@/shared/new-dependency"; globalThis.brokerProbe = value;' });
    await vi.waitFor(async () => expect((await fixture.request()).status).toBe(503), poll);
    await fixture.write({ file: 'src/shared/new-dependency.ts', source: 'export const value = "newly-created-dependency";' });
    await vi.waitFor(async () => expect(await (await fixture.request()).text()).toContain('newly-created-dependency'), poll);
  }, 25_000);

  it('recovers after deleting and restoring the broker HTML', async () => {
    await using fixture = await createBrokerDevFixture();
    await rm(path.join(fixture.root, 'privacy-fetch-broker.html'));
    await vi.waitFor(async () => expect((await fixture.request()).status).toBe(503), poll);
    await fixture.write({ file: 'privacy-fetch-broker.html', source: fixture.html });
    await vi.waitFor(async () => expect((await fixture.request()).status).toBe(200), poll);
  }, 25_000);

  it.each([
    'globalThis.loadProbe = name => import(/* @vite-ignore */ name);',
    'import "https://example.invalid/external.js";',
    'globalThis.loadProbe = () => import("https://example.invalid/external.js");',
  ])('rejects unbundled runtime imports: %s', async entry => {
    await using fixture = await createBrokerDevFixture({ entry });
    expect((await fixture.request()).status).toBe(503);
  });

  it('preserves top-level await in an inlined lazy module', async () => {
    await using fixture = await createBrokerDevFixture({
      entry: 'globalThis.loadProbe = () => import("./async-lazy");',
      files: { 'src/features/privacy-fetch/async-lazy.ts': 'await Promise.resolve(); globalThis.lazyProbe = "async-result";' },
    });
    const response = await fixture.request();
    expect(response.status).toBe(200);
    const context = await evaluate({ source: await response.text() });
    expect(context.lazyProbe).toBeUndefined();
    await context.loadProbe();
    expect(context.lazyProbe).toBe('async-result');
  });

  it('never returns a partially rewritten bundle during concurrent reads', async () => {
    await using fixture = await createBrokerDevFixture();
    const previous = await (await fixture.request()).text();
    await fixture.write({ file: 'src/features/privacy-fetch/broker-entry.ts', source: 'globalThis.brokerProbe = "atomic-next";' });
    const responses: string[] = [];
    for (let index = 0; index < 15; index++) {
      const response = await fixture.request();
      expect(response.status).toBe(200);
      responses.push(await response.text());
    }
    await vi.waitFor(async () => expect(await (await fixture.request()).text()).toContain('atomic-next'), poll);
    const next = await (await fixture.request()).text();
    expect(responses.every(body => body === previous || body === next)).toBe(true);
    for (const body of new Set(responses)) {
      await expect(evaluate({ source: body })).resolves.toBeDefined();
    }
  }, 25_000);

  it('keeps ordinary application HMR updates working', async () => {
    await using fixture = await createBrokerDevFixture();
    await (await fixture.request({ file: 'app.ts' })).text();
    await fixture.write({ file: 'app.ts', source: 'export const value = "updated-app"; if (import.meta.hot) import.meta.hot.accept();' });
    await vi.waitFor(() => expect(fixture.send.mock.calls.some(([event]) => isHotMessage({ event, type: 'update' }))).toBe(true), poll);
    expect(await (await fixture.request()).text()).toContain('initial-broker');
    expect(fixture.send.mock.calls.some(([event]) => isHotMessage({ event, type: 'full-reload' }))).toBe(false);
  }, 25_000);

  it('replaces build subscriptions during server restarts and can rebuild again', async () => {
    await using fixture = await createBrokerDevFixture();
    for (let restart = 0; restart < 3; restart++) {
      await fixture.server.restart();
      // Node's pooled HTTP connection can still belong to the closed server.
      await vi.waitFor(async () => expect((await fixture.request()).status).toBe(200), poll);
    }
    const send = vi.spyOn(fixture.server.environments.client!.hot, 'send');
    await fixture.write({ file: 'src/features/privacy-fetch/broker-entry.ts', source: 'globalThis.brokerProbe = "after-restart";' });
    await vi.waitFor(async () => expect(await (await fixture.request()).text()).toContain('after-restart'), poll);
    expect(send.mock.calls.filter(([event]) => isHotMessage({ event, type: 'full-reload' }))).toHaveLength(1);
  }, 25_000);

  it('rebuilds with HMR disabled and closes subscriptions in middleware mode', async () => {
    await using fixture = await createBrokerDevFixture({ middlewareMode: true, hmr: false });
    expect(fixture.server.httpServer).toBeNull();
    expect((await fixture.request()).status).toBe(200);
    await fixture.write({ file: 'src/features/privacy-fetch/broker-entry.ts', source: 'globalThis.brokerProbe = "middleware-updated";' });
    await vi.waitFor(async () => expect(await (await fixture.request()).text()).toContain('middleware-updated'), poll);
    expect(fixture.send).not.toHaveBeenCalled();
    await fixture.server.close();
    expect(fixture.server.watcher.listenerCount('add')).toBe(0);
    expect(fixture.server.watcher.listenerCount('change')).toBe(0);
    expect((await fixture.request()).status).toBe(503);
  }, 25_000);

  it('recovers from a syntax error in a newly added dependency', async () => {
    await using fixture = await createBrokerDevFixture();
    await fixture.write({ file: 'src/new-dependency.ts', source: 'export const value: = ;' });
    await fixture.write({ file: 'src/features/privacy-fetch/broker-entry.ts', source: 'import { value } from "@/new-dependency"; globalThis.brokerProbe = value;' });
    await vi.waitFor(async () => expect((await fixture.request()).status).toBe(503), poll);
    await fixture.write({ file: 'src/new-dependency.ts', source: 'export const value = "new-dependency-repaired";' });
    await vi.waitFor(async () => expect(await (await fixture.request()).text()).toContain('new-dependency-repaired'), poll);
  }, 25_000);

  it('rebuilds when a new file adds a match to a previously empty glob', async () => {
    await using fixture = await createBrokerDevFixture({ entry: 'globalThis.loadProbes = import.meta.glob("../../optional/*.ts");' });
    const initial = await evaluate({ source: await (await fixture.request()).text() });
    expect(Object.keys(initial.loadProbes)).toEqual([]);
    await fixture.write({ file: 'src/optional/created.ts', source: 'export const value = "created-glob-module";' });
    await vi.waitFor(async () => expect(await (await fixture.request()).text()).toContain('created-glob-module'), poll);
    const updated = await evaluate({ source: await (await fixture.request()).text() });
    expect(Object.keys(updated.loadProbes)).toEqual(['../../optional/created.ts']);
    await expect(updated.loadProbes['../../optional/created.ts']()).resolves.toMatchObject({ value: 'created-glob-module' });
  }, 25_000);

  it('keeps the test-only boundary in the auxiliary build', async () => {
    await using fixture = await createBrokerDevFixture({ entry: 'import "./internal.test.ts";', files: { 'src/features/privacy-fetch/internal.test.ts': 'globalThis.brokerProbe = "must-not-ship";' } });
    expect((await fixture.request()).status).toBe(503);
    expect(await (await fixture.request()).text()).not.toContain('must-not-ship');
    await fixture.write({ file: 'src/features/privacy-fetch/broker-entry.ts', source: 'globalThis.brokerProbe = "valid-entry";' });
    await vi.waitFor(async () => expect(await (await fixture.request()).text()).toContain('valid-entry'), poll);
  }, 25_000);

  it('does not change production build output', async () => {
    await using fixture = await createBrokerDevFixture();
    const outputs: { name: string, code: string }[][] = [];
    for (const plugins of [[], [createPrivacyFetchBrokerDevPlugin()]]) {
      const result = await build({
        configFile: false,
        root: fixture.root,
        logLevel: 'silent',
        plugins,
        build: { write: false, minify: false, rolldownOptions: { input: path.join(fixture.root, 'app.ts'), preserveEntrySignatures: 'strict' } },
      });
      if (Array.isArray(result) || !('output' in result)) {
        throw new Error('Unexpected production build result');
      }
      outputs.push(result.output.map(output => {
        if (output.type !== 'chunk') {
          throw new Error('Unexpected non-JavaScript output');
        }
        return { name: output.fileName, code: output.code };
      }));
    }
    expect(outputs[0]).toEqual(outputs[1]);
    expect(outputs[0]?.[0]?.code).toContain('initial-app');
  });

  it('bundles the real broker and its shared/npm dependencies without exposing source paths', async () => {
    const server = await createServer({
      configFile: false,
      root: process.cwd(),
      logLevel: 'silent',
      resolve: { alias: { '@': path.resolve('src') } },
      define: { __BUILD_MODE_IS_HOSTED__: 'true', __BUILD_MODE_IS_STANDALONE__: 'false', __BUILD_MODE_IS_TEST__: 'false' },
      plugins: [createPrivacyFetchBrokerDevPlugin()],
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0 },
    });
    await using resource = { [Symbol.asyncDispose]: () => server.close() };
    void resource;
    await server.listen();
    const address = server.httpServer!.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Missing test address');
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${origin}/assets/privacy-fetch-broker/broker.js`, { headers: { Origin: 'null' } });
    expect(response.status).toBe(200);
    const code = await response.text();
    expect(code).toContain('naidan.privacy-fetch.v1');
    expect(code).not.toContain('/@vite/client');
    const dom = createBuildDom({ html: '<html><head></head><body></body></html>', options: undefined });
    using domResource = { [Symbol.dispose]: () => dom.window.close() };
    void domResource;
    const postMessage = vi.fn();
    const addEventListener = vi.fn();
    const context = vm.createContext({ document: dom.window.document, window: { parent: { postMessage }, addEventListener }, URL, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout });
    const module = new vm.SourceTextModule(code, { context });
    expect(module.dependencySpecifiers).toEqual([]);
    await module.link(specifier => {
      throw new Error(`Unexpected broker import: ${specifier}`);
    });
    await module.evaluate();
    expect(addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ protocol: 'naidan.privacy-fetch.v1', type: 'ready' }), '*', []);
    for (const file of ['/src/01-models/ids.ts', '/src/utils/worker-transport.ts']) {
      const source = await fetch(origin + file, { headers: { Origin: 'null' } });
      expect(source.headers.get('access-control-allow-origin')).toBeNull();
      await source.text();
    }
  }, 25_000);
});

describe('broker HTML contract', () => {
  it.each([
    '<script src="/src/features/privacy-fetch/broker-entry.ts"></script>',
    '<script type="module" src="/src/features/privacy-fetch/broker-entry.ts"></script><script>extra()</script>',
    '<html><title>missing</title></html>',
  ])('rejects unsupported templates: %s', source => {
    expect(() => TEST_ONLY.createBrokerHtml({ source, scriptUrl: '/assets/privacy-fetch-broker/broker.js' })).toThrow('exactly');
  });
});
