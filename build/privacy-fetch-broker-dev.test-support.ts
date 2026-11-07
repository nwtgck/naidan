import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer as createHttpServer, type Server } from 'node:http';
import path from 'node:path';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import { vi } from 'vitest';
import { createPrivacyFetchBrokerDevPlugin } from './privacy-fetch-broker-dev';
import { createDevServerIsolationPlugin, DEV_SERVER_ISOLATION_HEADERS } from './dev-server-isolation';

const html = '<!doctype html><html><head><title>Privacy fetch broker</title></head><body><script type="module" src="/src/features/privacy-fetch/broker-entry.ts"></script></body></html>';

export async function createBrokerDevFixture({
  entry = 'globalThis.brokerProbe = "initial-broker";',
  files = {},
  base = '/',
  plugins = [],
  hmr = true,
  middlewareMode = false,
}: {
  entry?: string,
  files?: Record<string, string>,
  base?: string,
  plugins?: Plugin[],
  hmr?: boolean,
  middlewareMode?: boolean,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'naidan-privacy-dev-'));
  let server: ViteDevServer | undefined;
  let httpServer: Server | undefined;
  const resource = {
    async [Symbol.asyncDispose]() {
      await server?.close();
      if (httpServer !== undefined) {
        httpServer.closeAllConnections();
        await new Promise<void>((resolve, reject) => httpServer!.close(error => error ? reject(error) : resolve()));
      }
      await rm(root, { recursive: true, force: true });
    },
  };
  const write = async ({ file, source }: { file: string, source: string }) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  };
  try {
    for (const [file, source] of Object.entries({
      'privacy-fetch-broker.html': html,
      'index.html': '<!doctype html><script type="module" src="/app.ts"></script>',
      'app.ts': 'export const value = "initial-app"; if (import.meta.hot) import.meta.hot.accept();',
      'src/unrelated.ts': 'export const secret = "unrelated-source";',
      'src/features/privacy-fetch/broker-entry.ts': entry,
      ...files,
    })) {
      await write({ file, source });
    }
    server = await createServer({
      configFile: false,
      root,
      base,
      logLevel: 'silent',
      define: { __BROKER_PROBE__: JSON.stringify('shared-define') },
      plugins: [createDevServerIsolationPlugin(), createPrivacyFetchBrokerDevPlugin(), ...plugins],
      resolve: { alias: { '@': path.join(root, 'src') } },
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0, hmr, middlewareMode, headers: DEV_SERVER_ISOLATION_HEADERS },
    });
    if (middlewareMode) {
      httpServer = createHttpServer(server.middlewares);
      await new Promise<void>(resolve => httpServer!.listen(0, '127.0.0.1', resolve));
    } else {
      await server.listen();
    }
    const address = (httpServer ?? server.httpServer)?.address();
    if (address === null || address === undefined || typeof address === 'string') {
      throw new Error('Missing test server address');
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const send = vi.spyOn(server.environments.client!.hot, 'send');
    return {
      ...resource,
      root,
      server,
      send,
      write,
      html,
      request: ({ file = 'assets/privacy-fetch-broker/broker.js', method = 'GET', headers = {} }: { file?: string, method?: string, headers?: Record<string, string> } = {}) => fetch(origin + base + file, { method, headers: { Origin: 'null', ...headers } }),
    };
  } catch (error) {
    await resource[Symbol.asyncDispose]();
    throw error;
  }
}
