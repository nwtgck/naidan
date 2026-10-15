import type { Plugin } from 'vite';
import { hfRepositories, type HfRepositoryEntry } from '../src/features/llama-cpp-browser/hugging-face/model-repositories';
import { SITE_METADATA } from '../src/logic/document-metadata';

function escapeXml({ value }: { value: string }): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function createSiteUrl({ hash }: { hash: string | undefined }): string {
  const url = new URL('/', SITE_METADATA.url);
  if (hash !== undefined) url.hash = hash;
  return url.href;
}

function createFragmentSitemap({ repositories }: { repositories: readonly HfRepositoryEntry[] }): string {
  const urls = [
    createSiteUrl({ hash: undefined }),
    createSiteUrl({ hash: '/image-generation' }),
    createSiteUrl({ hash: '/audio-generation' }),
    ...repositories.flatMap(entry => {
      const { hfRepository, sitemapQuantizations, ...unhandledEntry } = entry;
      unhandledEntry satisfies Record<PropertyKey, never>;
      const repositoryPath = hfRepository.split('/').map(segment => encodeURIComponent(segment)).join('/');
      return sitemapQuantizations.map(quantization => createSiteUrl({ hash: `/?llama-cpp-browser-model=hf.co/${repositoryPath}:${encodeURIComponent(quantization)}` }));
    }),
  ];
  return `\
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...new Set(urls)].map(url => `  <url><loc>${escapeXml({ value: url })}</loc></url>`).join('\n')}
</urlset>
`;
}

export function createFragmentSitemapPlugin(): Plugin {
  const sitemap = createFragmentSitemap({ repositories: hfRepositories });
  return {
    name: 'fragment-sitemap',
    apply(_config, { mode }) {
      return mode !== 'standalone';
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/sitemap.xml' || (req.method !== 'GET' && req.method !== 'HEAD')) {
          next();
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(sitemap));
        switch (req.method) {
        case 'GET':
          res.end(sitemap);
          return;
        case 'HEAD':
          res.end();
          return;
        default: {
          const _ex: never = req.method;
          throw new Error(`Unhandled method: ${_ex}`);
        }
        }
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemap });
    },
  };
}

export const TEST_ONLY = {
  createFragmentSitemap,
};
