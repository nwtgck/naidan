import type { ModelPageEntry } from '../src/features/llama-cpp-browser/model-launch/page-entries';
import { SITE_METADATA } from '../src/logic/document-metadata';

function escapeXml({ value }: { value: string }): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function createSiteSitemap({ entries }: { entries: readonly ModelPageEntry[] }): string {
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

export const TEST_ONLY = {
};
