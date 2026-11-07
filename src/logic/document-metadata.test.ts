import { describe, expect, it } from 'vitest';
import { applyDocumentCanonicalUrl, applyDocumentMetadata, APPLICATION_METADATA, SITE_METADATA } from './document-metadata';

describe('central canonical URL ownership', () => {
  it('adopts and deduplicates URL tags separately from temporary document titles', () => {
    document.head.innerHTML = '<link rel="canonical" href="https://old.test/"><link rel="canonical" href="https://duplicate.test/"><meta property="og:url" content="old"><meta property="og:url" content="duplicate"><meta name="referrer" content="no-referrer">';
    const url = `${SITE_METADATA.url}/llama-cpp-browser/hf.co/owner/Model/`;
    applyDocumentCanonicalUrl({ document, canonicalUrl: url });
    applyDocumentCanonicalUrl({ document, canonicalUrl: url });
    applyDocumentMetadata({ document, page: APPLICATION_METADATA, documentTitle: 'Printing' });
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('meta[property="og:url"]')).toHaveLength(1);
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(url);
    expect(document.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(url);
    expect(document.title).toBe('Printing');
    expect(document.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
    applyDocumentCanonicalUrl({ document, canonicalUrl: SITE_METADATA.url });
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(SITE_METADATA.url);
  });
});
