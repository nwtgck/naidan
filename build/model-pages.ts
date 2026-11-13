import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { listModelPageEntries } from '../src/features/llama-cpp-browser/model-launch/page-entries.ts';
import { renderModelPageHtml, renderPublicAppHtml } from './model-page-html.ts';
import { createSiteSitemap } from './site-sitemap.ts';

/** Emit model pages with the app, before Workbox and release packaging run. */
export function createModelPagesPlugin(): Plugin {
  return {
    name: 'model-pages',
    apply(_config, { command, mode }) {
      return command === 'build' && mode === 'hosted';
    },
    enforce: 'post',
    configResolved(config) {
      // A root 404 disables Pages' static SPA fallback for unlisted models.
      if (config.publicDir && existsSync(path.join(config.publicDir, '404.html'))) {
        throw new Error('Hosted model pages require no root 404.html');
      }
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const template = bundle['index.html'];
        if (template === undefined) {
          throw new Error('Hosted model pages require the generated index.html asset');
        }
        switch (template.type) {
        case 'asset': break;
        case 'chunk': throw new Error('Hosted model pages require an HTML asset, not a chunk');
        default: {
          const exhaustive: never = template;
          throw new Error(`Unexpected HTML output: ${exhaustive}`);
        }
        }
        if (bundle['404.html'] !== undefined) {
          throw new Error('Hosted model pages require no root 404.html');
        }
        const html = typeof template.source === 'string' ? template.source : new TextDecoder().decode(template.source);
        const entries = listModelPageEntries();
        const pages = entries.map(entry => ({
          fileName: `${entry.pathname.slice(1)}index.html`,
          source: renderModelPageHtml({ html, entry }),
        }));
        pages.push({ fileName: 'sitemap.xml', source: createSiteSitemap({ entries }) });
        // Fail before mutating the bundle; never silently overwrite another page.
        for (const page of pages) {
          if (bundle[page.fileName] !== undefined) {
            throw new Error(`Conflicting model page output: ${page.fileName}`);
          }
        }
        template.source = renderPublicAppHtml({ html });
        for (const page of pages) {
          this.emitFile({ type: 'asset', ...page });
        }
      },
    },
  };
}

export const TEST_ONLY = {
};
