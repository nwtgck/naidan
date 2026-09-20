import path from 'node:path';
import { normalizePath, type Plugin, type ViteDevServer } from 'vite';

const BROKER_ENTRY = '/src/features/privacy-fetch/broker-entry.ts';

async function isBrokerModule({ server, url }: { server: ViteDevServer, url: string }): Promise<boolean> {
  const pathname = new URL(url, 'http://vite.invalid').pathname;
  // Preserve the broker's existing runtime namespaces, including optimized
  // dependency chunks and Vite's development module helpers.
  if (pathname.startsWith('/src/features/privacy-fetch/') || pathname.startsWith('/node_modules/')
      || pathname.startsWith('/@vite/') || pathname.startsWith('/@id/')) return true;

  // Import analysis registers runtime edges before the parent module is sent to
  // the browser. Follow those edges rather than opening all application source.
  const graph = server.environments.client?.moduleGraph;
  if (graph === undefined) return false;
  const entry = graph.getModuleById(normalizePath(path.join(server.config.root, BROKER_ENTRY)));
  if (entry === undefined) return false;
  const requested = await graph.getModuleByUrl(url);
  if (requested === undefined) return false;
  const pending = [entry];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current.url)) continue;
    visited.add(current.url);
    if (current === requested) return true;
    pending.push(...current.importedModules);
  }
  return false;
}

export function createPrivacyFetchBrokerDevHeadersPlugin(): Plugin {
  return {
    name: 'privacy-fetch-broker-dev-headers',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          next(); return;
        }
        const url = req.url ?? '';
        if (new URL(url, 'http://vite.invalid').pathname === '/privacy-fetch-broker.html') {
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        }
        void isBrokerModule({ server, url }).then(allowed => {
          if (allowed) {
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            res.setHeader('Access-Control-Allow-Origin', '*');
          }
          next();
        }).catch(next);
      });
    },
  };
}

export const TEST_ONLY = {};
