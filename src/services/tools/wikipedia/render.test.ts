import { describe, expect, it } from 'vitest';
import { renderWikipediaPageMarkdown, renderWikipediaSearchMarkdown } from './render';

describe('renderWikipediaSearchMarkdown', () => {
  it('renders TSV with a header row', () => {
    const result = renderWikipediaSearchMarkdown({
      groups: [{
        lang: 'en',
        items: [
          { title: 'Quantum computing', pageId: 25220 },
          { title: 'Quantum computer', pageId: 12345 },
        ],
      }],
    });

    expect(result.split('\n')[0]).toBe('lang\tpageId\ttitle');
    expect(result).toContain('en\t25220\tQuantum computing');
    expect(result).toContain('en\t12345\tQuantum computer');
  });

  it('renders one TSV row per candidate', () => {
    const result = renderWikipediaSearchMarkdown({
      groups: [
        { lang: 'ja', items: [{ title: '量子コンピュータ', pageId: 894134 }] },
        { lang: 'en', items: [{ title: 'Quantum computing', pageId: 25220 }] },
      ],
    });

    expect(result).toContain('ja\t894134\t量子コンピュータ');
    expect(result).toContain('en\t25220\tQuantum computing');
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

  it('replaces tab and line breaks in titles with spaces', () => {
    const result = renderWikipediaSearchMarkdown({
      groups: [{
        lang: 'en',
        items: [{ title: 'Quantum\tcomputing\r\nnotes', pageId: 25220 }],
      }],
    });

    expect(result).toContain('en\t25220\tQuantum computing notes');
  });

  it('renders only the header when there are no results', () => {
    const result = renderWikipediaSearchMarkdown({
      groups: [{ lang: 'en', items: [] }],
    });

    expect(result).toBe('lang\tpageId\ttitle');
  });
});

describe('renderWikipediaPageMarkdown', () => {
  it('renders page metadata and content markers', () => {
    const result = renderWikipediaPageMarkdown({
      page: {
        kind: 'inline',
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
        kind: 'inline',
        lang: 'en',
        pageId: 25220,
        title: 'Quantum computing',
        content: 'Quantum computing is a multidisciplinary field.',
      },
    });

    expect(result).not.toContain('url');
    expect(result).not.toContain('wikidataId');
  });

  it('renders binary object references without inline content', () => {
    const result = renderWikipediaPageMarkdown({
      page: {
        kind: 'binary_object',
        lang: 'ja',
        pageId: 894134,
        title: '量子コンピュータ',
        lineCount: 1234,
        byteLength: 456789,
        sysfsNaidanDataFilePath: '/sys/fs/naidan/binary-objects/by-id/bin-1/data',
      },
    });

    expect(result).toContain('Wikipedia page text was saved to sysfs Naidan:');
    expect(result).toContain('/sys/fs/naidan/binary-objects/by-id/bin-1/data');
    expect(result).toContain('lines: 1234');
    expect(result).toContain('bytes: 456789');
    expect(result).toContain('Command hints for reducing context:');
    expect(result).toContain(`grep -nF -C 20 'keyword' <path>`);
    expect(result).toContain(`awk 'NR>80{exit}{print NR":"$0}' <path>`);
    expect(result).not.toContain('BEGIN CONTENT');
    expect(result).not.toContain('metadata.json');
    expect(result).not.toContain('metadata.md');
  });
});
