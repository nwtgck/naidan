import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { PrivacyFetchResponse } from '@/services/privacy-fetch'
import {
  createRetryAfterRetryDecision,
  getRetryAfterHeaderValue,
  getWikipediaPage,
  parseRetryAfterMs,
  searchWikipedia,
  waitForRetryAfterDelay,
  WIKIPEDIA_API_MAX_RETRY_AFTER_RETRY_COUNT,
  WIKIPEDIA_SEARCH_LIMIT,
} from './client'
import { WIKIPEDIA_INLINE_CONTENT_MAX_LINES } from './binary-object'

const {
  mockPrivacyFetch,
  mockRunWikipediaApiRequest,
  mockSaveWikipediaPageTextAsBinaryObject,
} = vi.hoisted(() => ({
  mockPrivacyFetch: vi.fn(),
  mockRunWikipediaApiRequest: vi.fn(),
  mockSaveWikipediaPageTextAsBinaryObject: vi.fn(),
}))

vi.mock('@/services/privacy-fetch', async () => {
  const actual = await vi.importActual<typeof import('@/services/privacy-fetch')>('@/services/privacy-fetch')
  return {
    ...actual,
    privacyFetch: mockPrivacyFetch,
  }
})

vi.mock('./request-scheduler', async () => {
  const actual = await vi.importActual<typeof import('./request-scheduler')>('./request-scheduler')
  return {
    ...actual,
    runWikipediaApiRequest: mockRunWikipediaApiRequest,
  }
})

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

function createJsonArrayBuffer({
  value,
}: {
  value: unknown;
}): ArrayBuffer {
  const encoded = new TextEncoder().encode(JSON.stringify(value))
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  )
}

function createPrivacyFetchResponse({
  url,
  status,
  statusText,
  headers,
  json,
}: {
  url?: string;
  status: number;
  statusText: string;
  headers?: Array<[string, string]>;
  json: unknown;
}): PrivacyFetchResponse {
  const body = createJsonArrayBuffer({ value: json })
  return {
    url: url ?? 'https://en.wikipedia.org/w/api.php?origin=*',
    status,
    statusText,
    ok: status >= 200 && status <= 299,
    redirected: false,
    responseType: 'cors',
    headers: new Headers(headers),
    body,
    bodyByteLength: body.byteLength,
    policyName: 'wikipedia_api',
  }
}

