import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getWikipediaPage, searchWikipedia, WIKIPEDIA_SEARCH_LIMIT } from './client'
import { WIKIPEDIA_INLINE_CONTENT_MAX_LINES } from './binary-object'

const { mockSaveWikipediaPageTextAsBinaryObject } = vi.hoisted(() => ({
  mockSaveWikipediaPageTextAsBinaryObject: vi.fn(),
}))

vi.mock('./binary-object', async () => {
  const actual = await vi.importActual<typeof import('./binary-object')>('./binary-object')
  return {
    ...actual,
    saveWikipediaPageTextAsBinaryObject: mockSaveWikipediaPageTextAsBinaryObject,
  }
})

function createRequestResponseImpl({
  impl,
}: {
  impl: (url: URL) => unknown;
}) {
  return vi.fn().mockImplementation(async ({
    url,
  }: {
    url: URL;
  }) => impl(url))
}

describe('searchWikipedia', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requests only the specified language', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({
        query: {
          search: [{ ns: 0, title: 'Quantum computing', pageid: 25220 }],
        },
      }),
    })

    const result = await searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl,
    })

    expect(requestResponseImpl).toHaveBeenCalledTimes(1)
    expect(String(requestResponseImpl.mock.calls[0]?.[0]?.url)).toContain('https://en.wikipedia.org/w/api.php')
    expect(result).toEqual({
      groups: [{
        lang: 'en',
        items: [{ title: 'Quantum computing', pageId: 25220 }],
      }],
    })
  })

  it('requests routed languages when lang is omitted', async () => {
    const requestResponseImpl = vi.fn()
      .mockResolvedValueOnce({ query: { search: [{ ns: 0, title: '量子コンピュータ', pageid: 100 }] } })
      .mockResolvedValueOnce({ query: { search: [{ ns: 0, title: 'Quantum computing', pageid: 25220 }] } })

    const result = await searchWikipedia({
      lang: undefined,
      query: '量子コンピュータ',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl,
    })

    expect(requestResponseImpl).toHaveBeenCalledTimes(2)
    expect(String(requestResponseImpl.mock.calls[0]?.[0]?.url)).toContain('https://ja.wikipedia.org/w/api.php')
    expect(String(requestResponseImpl.mock.calls[1]?.[0]?.url)).toContain('https://en.wikipedia.org/w/api.php')
    expect(result.groups).toHaveLength(2)
  })

  it('includes srprop and srinfo parameters', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({ query: { search: [] } }),
    })

    await searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl,
    })

    const url = requestResponseImpl.mock.calls[0]?.[0]?.url as URL
    expect(url.searchParams.get('srprop')).toBe('')
    expect(url.searchParams.get('srinfo')).toBe('')
    expect(url.searchParams.get('srlimit')).toBe(String(WIKIPEDIA_SEARCH_LIMIT))
  })

  it('normalizes only title and pageid from the response', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({
        query: {
          search: [{
            ns: 0,
            title: 'Quantum computing',
            pageid: 25220,
            snippet: 'ignored',
            timestamp: 'ignored',
          }],
        },
      }),
    })

    const result = await searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl,
    })

    expect(result.groups[0]).toEqual({
      lang: 'en',
      items: [{ title: 'Quantum computing', pageId: 25220 }],
    })
  })

  it('ignores continue fields', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({
        continue: { sroffset: 5, continue: '-||' },
        query: { search: [] },
      }),
    })

    const result = await searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl,
    })

    expect(result).toEqual({ groups: [{ lang: 'en', items: [] }] })
  })

  it('throws on invalid API response', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({ query: { wrong: [] } }),
    })

    await expect(searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl,
    })).rejects.toThrow(/validation failed/i)
  })
})

