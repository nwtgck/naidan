import type { Plugin, ViteDevServer } from 'vite';

// SharedArrayBuffer and multi-threaded WebAssembly need cross-origin isolation.
// Keep the existing development/preview policy in one place. This does not
// configure the server that deploys production build output.
export const DEV_SERVER_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const;

export function createDevServerIsolationPlugin(): Plugin {
  function install({ middlewares }: { middlewares: ViteDevServer['middlewares'] }) {
    middlewares.use((req, res, next) => {
      // Vite's transformed-module and static-file 304 paths can return before
      // server.headers are applied. Preserve the policy without disabling cache.
      if (req.method === 'GET' || req.method === 'HEAD') {
        for (const [name, value] of Object.entries(DEV_SERVER_ISOLATION_HEADERS)) {
          res.setHeader(name, value);
        }
      }
      next();
    });
  }
  // Register in the normal hooks, before Vite's own response middleware. A
  // returned post hook would run after the early conditional-response paths.
  return {
    name: 'naidan-dev-server-isolation',
    configureServer: install,
    configurePreviewServer: install,
  };
}

export const TEST_ONLY = {};
