import path from 'node:path';
import { createServer, isCSSRequest, mergeConfig } from 'vite';
import type { ViteDevServer, ModuleNode, InlineConfig, Plugin } from 'vite';
import { docsCompilerConfig } from './compiler';
import { resolveDocsRoute } from './routes';
import { findIslands, renderDocument, renderLocaleRoot, renderNotFound } from './html';
import { ISLAND_ENTRIES, LOCALE_ENTRY, styleEntryId } from './ids';
import type { DocsRenderer } from './contracts';

function devHref({ moduleUrl }: { moduleUrl: string }): string {
  return moduleUrl.startsWith('/docs/') ? moduleUrl : `/docs${moduleUrl}`;
}

async function devStyles({ server, entry }: { server: ViteDevServer; entry: string }): Promise<string[]> {
  const visited = new Set<string>();
  const styles: string[] = [];
  const visit = async ({ url }: { url: string }): Promise<void> => {
    if (visited.has(url)) return;
    visited.add(url);
    if (isCSSRequest(url)) {
      const parsed = new URL(devHref({ moduleUrl: url }), 'http://naidan-docs.invalid');
      // Keep Vue's terminal lang.css query intact: Vite recognizes it as CSS.
      if (!parsed.searchParams.has('direct')) parsed.search = parsed.search ? `?direct&${parsed.search.slice(1)}` : '?direct';
      styles.push(parsed.pathname + parsed.search);
      return;
    }
    await server.transformRequest(url);
    const module: ModuleNode | undefined = await server.moduleGraph.getModuleByUrl(url);
    for (const imported of module?.importedModules ?? []) {
      if (imported.file && !path.relative(server.config.root, imported.file).startsWith('..')) {
        await visit({ url: imported.url });
      }
    }
  };
  await visit({ url: entry });
  return styles;
}

function createDocsRequestPlugin(): Plugin {
  return {
    name: 'naidan-docs-requests',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const route = resolveDocsRoute({ requestUrl: request.url ?? '/' });
        const method = request.method;
        if (method !== 'GET' && method !== 'HEAD') {
          response.statusCode = 405;
          response.setHeader('Allow', 'GET, HEAD');
          response.end(); return;
        }
        const sendBody = ({ body }: { body: string }): void => {
          switch (method) {
          case 'GET': response.end(body); return;
          case 'HEAD': response.end(); return;
          default: { const unreachable: never = method; throw new Error(`Unsupported method: ${unreachable}`); }
          }
        };
        response.setHeader('Cache-Control', 'no-store');
        try {
          let html: string;
          switch (route.kind) {
          case 'outside':
          case 'asset':
            return next();
          case 'redirect':
            response.statusCode = 308;
            response.setHeader('Location', route.location);
            response.end(); return;
          case 'invalid':
            response.statusCode = 400;
            sendBody({ body: 'Invalid Docs request' }); return;
          case 'missing': {
            response.statusCode = 404;
            const styles = await devStyles({ server, entry: `/${LOCALE_ENTRY}` });
            html = renderNotFound({ assets: { styles, scripts: ['/docs/@vite/client'] } });
            break;
          }
          case 'root': {
            const styles = await devStyles({ server, entry: `/${LOCALE_ENTRY}` });
            html = renderLocaleRoot({ assets: { styles, scripts: ['/docs/@vite/client', devHref({ moduleUrl: `/${LOCALE_ENTRY}` })] } });
            break;
          }
          case 'page': {
            const renderer = await server.ssrLoadModule('/server.ts') as DocsRenderer;
            const rendered = await renderer.renderPage({ locale: route.locale, page: route.page });
            const entry = styleEntryId({ page: route.page });
            const styles = await devStyles({ server, entry });
            const scripts = findIslands({ body: rendered.body }).map(name => devHref({ moduleUrl: `/${ISLAND_ENTRIES[name]}` }));
            html = renderDocument({ page: rendered, assets: { styles, scripts: ['/docs/@vite/client', ...scripts] } });
            break;
          }
          default: {
            const unreachable: never = route;
            throw new Error(`Unsupported Docs route: ${String(unreachable)}`);
          }
          }
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          sendBody({ body: html });
        } catch (error) {
          if (error instanceof Error) server.ssrFixStacktrace(error);
          server.config.logger.error(String(error));
          response.statusCode = 500;
          sendBody({ body: 'Docs rendering failed; see the development console.' });
        }
      });
    },
    handleHotUpdate(context) {
      // A page includes build-time strings; reload the Docs document, not the app.
      // Vite invalidates imported SSR modules before the next render.
      context.server.ws.send({ type: 'full-reload', path: '*' });
      return [];
    },
  };
}

export async function createDocsDevServer({ root, parentServer }: { root: string; parentServer: ViteDevServer }): Promise<ViteDevServer> {
  return createServer(mergeConfig(docsCompilerConfig({ root }), {
    configFile: false,
    cacheDir: path.resolve(root, '.cache/vite'),
    plugins: [createDocsRequestPlugin()],
    server: {
      middlewareMode: true,
      hmr: parentServer.httpServer ? { server: parentServer.httpServer, path: '__hmr' } : false,
    },
  } satisfies InlineConfig));
}
