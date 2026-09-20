// @vitest-environment node
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrivacyFetchBrokerDevHeadersPlugin } from './privacy-fetch-broker-dev';

// Only Vite's development transform middleware runs here; no production build
// or application configuration (including artifact close hooks) is loaded.
describe('privacy broker runtime dependency headers', () => {
  let vite: ViteDevServer;
  const listener = createHttpServer();
  let base: string;
  beforeAll(async () => {
    vite = await createServer({
      configFile: false,
      root: process.cwd(),
      cacheDir: path.join(process.cwd(), 'node_modules/.vite-privacy-broker-test-cold'),
      logLevel: 'silent',
      plugins: [createPrivacyFetchBrokerDevHeadersPlugin()],
      resolve: { alias: { '@': path.join(process.cwd(), 'src') } },
      optimizeDeps: { noDiscovery: true, include: ['zod', 'comlink'] },
      server: { middlewareMode: true, hmr: false, watch: null },
    });
    listener.on('request', vite.middlewares);
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const address = listener.address();
    if (address === null || typeof address === 'string') throw new Error('Missing test server address');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    listener.closeAllConnections();
    if (listener.listening) await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await vite?.close();
  });

  it('allows the broker runtime graph including shared source and optimized Comlink dependencies', async () => {
    const pending = ['/src/features/privacy-fetch/broker-entry.ts'];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const url = pending.pop();
      if (url === undefined || visited.has(url)) continue;
      visited.add(url);
      const response = await fetch(base + url, { headers: { Origin: 'null' } });
      expect(response.status, url).toBe(200);
      expect(response.headers.get('access-control-allow-origin'), url).toBe('*');
      expect(response.headers.get('cross-origin-resource-policy'), url).toBe('cross-origin');
      const source = await response.text();
      // Optimized shared chunks can retain relative imports; follow those too.
      for (const match of source.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) {
        const specifier = match[1];
        if (specifier === undefined || !(specifier.startsWith('/') || specifier.startsWith('.'))) continue;
        const dependency = new URL(specifier, base + url);
        pending.push(dependency.pathname + dependency.search);
      }
    }
    expect(visited).toContain('/src/01-models/ids.ts');
    expect(visited).toContain('/src/utils/worker-transport.ts');
    expect([...visited].some(url => url.startsWith('/node_modules/.vite-privacy-broker-test-cold/deps/comlink.js'))).toBe(true);
    const response = await fetch(base + '/src/utils/worker-transport.ts?t=1000000000000', { headers: { Origin: 'null' } });
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const etag = response.headers.get('etag');
    await response.text();
    if (etag === null) throw new Error('Missing module ETag');
    const cached = await fetch(base + '/src/utils/worker-transport.ts', { headers: { Origin: 'null', 'If-None-Match': etag } });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('access-control-allow-origin')).toBe('*');
  }, 20_000);

  it('does not expose unrelated application source to an opaque origin', async () => {
    const response = await fetch(base + '/src/01-models/ui-locale.ts', { headers: { Origin: 'null' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    await response.text();
  });
});
