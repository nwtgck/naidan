import type { Plugin } from 'vite';
import type { ModelSeoEntry } from '../src/features/llama-cpp-browser/model-launch/seo-entries';
import { SITE_METADATA } from '../src/logic/document-metadata';

function escapeXml({ value }: { value: string }): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function createSiteSitemap({ entries }: { entries: readonly ModelSeoEntry[] }): string {
  const root = new URL('/', SITE_METADATA.url).href;
  // Image/audio routes are unchanged. Model pages alone gain path identities.
  const urls = [root, `${root}#/image-generation`, `${root}#/audio-generation`, ...entries.map(entry => entry.canonicalUrl)];
  return `\
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...new Set(urls)].map(url => `  <url><loc>${escapeXml({ value: url })}</loc></url>`).join('\n')}
</urlset>
`;
}

export function createSiteSitemapPlugin(): Plugin {
  return {
    name: 'site-sitemap',
    apply(_config, { mode }) {
      return mode !== 'standalone';
    },
    generateBundle() {
      // Published model HTML is added only after packaging, together with its
      // sitemap. A portable hosted ZIP must not advertise absent model pages.
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: createSiteSitemap({ entries: [] }) });
    },
  };
}

export const TEST_ONLY = {
};
