// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, createServer, normalizePath, preview, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';
import { createDevServerIsolationPlugin, DEV_SERVER_ISOLATION_HEADERS } from './dev-server-isolation';

// Vite injects /@vite/env, then its client alias rewrites that import to the
// installed env module's /@fs URL. Resolve the package, not a machine's path.
const viteEnvUrl = path.posix.join('/@fs/', normalizePath(fileURLToPath(new URL('../client/env.mjs', import.meta.resolve('vite')))));

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'naidan-dev-isolation-'));
  await mkdir(path.join(root, 'public'));
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'worker.ts'), 'import { value } from "./dependency"; export const result: number = value;');
  await writeFile(path.join(root, 'dependency.ts'), 'export const value: number = 7;');
  await writeFile(path.join(root, 'style.css'), 'body { color: red; }');
  await writeFile(path.join(root, 'public', 'plain.txt'), 'static fixture');
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>fixture</title>');
  await writeFile(path.join(root, 'dist', 'worker.js'), 'export const value = 7;');
  await writeFile(path.join(root, 'dist', 'index.html'), '<!doctype html><title>preview fixture</title>');
  return root;
}

// This normal downstream hook represents existing independent middleware.
// Its response headers and non-GET behavior must not be replaced by isolation.
function surroundingPlugin(): Plugin {
  const install = ({ middlewares }: { middlewares: ViteDevServer['middlewares'] }) => {
    middlewares.use((req, res, next) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('X-Fixture-Header', 'preserved');
      if (req.url === '/non-get') {
        res.statusCode = 202;
        res.end('unchanged');
        return;
      }
      if (req.url === '/custom-redirect') {
        res.statusCode = 302;
        res.setHeader('Location', '/dependency.ts');
        res.end();
        return;
      }
      if (req.url === '/custom-missing') {
        res.statusCode = 404;
        res.end('fixture not found');
        return;
      }
      next();
    });
  };
  return {
    name: 'fixture-surrounding-headers',
    configureServer: install,
    configurePreviewServer: install,
  };
}

