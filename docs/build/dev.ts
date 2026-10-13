import path from 'node:path';
import { createServer, isCSSRequest, mergeConfig } from 'vite';
import type { ViteDevServer, ModuleNode, InlineConfig, Plugin } from 'vite';
import { docsCompilerConfig } from './compiler';
import { resolveDocsRoute } from './routes';
import { findIslands, renderDocument, renderLocaleRoot, renderNotFound } from './html';
import { ISLAND_ENTRIES, styleEntryId } from './ids';
import type { DocsRenderer, RenderedPage } from './contracts';
import type { DocsLocale } from '../site/routes';
import { compileLocaleBootstrap } from './locale-bootstrap';
import { createDocsSitemap } from './seo';

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
  let bootstrap: Promise<string> | undefined;
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
          case 'bootstrap':
            bootstrap ??= compileLocaleBootstrap({ root: server.config.root }).catch(error => {
              bootstrap = undefined; throw error;
            });
            response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
            sendBody({ body: await bootstrap });
            return;
          case 'sitemap':
            response.setHeader('Content-Type', 'application/xml; charset=utf-8');
            sendBody({ body: createDocsSitemap() });
            return;
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
            const styles = await devStyles({ server, entry: styleEntryId({ page: 'index' }) });
            html = renderNotFound({ assets: { styles, scripts: ['/docs/@vite/client'] } });
            break;
          }
          case 'root': {
            const renderer = await server.ssrLoadModule('/server.ts') as DocsRenderer;
            const pages = {
              en: await renderer.renderPage({ locale: 'en', page: 'index' }),
              ja: await renderer.renderPage({ locale: 'ja', page: 'index' }),
            } satisfies Record<DocsLocale, RenderedPage>;
            const styles = await devStyles({ server, entry: styleEntryId({ page: 'index' }) });
            html = renderLocaleRoot({ pages, bootstrap: '/docs/__locale.js', assets: { styles, scripts: ['/docs/@vite/client'] } });
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
          const context = (() => {
            switch (route.kind) {
            case 'page': return `${route.locale}/${route.page}`;
            case 'bootstrap':
            case 'sitemap':
            case 'outside':
            case 'asset':
            case 'redirect':
            case 'invalid':
            case 'missing':
            case 'root': return route.kind;
            default: {
              const unreachable: never = route;
              throw new Error(`Unsupported Docs route: ${String(unreachable)}`);
            }
            }
          })();
          const causes: string[] = [];
          let current: unknown = error;
          while (current instanceof Error) {
            server.ssrFixStacktrace(current);
            causes.push(current.stack ?? current.message);
            current = current.cause;
          }
          if (current !== undefined) causes.push(String(current));
          server.config.logger.error(`[Docs ${context}] ${causes.join('\nCaused by: ')}`);
          response.statusCode = 500;
          sendBody({ body: `Docs ${context} failed; see the development console.` });
        }
      });
    },
    handleHotUpdate(context) {
      // A page includes build-time strings; reload the Docs document, not the app.
      // Keep Vite's affected modules so its SSR graph is invalidated as well.
      bootstrap = undefined;
      context.server.ws.send({ type: 'full-reload', path: '*' });
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
      hmr: parentServer.httpServer?.listening ? { server: parentServer.httpServer, path: '__hmr' } : false,
    },
  } satisfies InlineConfig));
}
