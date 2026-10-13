import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

// Keep the app config small: no Docs compilation, parsing or model initialization
// until a /docs request arrives. The child has its own Vue/CSS/plugin graph.
export function createDocsDevBridge(): Plugin {
  let pending: Promise<ViteDevServer> | undefined;
  let closing = false;
  return {
    name: 'naidan-docs-dev-bridge',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        let url: URL;
        try {
          url = new URL(request.url ?? '/', 'http://naidan-docs.invalid');
        } catch {
          return next();
        }
        if (url.pathname !== '/docs' && !url.pathname.startsWith('/docs/')) return next();
        if (closing) {
          response.statusCode = 503; response.end(); return;
        }
        try {
          pending ??= (async () => {
            const factory = await server.ssrLoadModule('/docs/build/dev.ts') as { createDocsDevServer: (args: { root: string; parentServer: ViteDevServer }) => Promise<ViteDevServer> };
            if (typeof factory.createDocsDevServer !== 'function') throw new Error('Invalid Docs development module');
            return factory.createDocsDevServer({ root: path.resolve(server.config.root, 'docs'), parentServer: server });
          })().catch(error => {
            pending = undefined; throw error;
          });
          const docs = await pending;
          if (closing) {
            response.statusCode = 503; response.end(); return;
          }
          docs.middlewares(request, response, (error: unknown) => {
            if (error) return next(error);
            response.statusCode = 404;
            response.end(request.method === 'HEAD' ? undefined : 'Docs resource not found');
          });
        } catch (error) {
          next(error);
        }
      });
    },
    async closeBundle() {
      closing = true;
      const current = pending;
      pending = undefined;
      if (current) {
        try {
          await (await current).close();
        } catch (error) {
          this.warn(`Docs dev shutdown: ${String(error)}`);
        }
      }
    },
  };
}
