import { JSDOM } from 'jsdom';
import type { Plugin } from 'vite';
import { HOME_METADATA, SITE_METADATA, applyDocumentMetadata } from '../src/logic/document-metadata';

const metadataMarker = '<!-- naidan-document-metadata -->';

export function createDocumentMetadataHtml(): string {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  try {
    const document = dom.window.document;
    applyDocumentMetadata({ document, page: HOME_METADATA, documentTitle: HOME_METADATA.title });
    for (const { attribute, key, content } of [
      { attribute: 'property', key: 'og:url', content: SITE_METADATA.url },
      { attribute: 'property', key: 'og:type', content: 'website' },
      { attribute: 'property', key: 'og:image', content: SITE_METADATA.image },
      { attribute: 'name', key: 'twitter:card', content: 'summary' },
      { attribute: 'name', key: 'twitter:image', content: SITE_METADATA.image },
    ]) {
      const meta = document.createElement('meta');
      meta.setAttribute(attribute, key);
      meta.content = content;
      document.head.append(meta);
    }
    const canonical = document.createElement('link');
    canonical.rel = 'canonical';
    canonical.href = SITE_METADATA.url;
    document.head.append(canonical);
    const schema = document.createElement('script');
    schema.type = 'application/ld+json';
    schema.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: SITE_METADATA.name,
      url: SITE_METADATA.url,
      description: SITE_METADATA.description,
      applicationCategory: 'UtilitiesApplication',
      operatingSystem: 'Any',
    });
    document.head.append(schema);
    return document.head.innerHTML;
  } finally {
    dom.window.close();
  }
}

export function createDocumentMetadataHtmlPlugin(): Plugin {
  return {
    name: 'document-metadata-html',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!html.includes(metadataMarker)) {
          return undefined;
        }
        return html.replace(metadataMarker, () => createDocumentMetadataHtml());
      },
    },
  };
}