describe('Retry-After helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('looks up Retry-After headers case-insensitively through Headers', () => {
    expect(getRetryAfterHeaderValue({
      response: createPrivacyFetchResponse({
        status: 429,
        statusText: 'Too Many Requests',
        headers: [['Retry-After', '5']],
        json: {},
      }),
    })).toBe('5')

    expect(getRetryAfterHeaderValue({
      response: createPrivacyFetchResponse({
        status: 429,
        statusText: 'Too Many Requests',
        headers: [['retry-after', '6']],
        json: {},
      }),
    })).toBe('6')

    expect(getRetryAfterHeaderValue({
      response: createPrivacyFetchResponse({
        status: 429,
        statusText: 'Too Many Requests',
        headers: [['RETRY-AFTER', '7']],
        json: {},
      }),
    })).toBe('7')
  })

  it('parses delay-seconds Retry-After values', () => {
    expect(parseRetryAfterMs({
      value: '0',
      nowMs: 0,
    })).toBe(0)
    expect(parseRetryAfterMs({
      value: '5',
      nowMs: 0,
    })).toBe(5000)
    expect(parseRetryAfterMs({
      value: '60',
      nowMs: 0,
    })).toBe(60000)
    expect(parseRetryAfterMs({
      value: '1.5',
      nowMs: 0,
    })).toBeUndefined()
    expect(parseRetryAfterMs({
      value: '-1',
      nowMs: 0,
    })).toBeUndefined()
    expect(parseRetryAfterMs({
      value: 'abc',
      nowMs: 0,
    })).toBeUndefined()
    expect(parseRetryAfterMs({
      value: '',
      nowMs: 0,
    })).toBeUndefined()
  })

  it('parses HTTP-date Retry-After values', () => {
    const nowMs = Date.UTC(2024, 0, 1, 0, 0, 0)
    expect(parseRetryAfterMs({
      value: 'Mon, 01 Jan 2024 00:00:05 GMT',
      nowMs,
    })).toBe(5000)
    expect(parseRetryAfterMs({
      value: 'Sun, 31 Dec 2023 23:59:59 GMT',
      nowMs,
    })).toBe(0)
    expect(parseRetryAfterMs({
      value: 'not-a-date',
      nowMs,
    })).toBeUndefined()
  })

  it('gives up when Retry-After is missing invalid too long or exhausted', () => {
    expect(createRetryAfterRetryDecision({
      response: createPrivacyFetchResponse({
        status: 429,
        statusText: 'Too Many Requests',
        json: {},
      }),
      retryCount: 0,
      nowMs: 0,
    })).toEqual({
      action: 'give_up',
      reason: 'missing_retry_after',
      retryAfterMs: undefined,
      retryAfterValue: undefined,
    })

    expect(createRetryAfterRetryDecision({
      response: createPrivacyFetchResponse({
        status: 503,
        statusText: 'Service Unavailable',
        headers: [['Retry-After', 'abc']],
        json: {},
      }),
      retryCount: 0,
      nowMs: 0,
    })).toEqual({
      action: 'give_up',
      reason: 'invalid_retry_after',
      retryAfterMs: undefined,
      retryAfterValue: 'abc',
    })

    expect(createRetryAfterRetryDecision({
      response: createPrivacyFetchResponse({
        status: 503,
        statusText: 'Service Unavailable',
        headers: [['Retry-After', '60']],
        json: {},
      }),
      retryCount: 0,
      nowMs: 0,
    })).toEqual({
      action: 'give_up',
      reason: 'retry_after_too_long',
      retryAfterMs: 60000,
      retryAfterValue: '60',
    })

    expect(createRetryAfterRetryDecision({
      response: createPrivacyFetchResponse({
        status: 429,
        statusText: 'Too Many Requests',
        headers: [['Retry-After', '0']],
        json: {},
      }),
      retryCount: WIKIPEDIA_API_MAX_RETRY_AFTER_RETRY_COUNT,
      nowMs: 0,
    })).toEqual({
      action: 'give_up',
      reason: 'retry_count_exhausted',
      retryAfterMs: 0,
      retryAfterValue: '0',
    })
  })

  it('aborts while waiting for Retry-After delays', async () => {
    vi.useFakeTimers()

    const controller = new AbortController()
    const waitPromise = waitForRetryAfterDelay({
      delayMs: 5000,
      signal: controller.signal,
    })
    controller.abort()

    await expect(waitPromise).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('searchWikipedia', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    mockRunWikipediaApiRequest.mockImplementation(async ({
      request,
    }: {
      request: () => Promise<unknown>;
    }) => request())
  })

  afterEach(() => {
    vi.useRealTimers()
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

  it('retries a 429 response when Retry-After is present and then succeeds', async () => {
    mockPrivacyFetch
      .mockResolvedValueOnce(createPrivacyFetchResponse({
        status: 429,
        statusText: 'Too Many Requests',
        headers: [['Retry-After', '0']],
        json: { error: 'rate limited' },
      }))
      .mockResolvedValueOnce(createPrivacyFetchResponse({
        status: 200,
        statusText: 'OK',
        json: {
          query: {
            search: [{ ns: 0, title: 'Quantum computing', pageid: 25220 }],
          },
        },
      }))

    const result = await searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    })

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(2)
    expect(mockRunWikipediaApiRequest).toHaveBeenCalledTimes(2)
    expect(result.groups).toEqual([{
      lang: 'en',
      items: [{ title: 'Quantum computing', pageId: 25220 }],
    }])
  })

  it('retries a 503 response when Retry-After is present and then succeeds', async () => {
    mockPrivacyFetch
      .mockResolvedValueOnce(createPrivacyFetchResponse({
        status: 503,
        statusText: 'Service Unavailable',
        headers: [['retry-after', '0']],
        json: { error: 'temporarily unavailable' },
      }))
      .mockResolvedValueOnce(createPrivacyFetchResponse({
        status: 200,
        statusText: 'OK',
        json: {
          query: {
            search: [{ ns: 0, title: 'Quantum computing', pageid: 25220 }],
          },
        },
      }))

    const result = await searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    })

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(2)
    expect(mockRunWikipediaApiRequest).toHaveBeenCalledTimes(2)
    expect(result.groups[0]?.items[0]).toEqual({
      title: 'Quantum computing',
      pageId: 25220,
    })
  })

  it('does not retry a 429 response without Retry-After', async () => {
    mockPrivacyFetch.mockResolvedValueOnce(createPrivacyFetchResponse({
      status: 429,
      statusText: 'Too Many Requests',
      json: { error: 'rate limited' },
    }))

    await expect(searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    })).rejects.toThrow(/HTTP 429.*No valid Retry-After/i)

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(1)
  })

  it('does not retry an invalid Retry-After value', async () => {
    mockPrivacyFetch.mockResolvedValueOnce(createPrivacyFetchResponse({
      status: 503,
      statusText: 'Service Unavailable',
      headers: [['RETRY-AFTER', 'abc']],
      json: { error: 'temporarily unavailable' },
    }))

    await expect(searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    })).rejects.toThrow(/HTTP 503.*Invalid Retry-After header: "abc"/i)

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(1)
  })

  it('does not retry when Retry-After exceeds the 30 second auto-retry limit', async () => {
    mockPrivacyFetch.mockResolvedValueOnce(createPrivacyFetchResponse({
      status: 503,
      statusText: 'Service Unavailable',
      headers: [['Retry-After', '60']],
      json: { error: 'temporarily unavailable' },
    }))

    await expect(searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    })).rejects.toThrow(/HTTP 503.*Retry-After: 60.*30 second auto-retry limit/i)

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(1)
  })

  it('gives up after the bounded Retry-After retry count is exhausted', async () => {
    mockPrivacyFetch
      .mockResolvedValueOnce(createPrivacyFetchResponse({
        status: 429,
        statusText: 'Too Many Requests',
        headers: [['Retry-After', '0']],
        json: { error: 'rate limited' },
      }))
      .mockResolvedValueOnce(createPrivacyFetchResponse({
        status: 429,
        statusText: 'Too Many Requests',
        headers: [['Retry-After', '0']],
        json: { error: 'rate limited again' },
      }))
      .mockResolvedValueOnce(createPrivacyFetchResponse({
        status: 429,
        statusText: 'Too Many Requests',
        headers: [['Retry-After', '0']],
        json: { error: 'still rate limited' },
      }))

    await expect(searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    })).rejects.toThrow(/HTTP 429.*Retried 2 times/i)

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(3)
    expect(mockRunWikipediaApiRequest).toHaveBeenCalledTimes(3)
  })

  it('aborts while waiting for the Retry-After delay', async () => {
    vi.useFakeTimers()

    mockPrivacyFetch.mockResolvedValueOnce(createPrivacyFetchResponse({
      status: 429,
      statusText: 'Too Many Requests',
      headers: [['Retry-After', '5']],
      json: { error: 'rate limited' },
    }))

    const controller = new AbortController()
    const searchPromise = searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: controller.signal,
      requestResponseImpl: undefined,
    })
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()

    await expect(searchPromise).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(mockPrivacyFetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not retry a 5xx response without Retry-After', async () => {
    mockPrivacyFetch.mockResolvedValueOnce(createPrivacyFetchResponse({
      status: 503,
      statusText: 'Service Unavailable',
      json: { error: 'temporarily unavailable' },
    }))

    await expect(searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    })).rejects.toThrow(/^Wikipedia request failed: Wikipedia API server error: HTTP 503/i)

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(1)
  })

  it('does not retry other HTTP errors', async () => {
    mockPrivacyFetch.mockResolvedValueOnce(createPrivacyFetchResponse({
      status: 403,
      statusText: 'Forbidden',
      json: { error: 'forbidden' },
    }))

    await expect(searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    })).rejects.toThrow(/HTTP 403 Forbidden/i)

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(1)
  })
})

describe('getWikipediaPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    mockRunWikipediaApiRequest.mockImplementation(async ({
      request,
    }: {
      request: () => Promise<unknown>;
    }) => request())
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
