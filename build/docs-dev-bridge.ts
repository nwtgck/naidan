import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

type DocsDevFactory = { createDocsDevServer: ({ root, parentServer }: { root: string; parentServer: ViteDevServer }) => Promise<ViteDevServer> };

// Keep the app config small: no Docs compilation, parsing or model initialization
// until a /docs request arrives. The child has its own Vue/CSS/plugin graph.
export function createDocsDevBridge(): Plugin {
  let pending: Promise<ViteDevServer> | undefined;
  let createDocsDevServer: DocsDevFactory['createDocsDevServer'] | undefined;
  let retirement: Promise<void> = Promise.resolve();
  let closing = false;
  let parent: ViteDevServer | undefined;
  const retire = (): void => {
    const previous = pending;
    pending = undefined;
    if (!previous) {
      return;
    }
    retirement = retirement.then(async () => {
      await (await previous).close();
    }).catch(error => {
      parent?.config.logger.error(`Docs dev restart failed: ${String(error)}`);
    });
  };
  return {
    name: 'naidan-docs-dev-bridge',
    apply: 'serve',
    configureServer(server) {
      parent = server;
      const docsRoot = path.resolve(server.config.root, 'docs');
      server.middlewares.use(async (request, response, next) => {
        let url: URL;
        try {
          url = new URL(request.url ?? '/', 'http://naidan-docs.invalid');
        } catch {
          return next();
        }
        if (url.pathname !== '/docs' && !url.pathname.startsWith('/docs/')) {
          return next();
        }
        if (closing) {
          response.statusCode = 503;
          response.end();
          return;
        }
        try {
          let docs: ViteDevServer;
          for (;;) {
            // Vite caches this import and invalidates it with every transitive
            // SSR dependency. Keep the child aligned with its parent helpers;
            // article edits only invalidate the child's separate render graph.
            const factory = await server.ssrLoadModule('/docs/build/dev.ts') as DocsDevFactory;
            if (closing) {
              response.statusCode = 503;
              response.end();
              return;
            }
            if (typeof factory.createDocsDevServer !== 'function') {
              throw new Error('Invalid Docs development module');
            }
            if (createDocsDevServer !== factory.createDocsDevServer) {
              retire();
              createDocsDevServer = factory.createDocsDevServer;
            }
            if (!pending) {
              const attempt: Promise<ViteDevServer> = retirement.then(async () => {
                return factory.createDocsDevServer({ root: docsRoot, parentServer: server });
              }).catch(error => {
                if (pending === attempt) {
                  pending = undefined;
                }
                throw error;
              });
              pending = attempt;
            }
            const current = pending;
            docs = await current;
            if (current === pending) {
              break;
            }
          }
          if (closing) {
            response.statusCode = 503;
            response.end();
            return;
          }
          docs.middlewares(request, response, (error: unknown) => {
            if (error) {
              return next(error);
            }
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
      retire();
      await retirement;
    },
  };
}
