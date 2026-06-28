import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { PrivacyFetchResponse } from '@/features/privacy-fetch';
import { createPrivacyFetchError } from '@/features/privacy-fetch/errors';
import {
  createRetryAfterRetryDecision,
  createWikipediaFetchFailureRetryDecision,
  getRetryAfterHeaderValue,
  getWikipediaPage,
  parseRetryAfterMs,
  searchWikipedia,
  waitForRetryAfterDelay,
  WIKIPEDIA_API_CORS_HIDDEN_RATE_LIMIT_RETRY_DELAYS_MS,
  WIKIPEDIA_API_MAX_RETRY_AFTER_RETRY_COUNT,
  WIKIPEDIA_SEARCH_LIMIT,
} from './client';
import { WIKIPEDIA_INLINE_CONTENT_MAX_LINES } from './binary-object';
import {
  TEST_ONLY_resetWikipediaApiRequestScheduler,
} from './request-scheduler';

const {
  mockPrivacyFetch,
  mockSaveWikipediaPageTextAsBinaryObject,
} = vi.hoisted(() => ({
  mockPrivacyFetch: vi.fn(),
  mockSaveWikipediaPageTextAsBinaryObject: vi.fn(),
}));

vi.mock('@/features/privacy-fetch', async () => {
  const actual = await vi.importActual<typeof import('@/features/privacy-fetch')>('@/features/privacy-fetch');
  return {
    ...actual,
    privacyFetch: mockPrivacyFetch,
  };
});

vi.mock('./binary-object', async () => {
  const actual = await vi.importActual<typeof import('./binary-object')>('./binary-object');
  return {
    ...actual,
    saveWikipediaPageTextAsBinaryObject: mockSaveWikipediaPageTextAsBinaryObject,
  };
});

function createRequestResponseImpl({
  impl,
}: {
  impl: (url: URL) => unknown,
}) {
  return vi.fn().mockImplementation(async ({
    url,
  }: {
    url: URL,
  }) => impl(url));
}

function createJsonArrayBuffer({
  value,
}: {
  value: unknown,
}): ArrayBuffer {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  );
}

function createPrivacyFetchResponse({
  url,
  status,
  statusText,
  headers,
  json,
}: {
  url?: string,
  status: number,
  statusText: string,
  headers?: Array<[string, string]>,
  json: unknown,
}): PrivacyFetchResponse {
  const body = createJsonArrayBuffer({ value: json });
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
  };
}