async function assertConditionalResponse({ base, url, contentType, includes, excludes }: {
  base: string;
  url: string;
  contentType: string;
  includes: string[];
  excludes: string[];
}) {
  const response = await fetch(base + url);
  const body = await response.text();
  expect(response.status).toBe(200);
  expect(body.length).toBeGreaterThan(0);
  expect(response.headers.get('content-type')).toContain(contentType);
  for (const text of includes) expect(body).toContain(text);
  for (const text of excludes) expect(body).not.toContain(text);
  const etag = response.headers.get('etag');
  if (etag === null) throw new Error('Expected a real Vite ETag');
  for (const method of ['GET', 'HEAD']) {
    const repeated = await fetch(base + url, { method, headers: { 'If-None-Match': etag } });
    const repeatedBody = await repeated.text();
    expect(repeated.status).toBe(304);
    expect(repeatedBody).toBe('');
    for (const received of [response, repeated]) {
      expect.soft(received.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect.soft(received.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
      expect(received.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(received.headers.get('access-control-allow-origin')).toBe('https://fixture.invalid');
      expect(received.headers.get('x-fixture-header')).toBe('preserved');
    }
  }
  const head = await fetch(base + url, { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
  expect(head.headers.get('etag')).toBe(etag);
  expect(head.headers.get('content-type')).toBe(response.headers.get('content-type'));
  expect(head.headers.get('cache-control')).toBe(response.headers.get('cache-control'));
  expect(head.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  expect(head.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
}

async function assertCustomResponses({ base }: { base: string }) {
  const redirect = await fetch(base + '/custom-redirect', { redirect: 'manual' });
  expect(redirect.status).toBe(302);
  expect(redirect.headers.get('location')).toBe('/dependency.ts');
  expect(await redirect.text()).toBe('');
  const missing = await fetch(base + '/custom-missing');
  expect(missing.status).toBe(404);
  expect(await missing.text()).toBe('fixture not found');
  for (const response of [redirect, missing]) {
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('x-fixture-header')).toBe('preserved');
  }
}

async function assertResponseUnchanged({ actual, baseline }: { actual: Response; baseline: Response }) {
  expect(actual.status).toBe(200);
  expect(actual.status).toBe(baseline.status);
  expect(await actual.text()).toBe(await baseline.text());
  for (const header of ['etag', 'content-type', 'cache-control', 'cross-origin-resource-policy', 'access-control-allow-origin', 'x-fixture-header']) {
    expect(actual.headers.get(header)).toBe(baseline.headers.get(header));
  }
}

async function assertNonGet({ base }: { base: string }) {
  const post = await fetch(base + '/non-get', { method: 'POST' });
  expect(post.status).toBe(202);
  expect(await post.text()).toBe('unchanged');
  expect(post.headers.get('cross-origin-opener-policy')).toBeNull();
  expect(post.headers.get('cross-origin-embedder-policy')).toBeNull();
  expect(post.headers.get('x-fixture-header')).toBe('preserved');
  const options = await fetch(base + '/non-get', {
    method: 'OPTIONS',
    headers: { Origin: 'https://fixture.invalid', 'Access-Control-Request-Method': 'GET' },
  });
  expect(options.status).toBe(204);
  expect(options.headers.get('access-control-allow-origin')).toBe('https://fixture.invalid');
  expect(options.headers.get('cross-origin-opener-policy')).toBeNull();
  expect(options.headers.get('cross-origin-embedder-policy')).toBeNull();
}

describe('development isolation through real Vite middleware', () => {
  let root: string;
  let server: ViteDevServer | undefined;
  const http = createHttpServer();
  let base: string;
  beforeAll(async () => {
    root = await fixture();
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [createDevServerIsolationPlugin(), surroundingPlugin()],
      optimizeDeps: { noDiscovery: true },
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
        headers: DEV_SERVER_ISOLATION_HEADERS,
        cors: { origin: 'https://fixture.invalid' },
      },
    });
    http.on('request', server.middlewares);
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', resolve);
    });
    const address = http.address();
    if (address === null || typeof address === 'string') throw new Error('Missing fixture listener');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    try {
      http.closeAllConnections();
      if (http.listening) await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    } finally {
      try {
        await server?.close();
      } finally {
        if (root !== undefined) await rm(root, { recursive: true, force: true });
      }
    }
  });
  it.each([
    { url: '/worker.ts?worker_file&type=module', contentType: 'text/javascript', includes: [`import ${JSON.stringify(viteEnvUrl)}`, 'export const result = value'], excludes: [': number'] },
    { url: '/dependency.ts', contentType: 'text/javascript', includes: ['export const value = 7'], excludes: [': number'] },
    { url: '/@vite/env', contentType: 'text/javascript', includes: ['globalThis'], excludes: ['<!doctype html>'] },
    { url: '/plain.txt', contentType: 'text/plain', includes: ['static fixture'], excludes: [] },
    { url: '/style.css?direct', contentType: 'text/css', includes: ['color: red'], excludes: [] },
    { url: '/index.html', contentType: 'text/html', includes: ['<title>fixture</title>'], excludes: [] },
  ])('preserves policy on 200 and conditional GET/HEAD 304: $url', async fixture => {
    await assertConditionalResponse({ base, ...fixture });
  });
  it('does not change non-GET responses or CORS preflight', async () => {
    await assertNonGet({ base });
  });
  it('preserves custom redirect and missing responses', async () => {
    await assertCustomResponses({ base });
  });
  it('covers the send 304 path after a timestamp bypasses the module URL cache', async () => {
    const initial = await fetch(base + '/dependency.ts');
    await initial.text();
    const etag = initial.headers.get('etag');
    if (etag === null) throw new Error('Expected a module ETag');
    expect(server?.environments.client?.moduleGraph.getModuleByEtag(etag)?.url).toBe('/dependency.ts');
    // Vite removes only 13-digit timestamps. The raw request misses the cached
    // URL equality gate, then normalizes to the original module in send().
    const conditional = await fetch(base + '/dependency.ts?t=1000000000000', { headers: { 'If-None-Match': etag } });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe('');
    expect(conditional.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(conditional.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
  });
  it('keeps real 200 module bytes and cache headers identical to the unmodified server', async () => {
    const baseline = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [surroundingPlugin()],
      optimizeDeps: { noDiscovery: true },
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
        headers: DEV_SERVER_ISOLATION_HEADERS,
        cors: { origin: 'https://fixture.invalid' },
      },
    });
    const listener = createHttpServer(baseline.middlewares);
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
      });
      const address = listener.address();
      if (address === null || typeof address === 'string') throw new Error('Missing baseline listener');
      await assertResponseUnchanged({
        actual: await fetch(base + '/dependency.ts'),
        baseline: await fetch(`http://127.0.0.1:${address.port}/dependency.ts`),
      });
    } finally {
      try {
        listener.closeAllConnections();
        if (listener.listening) await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
      } finally {
        await baseline.close();
      }
    }
  });
});

