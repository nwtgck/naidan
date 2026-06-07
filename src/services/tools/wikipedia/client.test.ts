import { describe, expect, it, vi } from 'vitest';
import { getWikipediaPage, searchWikipedia } from './client';

function createJsonResponse({ body }: { body: unknown }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('searchWikipedia', () => {
  it('requests only the specified language', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      body: {
        query: {
          search: [{ ns: 0, title: 'Quantum computing', pageid: 25220 }],
        },
      },
    }));

    const result = await searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('https://en.wikipedia.org/w/api.php');
    expect(result).toEqual({
      groups: [{
        lang: 'en',
        items: [{ title: 'Quantum computing', pageId: 25220 }],
      }],
    });
  });

  it('requests routed languages when lang is omitted', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(createJsonResponse({
        body: { query: { search: [{ ns: 0, title: '量子コンピュータ', pageid: 100 }] } },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        body: { query: { search: [{ ns: 0, title: 'Quantum computing', pageid: 25220 }] } },
      }));

    const result = await searchWikipedia({
      lang: undefined,
      query: '量子コンピュータ',
      contextLanguage: undefined,
      signal: undefined,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('https://ja.wikipedia.org/w/api.php');
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain('https://en.wikipedia.org/w/api.php');
    expect(result.groups).toHaveLength(2);
  });

  it('includes srprop and srinfo parameters', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      body: { query: { search: [] } },
    }));

    await searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      fetchImpl,
    });

    const url = fetchImpl.mock.calls[0]?.[0] as URL;
    expect(url.searchParams.get('srprop')).toBe('');
    expect(url.searchParams.get('srinfo')).toBe('');
  });

  it('normalizes only title and pageid from the response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      body: {
        query: {
          search: [{
            ns: 0,
            title: 'Quantum computing',
            pageid: 25220,
            snippet: 'ignored',
            timestamp: 'ignored',
          }],
        },
      },
    }));

    const result = await searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      fetchImpl,
    });

    expect(result.groups[0]).toEqual({
      lang: 'en',
      items: [{ title: 'Quantum computing', pageId: 25220 }],
    });
  });

  it('ignores continue fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      body: {
        continue: { sroffset: 5, continue: '-||' },
        query: { search: [] },
      },
    }));

    const result = await searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      fetchImpl,
    });

    expect(result).toEqual({ groups: [{ lang: 'en', items: [] }] });
  });

  it('throws on invalid API response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      body: { query: { wrong: [] } },
    }));

    await expect(searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      fetchImpl,
    })).rejects.toThrow(/validation failed/i);
  });
});

describe('getWikipediaPage', () => {
  it('uses pageids and not titles', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      body: {
        query: {
          pages: [{ pageid: 25220, ns: 0, title: 'Quantum computing', extract: 'Intro' }],
        },
      },
    }));

    await getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      fetchImpl,
    });

    const url = fetchImpl.mock.calls[0]?.[0] as URL;
    expect(url.searchParams.get('pageids')).toBe('25220');
    expect(url.searchParams.has('titles')).toBe(false);
  });

  it('includes exintro and exchars settings', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      body: {
        query: {
          pages: [{ pageid: 25220, ns: 0, title: 'Quantum computing', extract: 'Intro' }],
        },
      },
    }));

    await getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      fetchImpl,
    });

    const url = fetchImpl.mock.calls[0]?.[0] as URL;
    expect(url.searchParams.get('exintro')).toBe('1');
    expect(url.searchParams.get('exchars')).toBe('800');
  });

  it('normalizes only pageid title and extract', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      body: {
        query: {
          pages: [{
            pageid: 25220,
            ns: 0,
            title: 'Quantum computing',
            extract: 'Intro text',
            canonicalurl: 'ignored',
          }],
        },
      },
    }));

    const result = await getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      fetchImpl,
    });

    expect(result).toEqual({
      lang: 'en',
      pageId: 25220,
      title: 'Quantum computing',
      content: 'Intro text',
    });
  });

  it('throws on invalid API response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      body: { query: { pages: [{ title: 'Missing pageid' }] } },
    }));

    await expect(getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      fetchImpl,
    })).rejects.toThrow(/validation failed/i);
  });

  it('throws when the page is not found', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      body: { query: { pages: [] } },
    }));

    await expect(getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      fetchImpl,
    })).rejects.toThrow(/not found/i);
  });
});
