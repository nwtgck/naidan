import path from 'node:path';
import { createServer, isCSSRequest, mergeConfig } from 'vite';
import type { ViteDevServer, ModuleNode, InlineConfig, Plugin } from 'vite';
import { docsCompilerConfig } from './compiler';
import { resolveDocsRoute } from './routes';
import { findIslands, hasAppEntryLinks, hasHomeBrand, renderDocument, renderLocaleRoot, renderNotFound } from './html';
import { APP_ENTRY_CLIENT, HOME_BRAND_CLIENT, islandDevHref, styleEntryId } from './ids';
import type { DocsRenderer, RenderedPage } from './contracts';
import type { DocsLocale } from '../navigation/routes';
import { compileLocaleBootstrap } from './locale-bootstrap';
import { createDocsSitemap } from './seo';
import { createSearchIndex } from './search';
import { DOCS_PAGES, docsHref } from '../navigation/routes';
import { publicAssetHref } from './assets';

const favicon = publicAssetHref({ file: 'assets/favicon.svg' });

function escapeHtml({ value }: { value: string }): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function renderDevError({ context, details }: { context: string; details: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Docs development error</title>
<style>body{box-sizing:border-box;min-height:100vh;margin:0;padding:2rem;background:#16181d;color:#f1f3f5;font:1rem/1.5 system-ui,sans-serif}main{max-width:70rem;margin:auto}h1{font-size:1.5rem}pre{overflow:auto;padding:1rem;border:1px solid #58606b;border-radius:.5rem;background:#22262d;color:#f8d7da;white-space:pre-wrap;overflow-wrap:anywhere}</style>
<script type="module" src="/docs/@vite/client"></script></head>
<body><main><h1>Docs development error</h1><p>Docs ${escapeHtml({ value: context })} failed. Fix the source, then reload this page.</p>
<pre>${escapeHtml({ value: details })}</pre></main></body></html>`;
}

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
          case 'search-index': {
            const renderer = await server.ssrLoadModule('/server.ts') as DocsRenderer;
            const pages = new Map<string, RenderedPage>();
            for (const page of DOCS_PAGES) {
              pages.set(docsHref({ locale: route.locale, page: page.id }), await renderer.renderPage({ locale: route.locale, page: page.id }));
            }
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            sendBody({ body: JSON.stringify(createSearchIndex({ locale: route.locale, pages })) });
            return;
          }
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
            const styles = await devStyles({ server, entry: '/styles/site.css' });
            html = renderNotFound({ assets: { styles, scripts: ['/docs/@vite/client'], favicon }, bootstrap: '/docs/__locale.js' });
            break;
          }
          case 'root': {
            const renderer = await server.ssrLoadModule('/server.ts') as DocsRenderer;
            const pages = {
              en: await renderer.renderPage({ locale: 'en', page: 'index' }),
              ja: await renderer.renderPage({ locale: 'ja', page: 'index' }),
            } satisfies Record<DocsLocale, RenderedPage>;
            const styles = await devStyles({ server, entry: styleEntryId({ page: 'index' }) });
            const appEntryStyles = await devStyles({ server, entry: `/${APP_ENTRY_CLIENT}` });
            html = renderLocaleRoot({ pages, bootstrap: '/docs/__locale.js', assets: { styles: [...styles, ...appEntryStyles], scripts: ['/docs/@vite/client', devHref({ moduleUrl: islandDevHref({ id: 'search' }) }), devHref({ moduleUrl: `/${HOME_BRAND_CLIENT}` }), devHref({ moduleUrl: `/${APP_ENTRY_CLIENT}` })], favicon } });
            break;
          }
          case 'page': {
            const renderer = await server.ssrLoadModule('/server.ts') as DocsRenderer;
            const rendered = await renderer.renderPage({ locale: route.locale, page: route.page });
            const entry = styleEntryId({ page: route.page });
            const styles = await devStyles({ server, entry });
            const scripts = findIslands({ body: rendered.body }).map(id => devHref({ moduleUrl: islandDevHref({ id }) }));
            if (hasHomeBrand({ body: rendered.body })) scripts.push(devHref({ moduleUrl: `/${HOME_BRAND_CLIENT}` }));
            if (hasAppEntryLinks({ body: rendered.body })) scripts.push(devHref({ moduleUrl: `/${APP_ENTRY_CLIENT}` }));
            html = renderDocument({ page: rendered, assets: { styles, scripts: ['/docs/@vite/client', ...scripts], favicon }, bootstrap: '/docs/__locale.js' });
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
            case 'search-index':
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
          const details = causes.join('\nCaused by: ');
          server.config.logger.error(`[Docs ${context}] ${details}`);
          response.statusCode = 500;
          if (route.kind === 'page' || route.kind === 'root' || route.kind === 'missing') {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            sendBody({ body: renderDevError({ context, details }) });
          } else {
            response.setHeader('Content-Type', 'text/plain; charset=utf-8');
            sendBody({ body: `Docs ${context} failed; see the development console.` });
          }
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
  const parentHttpServer = parentServer.httpServer?.listening ? parentServer.httpServer : undefined;
  return createServer(mergeConfig(docsCompilerConfig({ root }), {
    configFile: false,
    cacheDir: path.resolve(root, '.cache/vite'),
    plugins: [createDocsRequestPlugin()],
    server: {
      middlewareMode: true,
      hmr: Boolean(parentHttpServer),
      ws: parentHttpServer ? { server: parentHttpServer, path: '__hmr' } : false,
    },
  } satisfies InlineConfig));
}
