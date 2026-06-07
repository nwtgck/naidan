import { describe, expect, it } from 'vitest';
import { renderWikipediaPageMarkdown, renderWikipediaSearchMarkdown } from './render';

describe('renderWikipediaSearchMarkdown', () => {
  it('renders lang once per group', () => {
    const result = renderWikipediaSearchMarkdown({
      groups: [{
        lang: 'en',
        items: [
          { title: 'Quantum computing', pageId: 25220 },
          { title: 'Quantum computer', pageId: 12345 },
        ],
      }],
    });

    expect(result).toContain('lang: en');
    expect(result.match(/lang: en/g)).toHaveLength(1);
  });

  it('does not repeat lang on each item', () => {
    const result = renderWikipediaSearchMarkdown({
      groups: [{
        lang: 'en',
        items: [{ title: 'Quantum computing', pageId: 25220 }],
      }],
    });

    expect(result).not.toContain('1. lang: en');
  });

  it('does not include url or snippet metadata', () => {
    const result = renderWikipediaSearchMarkdown({
      groups: [{
        lang: 'en',
        items: [{ title: 'Quantum computing', pageId: 25220 }],
      }],
    });

    expect(result).not.toContain('url');
    expect(result).not.toContain('snippet');
    expect(result).not.toContain('timestamp');
    expect(result).not.toContain('wordcount');
  });

  it('renders multiple language groups', () => {
    const result = renderWikipediaSearchMarkdown({
      groups: [
        {
          lang: 'en',
          items: [{ title: 'Quantum computing', pageId: 25220 }],
        },
        {
          lang: 'ja',
          items: [{ title: '量子コンピュータ', pageId: 54321 }],
        },
      ],
    });

    expect(result).toContain('lang: en');
    expect(result).toContain('lang: ja');
    expect(result).toContain('title: 量子コンピュータ');
  });

  it('renders empty groups as No results', () => {
    const result = renderWikipediaSearchMarkdown({
      groups: [{ lang: 'en', items: [] }],
    });

    expect(result).toContain('No results.');
  });
});

describe('renderWikipediaPageMarkdown', () => {
  it('renders page metadata and content markers', () => {
    const result = renderWikipediaPageMarkdown({
      page: {
        lang: 'en',
        pageId: 25220,
        title: 'Quantum computing',
        content: 'Quantum computing is a multidisciplinary field.',
      },
    });

    expect(result).toContain('lang: en');
    expect(result).toContain('pageId: 25220');
    expect(result).toContain('title: Quantum computing');
    expect(result).toContain('BEGIN CONTENT');
    expect(result).toContain('END CONTENT');
  });

  it('does not include unsupported metadata', () => {
    const result = renderWikipediaPageMarkdown({
      page: {
        lang: 'en',
        pageId: 25220,
        title: 'Quantum computing',
        content: 'Quantum computing is a multidisciplinary field.',
      },
    });

    expect(result).not.toContain('url');
    expect(result).not.toContain('wikidataId');
  });
});
