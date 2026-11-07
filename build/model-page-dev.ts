import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';
import type { ModelPageEntry } from '../src/features/llama-cpp-browser/model-launch/page-entries';
import { MODEL_PAGE_PREFIX, modelIdFromPagePath } from '../src/features/llama-cpp-browser/model-launch/page-url';
import { renderModelPageHtml, renderPublicAppHtml } from './model-page-html';
import { createSiteSitemap } from './site-sitemap';

const entriesModule = '/src/features/llama-cpp-browser/model-launch/page-entries.ts';

export function createModelPageDevPlugin(): Plugin {
  return {
    name: 'model-page-dev',
    apply(_config, { command, mode }) {
      return command === 'serve' && mode !== 'standalone';
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://naidan.invalid');
        if ((req.method !== 'GET' && req.method !== 'HEAD')
          || (url.pathname !== '/sitemap.xml' && url.pathname !== MODEL_PAGE_PREFIX.slice(0, -1) && !url.pathname.startsWith(MODEL_PAGE_PREFIX))) {
          next();
          return;
        }
        try {
          // Load through Vite, not Node's config cache. Registry changes then
          // invalidate the same module graph used by the browser application.
          const source = await server.ssrLoadModule(entriesModule) as { listModelPageEntries: () => readonly ModelPageEntry[] };
          const entries = source.listModelPageEntries();
          let body: string;
          if (url.pathname === '/sitemap.xml') {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/xml; charset=utf-8');
            body = createSiteSitemap({ entries });
          } else {
            const modelId = modelIdFromPagePath({ pathname: url.pathname });
            const entry = entries.find(candidate => candidate.modelId === modelId);
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            if (entry !== undefined && entry.pathname !== url.pathname) {
              res.statusCode = 308;
              res.setHeader('Location', `${entry.pathname}${url.search}`);
              body = '';
            } else {
              const template = await readFile(path.join(server.config.root, 'index.html'), 'utf8');
              const html = await server.transformIndexHtml('/index.html', template);
              // Publication membership determines only the initial HTML, not
              // whether the app may open this repository. Invalid inputs use
              // the same client-side repair UI as production's SPA fallback.
              body = entry === undefined ? renderPublicAppHtml({ html }) : renderModelPageHtml({ html, entry });
              res.statusCode = 200;
            }
          }
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Length', Buffer.byteLength(body));
          switch (req.method) {
          case 'GET': res.end(body);
            break;
          case 'HEAD': res.end();
            break;
          default: {
            const exhaustive: never = req.method;
            throw new Error(`Unhandled model page method: ${exhaustive}`);
          }
          }
        } catch (error) {
          next(error);
        }
      });
    },
    handleHotUpdate({ file, server, modules }) {
      const relative = path.relative(server.config.root, file).split(path.sep).join('/');
      if (relative === 'src/features/llama-cpp-browser/hugging-face/model-repositories.ts'
        || relative.startsWith('src/features/llama-cpp-browser/model-launch/page-')
        || relative === 'src/features/llama-cpp-browser/model-launch/document-metadata.ts'
        || relative === 'src/logic/document-metadata.ts') {
        for (const module of modules) {
          server.moduleGraph.invalidateModule(module);
        }
        server.ws.send({ type: 'full-reload' });
        return [];
      }
      return undefined;
    },
  };
}

export const TEST_ONLY = {
};