describe('Retry-After helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TEST_ONLY_resetWikipediaApiRequestScheduler({
      _testOnly: undefined,
    });
  });

  afterEach(() => {
    TEST_ONLY_resetWikipediaApiRequestScheduler({
      _testOnly: undefined,
    });
    vi.useRealTimers();
  });

  it('looks up Retry-After headers case-insensitively through Headers', () => {
    expect(getRetryAfterHeaderValue({
      response: createPrivacyFetchResponse({
        status: 429,
        statusText: 'Too Many Requests',
        headers: [['Retry-After', '5']],
        json: {},
      }),
    })).toBe('5');

    expect(getRetryAfterHeaderValue({
      response: createPrivacyFetchResponse({
        status: 429,
        statusText: 'Too Many Requests',
        headers: [['retry-after', '6']],
        json: {},
      }),
    })).toBe('6');

    expect(getRetryAfterHeaderValue({
      response: createPrivacyFetchResponse({
        status: 429,
        statusText: 'Too Many Requests',
        headers: [['RETRY-AFTER', '7']],
        json: {},
      }),
    })).toBe('7');
  });

  it('parses delay-seconds Retry-After values', () => {
    expect(parseRetryAfterMs({
      value: '0',
      nowMs: 0,
    })).toBe(0);
    expect(parseRetryAfterMs({
      value: '5',
      nowMs: 0,
    })).toBe(5000);
    expect(parseRetryAfterMs({
      value: '60',
      nowMs: 0,
    })).toBe(60000);
    expect(parseRetryAfterMs({
      value: '1.5',
      nowMs: 0,
    })).toBeUndefined();
    expect(parseRetryAfterMs({
      value: '-1',
      nowMs: 0,
    })).toBeUndefined();
    expect(parseRetryAfterMs({
      value: 'abc',
      nowMs: 0,
    })).toBeUndefined();
    expect(parseRetryAfterMs({
      value: '',
      nowMs: 0,
    })).toBeUndefined();
  });

  it('parses HTTP-date Retry-After values', () => {
    const nowMs = Date.UTC(2024, 0, 1, 0, 0, 0);
    expect(parseRetryAfterMs({
      value: 'Mon, 01 Jan 2024 00:00:05 GMT',
      nowMs,
    })).toBe(5000);
    expect(parseRetryAfterMs({
      value: 'Sun, 31 Dec 2023 23:59:59 GMT',
      nowMs,
    })).toBe(0);
    expect(parseRetryAfterMs({
      value: 'not-a-date',
      nowMs,
    })).toBeUndefined();
  });

  it('uses visible 429 fallback or gives up when Retry-After is not retryable', () => {
    expect(createRetryAfterRetryDecision({
      fallbackRetryCount: 0,
      response: createPrivacyFetchResponse({
        status: 429,
        statusText: 'Too Many Requests',
        json: {},
      }),
      retryCount: 0,
      nowMs: 0,
    })).toEqual({
      action: 'retry',
      delayMs: WIKIPEDIA_API_CORS_HIDDEN_RATE_LIMIT_RETRY_DELAYS_MS[0],
      delaySource: 'fallback_429',
      retryAfterMs: 0,
      retryAfterValue: undefined,
    });

    expect(createRetryAfterRetryDecision({
      fallbackRetryCount: 0,
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
    });

    expect(createRetryAfterRetryDecision({
      fallbackRetryCount: 0,
      response: createPrivacyFetchResponse({
        status: 429,
        statusText: 'Too Many Requests',
        headers: [['Retry-After', 'abc']],
        json: {},
      }),
      retryCount: 0,
      nowMs: 0,
    })).toEqual({
      action: 'retry',
      delayMs: WIKIPEDIA_API_CORS_HIDDEN_RATE_LIMIT_RETRY_DELAYS_MS[0],
      delaySource: 'fallback_429',
      retryAfterMs: 0,
      retryAfterValue: 'abc',
    });

    expect(createRetryAfterRetryDecision({
      fallbackRetryCount: 0,
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
    });

    expect(createRetryAfterRetryDecision({
      fallbackRetryCount: 0,
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
    });

    expect(createRetryAfterRetryDecision({
      fallbackRetryCount: WIKIPEDIA_API_CORS_HIDDEN_RATE_LIMIT_RETRY_DELAYS_MS.length,
      response: createPrivacyFetchResponse({
        status: 429,
        statusText: 'Too Many Requests',
        json: {},
      }),
      retryCount: 0,
      nowMs: 0,
    })).toEqual({
      action: 'give_up',
      reason: 'fallback_429_retry_count_exhausted',
      retryAfterMs: undefined,
      retryAfterValue: undefined,
    });
  });

  it('creates fetch failure retry decisions for fetch_failed and non-retryable errors', () => {
    expect(createWikipediaFetchFailureRetryDecision({
      error: createPrivacyFetchError({
        code: 'fetch_failed',
        message: 'NetworkError',
      }),
      retryCount: 0,
    })).toEqual({
      action: 'retry',
      delayMs: WIKIPEDIA_API_CORS_HIDDEN_RATE_LIMIT_RETRY_DELAYS_MS[0],
      delaySource: 'cors_hidden_rate_limit_fallback',
    });

    expect(createWikipediaFetchFailureRetryDecision({
      error: createPrivacyFetchError({
        code: 'fetch_failed',
        message: 'NetworkError',
      }),
      retryCount: WIKIPEDIA_API_CORS_HIDDEN_RATE_LIMIT_RETRY_DELAYS_MS.length,
    })).toEqual({
      action: 'give_up',
      reason: 'cors_hidden_rate_limit_retry_count_exhausted',
    });

    expect(createWikipediaFetchFailureRetryDecision({
      error: createPrivacyFetchError({
        code: 'rejected',
        message: 'Rejected',
      }),
      retryCount: 0,
    })).toEqual({
      action: 'give_up',
      reason: 'non_retryable_fetch_error',
    });
  });

  it('aborts while waiting for Retry-After delays', async () => {
    vi.useFakeTimers();

    const controller = new AbortController();
    const waitPromise = waitForRetryAfterDelay({
      delayMs: 5000,
      signal: controller.signal,
    });
    controller.abort();

    await expect(waitPromise).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('searchWikipedia', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    TEST_ONLY_resetWikipediaApiRequestScheduler({
      _testOnly: undefined,
    });
  });

  afterEach(() => {
    TEST_ONLY_resetWikipediaApiRequestScheduler({
      _testOnly: undefined,
    });
    vi.useRealTimers();
  });

  it('requests only the specified language', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({
        query: {
          search: [{ ns: 0, title: 'Quantum computing', pageid: 25220 }],
        },
      }),
    });

    const result = await searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl,
    });

    expect(requestResponseImpl).toHaveBeenCalledTimes(1);
    expect(String(requestResponseImpl.mock.calls[0]?.[0]?.url)).toContain('https://en.wikipedia.org/w/api.php');
    expect(result).toEqual({
      groups: [{
        lang: 'en',
        items: [{ title: 'Quantum computing', pageId: 25220 }],
      }],
    });
  });

  it('requests routed languages when lang is omitted', async () => {
    const requestResponseImpl = vi.fn()
      .mockResolvedValueOnce({ query: { search: [{ ns: 0, title: '量子コンピュータ', pageid: 100 }] } })
      .mockResolvedValueOnce({ query: { search: [{ ns: 0, title: 'Quantum computing', pageid: 25220 }] } });

    const result = await searchWikipedia({
      lang: undefined,
      query: '量子コンピュータ',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl,
    });

    expect(requestResponseImpl).toHaveBeenCalledTimes(2);
    expect(String(requestResponseImpl.mock.calls[0]?.[0]?.url)).toContain('https://ja.wikipedia.org/w/api.php');
    expect(String(requestResponseImpl.mock.calls[1]?.[0]?.url)).toContain('https://en.wikipedia.org/w/api.php');
    expect(result.groups).toHaveLength(2);
  });

  it('includes srprop and srinfo parameters', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({ query: { search: [] } }),
    });

    await searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl,
    });

    const url = requestResponseImpl.mock.calls[0]?.[0]?.url as URL;
    expect(url.searchParams.get('srprop')).toBe('');
    expect(url.searchParams.get('srinfo')).toBe('');
    expect(url.searchParams.get('srlimit')).toBe(String(WIKIPEDIA_SEARCH_LIMIT));
  });

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
    });

    const result = await searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl,
    });

    expect(result.groups[0]).toEqual({
      lang: 'en',
      items: [{ title: 'Quantum computing', pageId: 25220 }],
    });
  });

  it('ignores continue fields', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({
        continue: { sroffset: 5, continue: '-||' },
        query: { search: [] },
      }),
    });

    const result = await searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl,
    });

    expect(result).toEqual({ groups: [{ lang: 'en', items: [] }] });
  });

  it('throws on invalid API response', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({ query: { wrong: [] } }),
    });

    await expect(searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl,
    })).rejects.toThrow(/validation failed/i);
  });

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
      }));

    const result = await searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    });

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(2);
    expect(result.groups).toEqual([{
      lang: 'en',
      items: [{ title: 'Quantum computing', pageId: 25220 }],
    }]);
  });

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
      }));

    const result = await searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    });

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(2);
    expect(result.groups[0]?.items[0]).toEqual({
      title: 'Quantum computing',
      pageId: 25220,
    });
  });

  it('retries a visible 429 response without Retry-After and then succeeds', async () => {
    vi.useFakeTimers();

    mockPrivacyFetch
      .mockResolvedValueOnce(createPrivacyFetchResponse({
        status: 429,
        statusText: 'Too Many Requests',
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
      }));

    const resultPromise = searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(mockPrivacyFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(WIKIPEDIA_API_CORS_HIDDEN_RATE_LIMIT_RETRY_DELAYS_MS[0]);

    await expect(resultPromise).resolves.toEqual({
      groups: [{
        lang: 'en',
        items: [{ title: 'Quantum computing', pageId: 25220 }],
      }],
    });

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 response with an invalid Retry-After value and then succeeds', async () => {
    vi.useFakeTimers();

    mockPrivacyFetch
      .mockResolvedValueOnce(createPrivacyFetchResponse({
        status: 429,
        statusText: 'Too Many Requests',
        headers: [['RETRY-AFTER', 'abc']],
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
      }));

    const resultPromise = searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(mockPrivacyFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(WIKIPEDIA_API_CORS_HIDDEN_RATE_LIMIT_RETRY_DELAYS_MS[0]);

    await expect(resultPromise).resolves.toEqual({
      groups: [{
        lang: 'en',
        items: [{ title: 'Quantum computing', pageId: 25220 }],
      }],
    });

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry an invalid Retry-After value for non-429 responses', async () => {
    mockPrivacyFetch.mockResolvedValueOnce(createPrivacyFetchResponse({
      status: 503,
      statusText: 'Service Unavailable',
      headers: [['RETRY-AFTER', 'abc']],
      json: { error: 'temporarily unavailable' },
    }));

    await expect(searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    })).rejects.toThrow(/HTTP 503.*Invalid Retry-After header: "abc"/i);

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry when Retry-After exceeds the 30 second auto-retry limit', async () => {
    mockPrivacyFetch.mockResolvedValueOnce(createPrivacyFetchResponse({
      status: 503,
      statusText: 'Service Unavailable',
      headers: [['Retry-After', '60']],
      json: { error: 'temporarily unavailable' },
    }));

    await expect(searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    })).rejects.toThrow(/HTTP 503.*Retry-After: 60.*30 second auto-retry limit/i);

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(1);
  });

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
      }));

    await expect(searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    })).rejects.toThrow(/HTTP 429.*Retried 2 times/i);

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(3);
  });

  it('aborts while waiting for the Retry-After delay', async () => {
    vi.useFakeTimers();

    mockPrivacyFetch.mockResolvedValueOnce(createPrivacyFetchResponse({
      status: 429,
      statusText: 'Too Many Requests',
      headers: [['Retry-After', '5']],
      json: { error: 'rate limited' },
    }));

    const controller = new AbortController();
    const searchPromise = searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: controller.signal,
      requestResponseImpl: undefined,
    });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    await expect(searchPromise).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(mockPrivacyFetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry a 5xx response without Retry-After', async () => {
    mockPrivacyFetch.mockResolvedValueOnce(createPrivacyFetchResponse({
      status: 503,
      statusText: 'Service Unavailable',
      json: { error: 'temporarily unavailable' },
    }));

    await expect(searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    })).rejects.toThrow(/^Wikipedia request failed: Wikipedia API server error: HTTP 503/i);

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(1);
  });

  it('retries a fetch_failed privacy fetch as a CORS-hidden rate limit candidate and then succeeds', async () => {
    vi.useFakeTimers();

    mockPrivacyFetch
      .mockRejectedValueOnce(createPrivacyFetchError({
        code: 'fetch_failed',
        message: 'NetworkError when attempting to fetch resource.',
      }))
      .mockResolvedValueOnce(createPrivacyFetchResponse({
        status: 200,
        statusText: 'OK',
        json: {
          query: {
            search: [{ ns: 0, title: 'Quantum computing', pageid: 25220 }],
          },
        },
      }));

    const resultPromise = searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(mockPrivacyFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(WIKIPEDIA_API_CORS_HIDDEN_RATE_LIMIT_RETRY_DELAYS_MS[0]);

    await expect(resultPromise).resolves.toEqual({
      groups: [{
        lang: 'en',
        items: [{ title: 'Quantum computing', pageId: 25220 }],
      }],
    });

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps other logical calls blocked while fetch_failed fallback wait is in progress', async () => {
    vi.useFakeTimers();

    mockPrivacyFetch
      .mockRejectedValueOnce(createPrivacyFetchError({
        code: 'fetch_failed',
        message: 'NetworkError when attempting to fetch resource.',
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
      .mockResolvedValueOnce(createPrivacyFetchResponse({
        status: 200,
        statusText: 'OK',
        json: {
          query: {
            search: [{ ns: 0, title: 'Quantum information', pageid: 123456 }],
          },
        },
      }));

    const firstPromise = searchWikipedia({
      lang: 'en',
      query: 'alpha',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    });
    await Promise.resolve();
    await Promise.resolve();

    const secondPromise = searchWikipedia({
      lang: 'en',
      query: 'beta',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(WIKIPEDIA_API_CORS_HIDDEN_RATE_LIMIT_RETRY_DELAYS_MS[0]);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(2);
    await expect(firstPromise).resolves.toEqual({
      groups: [{
        lang: 'en',
        items: [{
          title: 'Quantum computing',
          pageId: 25220,
        }],
      }],
    });

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(3);
    await expect(secondPromise).resolves.toEqual({
      groups: [{
        lang: 'en',
        items: [{
          title: 'Quantum information',
          pageId: 123456,
        }],
      }],
    });
  });

  it('gives up after bounded fetch_failed retries are exhausted', async () => {
    vi.useFakeTimers();

    mockPrivacyFetch.mockRejectedValue(createPrivacyFetchError({
      code: 'fetch_failed',
      message: 'NetworkError when attempting to fetch resource.',
    }));

    const resultPromise = searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    });
    void resultPromise.catch(() => undefined);

    for (const delayMs of WIKIPEDIA_API_CORS_HIDDEN_RATE_LIMIT_RETRY_DELAYS_MS) {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(delayMs);
    }

    await expect(resultPromise).rejects.toThrow(/CORS-hidden.*Access-Control-Allow-Origin.*Retried 4 times.*2s, 4s, 8s, and 16s/i);
    expect(mockPrivacyFetch).toHaveBeenCalledTimes(
      WIKIPEDIA_API_CORS_HIDDEN_RATE_LIMIT_RETRY_DELAYS_MS.length + 1,
    );
  });

  it('does not retry aborted privacy fetch failures', async () => {
    mockPrivacyFetch.mockRejectedValueOnce(createPrivacyFetchError({
      code: 'aborted',
      message: 'Privacy fetch was aborted',
    }));

    await expect(searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    })).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry rejected privacy fetch failures', async () => {
    mockPrivacyFetch.mockRejectedValueOnce(createPrivacyFetchError({
      code: 'rejected',
      message: 'Privacy fetch rejected [invalid_hostname]: Unsupported hostname',
    }));

    await expect(searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    })).rejects.toThrow(/privacy fetch failure that is not retried automatically/i);

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry other HTTP errors', async () => {
    mockPrivacyFetch.mockResolvedValueOnce(createPrivacyFetchResponse({
      status: 403,
      statusText: 'Forbidden',
      json: { error: 'forbidden' },
    }));

    await expect(searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    })).rejects.toThrow(/HTTP 403 Forbidden/i);

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps other logical calls blocked while Retry-After wait is in progress', async () => {
    vi.useFakeTimers();

    mockPrivacyFetch
      .mockResolvedValueOnce(createPrivacyFetchResponse({
        status: 429,
        statusText: 'Too Many Requests',
        headers: [['Retry-After', '5']],
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
      .mockResolvedValueOnce(createPrivacyFetchResponse({
        status: 200,
        statusText: 'OK',
        json: {
          query: {
            search: [{ ns: 0, title: 'Quantum information', pageid: 123456 }],
          },
        },
      }));

    const firstPromise = searchWikipedia({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    });
    await Promise.resolve();
    await Promise.resolve();

    const secondPromise = searchWikipedia({
      lang: 'en',
      query: 'quantum information',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPrivacyFetch).toHaveBeenCalledTimes(2);

    const firstResult = await firstPromise;
    expect(firstResult.groups[0]?.items[0]).toEqual({
      title: 'Quantum computing',
      pageId: 25220,
    });

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPrivacyFetch).toHaveBeenCalledTimes(3);
    await expect(secondPromise).resolves.toEqual({
      groups: [{
        lang: 'en',
        items: [{
          title: 'Quantum information',
          pageId: 123456,
        }],
      }],
    });
  });
});