describe('getWikipediaPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses pageids and not titles', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({
        query: {
          pages: [{ pageid: 25220, ns: 0, title: 'Quantum computing', extract: 'Intro' }],
        },
      }),
    })

    await getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      requestResponseImpl,
    })

    const url = requestResponseImpl.mock.calls[0]?.[0]?.url as URL
    expect(url.searchParams.get('pageids')).toBe('25220')
    expect(url.searchParams.has('titles')).toBe(false)
  })

  it('requests plain-text extracts without intro or char limits', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({
        query: {
          pages: [{ pageid: 25220, ns: 0, title: 'Quantum computing', extract: 'Intro' }],
        },
      }),
    })

    await getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      requestResponseImpl,
    })

    const url = requestResponseImpl.mock.calls[0]?.[0]?.url as URL
    expect(url.searchParams.get('prop')).toBe('extracts')
    expect(url.searchParams.get('explaintext')).toBe('1')
    expect(url.searchParams.get('exsectionformat')).toBe('plain')
    expect(url.searchParams.get('pageids')).toBe('25220')
    expect(url.searchParams.has('exintro')).toBe(false)
    expect(url.searchParams.has('exchars')).toBe(false)
  })

  it('normalizes only pageid title and extract', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({
        query: {
          pages: [{
            pageid: 25220,
            ns: 0,
            title: 'Quantum computing',
            extract: 'Intro text',
            canonicalurl: 'ignored',
          }],
        },
      }),
    })

    const result = await getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      requestResponseImpl,
    })

    expect(result).toEqual({
      kind: 'inline',
      lang: 'en',
      pageId: 25220,
      title: 'Quantum computing',
      content: 'Intro text',
    })
  })

  it('returns inline content when the line count is within the threshold', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({
        query: {
          pages: [{
            pageid: 25220,
            ns: 0,
            title: 'Quantum computing',
            extract: `\
Line 1
Line 2`,
          }],
        },
      }),
    })

    const result = await getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      requestResponseImpl,
    })

    expect(result).toEqual({
      kind: 'inline',
      lang: 'en',
      pageId: 25220,
      title: 'Quantum computing',
      content: `\
Line 1
Line 2`,
    })
    expect(mockSaveWikipediaPageTextAsBinaryObject).not.toHaveBeenCalled()
  })

  it('saves long pages as binary objects instead of returning inline content', async () => {
    mockSaveWikipediaPageTextAsBinaryObject.mockResolvedValue({
      lineCount: WIKIPEDIA_INLINE_CONTENT_MAX_LINES + 1,
      byteLength: 4096,
      sysfsNaidanDataFilePath: '/sys/fs/naidan/binary-objects/by-id/bin-1/data',
    })
    const extract = `${'line\n'.repeat(WIKIPEDIA_INLINE_CONTENT_MAX_LINES)}overflow`
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({
        query: {
          pages: [{
            pageid: 25220,
            ns: 0,
            title: 'Quantum computing',
            extract,
          }],
        },
      }),
    })

    const result = await getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      requestResponseImpl,
    })

    expect(mockSaveWikipediaPageTextAsBinaryObject).toHaveBeenCalledWith({
      lang: 'en',
      pageId: 25220,
      title: 'Quantum computing',
      content: extract,
      lineCount: WIKIPEDIA_INLINE_CONTENT_MAX_LINES + 1,
    })
    expect(result).toEqual({
      kind: 'binary_object',
      lang: 'en',
      pageId: 25220,
      title: 'Quantum computing',
      lineCount: WIKIPEDIA_INLINE_CONTENT_MAX_LINES + 1,
      byteLength: 4096,
      sysfsNaidanDataFilePath: '/sys/fs/naidan/binary-objects/by-id/bin-1/data',
    })
  })

  it('throws on invalid API response', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({ query: { pages: [{ title: 'Missing pageid' }] } }),
    })

    await expect(getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      requestResponseImpl,
    })).rejects.toThrow(/validation failed/i)
  })

  it('throws when the page is not found', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({ query: { pages: [] } }),
    })

    await expect(getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      requestResponseImpl,
    })).rejects.toThrow(/not found/i)
  })
})