describe('preview isolation through the real Vite preview server', () => {
  let root: string;
  let server: PreviewServer | undefined;
  let base: string;
  beforeAll(async () => {
    root = await fixture();
    server = await preview({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [createDevServerIsolationPlugin(), surroundingPlugin()],
      preview: {
        host: '127.0.0.1',
        port: 0,
        headers: DEV_SERVER_ISOLATION_HEADERS,
        cors: { origin: 'https://fixture.invalid' },
      },
    });
    const address = server.httpServer.address();
    if (address === null || typeof address === 'string') throw new Error('Missing preview listener');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    try {
      if (server !== undefined && 'closeAllConnections' in server.httpServer) {
        server.httpServer.closeAllConnections();
      }
    } finally {
      try {
        await server?.close();
      } finally {
        if (root !== undefined) await rm(root, { recursive: true, force: true });
      }
    }
  });
  it.each([
    { url: '/worker.js', contentType: 'text/javascript', includes: ['export const value = 7'], excludes: [] },
    { url: '/index.html', contentType: 'text/html', includes: ['<title>preview fixture</title>'], excludes: [] },
  ])('preserves policy on static 200 and conditional GET/HEAD 304: $url', async fixture => {
    await assertConditionalResponse({ base, ...fixture });
  });
  it('does not change non-GET responses or CORS preflight', async () => {
    await assertNonGet({ base });
  });
  it('preserves custom redirect and missing responses', async () => {
    await assertCustomResponses({ base });
  });
  it('keeps real 200 static bytes and cache headers identical to the unmodified preview', async () => {
    const baseline = await preview({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [surroundingPlugin()],
      preview: {
        host: '127.0.0.1',
        port: 0,
        headers: DEV_SERVER_ISOLATION_HEADERS,
        cors: { origin: 'https://fixture.invalid' },
      },
    });
    try {
      const address = baseline.httpServer.address();
      if (address === null || typeof address === 'string') throw new Error('Missing baseline preview listener');
      await assertResponseUnchanged({
        actual: await fetch(base + '/worker.js'),
        baseline: await fetch(`http://127.0.0.1:${address.port}/worker.js`),
      });
    } finally {
      try {
        if ('closeAllConnections' in baseline.httpServer) {
          baseline.httpServer.closeAllConnections();
        }
      } finally {
        await baseline.close();
      }
    }
  });
});

it('does not change production bundle output', async () => {
  const root = await fixture();
  try {
    const outputs: string[][] = [];
    const configurations: Array<{ root: string; outDir: string; pluginNames: string[] }> = [];
    for (const plugins of [[], [createDevServerIsolationPlugin()]]) {
      const result = await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [...plugins, {
          name: 'fixture-build-observation',
          configResolved(config) {
            configurations.push({
              root: config.root,
              outDir: config.build.outDir,
              pluginNames: config.plugins.map(plugin => plugin.name),
            });
          },
        }],
        build: {
          write: false,
          lib: { entry: path.join(root, 'dependency.ts'), formats: ['es'], fileName: 'fixture' },
        },
      });
      if ('close' in result) throw new Error('Unexpected build watcher');
      outputs.push((Array.isArray(result) ? result : [result]).flatMap(item => item.output.map(file => JSON.stringify(file))));
    }
    expect(outputs[1]).toEqual(outputs[0]);
    expect(configurations).toHaveLength(2);
    for (const config of configurations) {
      expect(config.root).toBe(root);
      expect(config.outDir).toBe('dist');
      expect(config.pluginNames.some(name => /gzip|copy-zip|tailwind|vue|transformers-js-fixes/u.test(name))).toBe(false);
    }
    expect(configurations[0]!.pluginNames).not.toContain('naidan-dev-server-isolation');
    expect(configurations[1]!.pluginNames).toContain('naidan-dev-server-isolation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