describe('getWikipediaPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    TEST_ONLY_resetWikipediaApiRequestScheduler({
      _testOnly: undefined,
    });
  });

  afterEach(() => {
    TEST_ONLY_resetWikipediaApiRequestScheduler({
      _testOnly: undefined,
    });
  });

  it('uses pageids and not titles', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({
        query: {
          pages: [{ pageid: 25220, ns: 0, title: 'Quantum computing', extract: 'Intro' }],
        },
      }),
    });

    await getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      requestResponseImpl,
    });

    const url = requestResponseImpl.mock.calls[0]?.[0]?.url as URL;
    expect(url.searchParams.get('pageids')).toBe('25220');
    expect(url.searchParams.has('titles')).toBe(false);
  });

  it('requests plain-text extracts without intro or char limits', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({
        query: {
          pages: [{ pageid: 25220, ns: 0, title: 'Quantum computing', extract: 'Intro' }],
        },
      }),
    });

    await getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      requestResponseImpl,
    });

    const url = requestResponseImpl.mock.calls[0]?.[0]?.url as URL;
    expect(url.searchParams.get('prop')).toBe('extracts');
    expect(url.searchParams.get('explaintext')).toBe('1');
    expect(url.searchParams.get('exsectionformat')).toBe('plain');
    expect(url.searchParams.get('pageids')).toBe('25220');
    expect(url.searchParams.has('exintro')).toBe(false);
    expect(url.searchParams.has('exchars')).toBe(false);
  });

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
    });

    const result = await getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      requestResponseImpl,
    });

    expect(result).toEqual({
      kind: 'inline',
      lang: 'en',
      pageId: 25220,
      title: 'Quantum computing',
      content: 'Intro text',
    });
  });

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
    });

    const result = await getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      requestResponseImpl,
    });

    expect(result).toEqual({
      kind: 'inline',
      lang: 'en',
      pageId: 25220,
      title: 'Quantum computing',
      content: `\
Line 1
Line 2`,
    });
    expect(mockSaveWikipediaPageTextAsBinaryObject).not.toHaveBeenCalled();
  });

  it('saves long pages as binary objects instead of returning inline content', async () => {
    mockSaveWikipediaPageTextAsBinaryObject.mockResolvedValue({
      lineCount: WIKIPEDIA_INLINE_CONTENT_MAX_LINES + 1,
      byteLength: 4096,
      sysfsNaidanDataFilePath: '/sys/fs/naidan/binary-objects/by-id/bin-1/data',
    });
    const extract = `${'line\n'.repeat(WIKIPEDIA_INLINE_CONTENT_MAX_LINES)}overflow`;
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
    });

    const result = await getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      requestResponseImpl,
    });

    expect(mockSaveWikipediaPageTextAsBinaryObject).toHaveBeenCalledWith({
      lang: 'en',
      pageId: 25220,
      title: 'Quantum computing',
      content: extract,
      lineCount: WIKIPEDIA_INLINE_CONTENT_MAX_LINES + 1,
    });
    expect(result).toEqual({
      kind: 'binary_object',
      lang: 'en',
      pageId: 25220,
      title: 'Quantum computing',
      lineCount: WIKIPEDIA_INLINE_CONTENT_MAX_LINES + 1,
      byteLength: 4096,
      sysfsNaidanDataFilePath: '/sys/fs/naidan/binary-objects/by-id/bin-1/data',
    });
  });

  it('throws on invalid API response', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({ query: { pages: [{ title: 'Missing pageid' }] } }),
    });

    await expect(getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      requestResponseImpl,
    })).rejects.toThrow(/validation failed/i);
  });

  it('throws when the page is not found', async () => {
    const requestResponseImpl = createRequestResponseImpl({
      impl: () => ({ query: { pages: [] } }),
    });

    await expect(getWikipediaPage({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      requestResponseImpl,
    })).rejects.toThrow(/not found/i);
  });
});
