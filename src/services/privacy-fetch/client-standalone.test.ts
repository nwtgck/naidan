import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPrivacyFetchError } from './errors'
import { privacyFetch } from './client-standalone'

const VALID_SEARCH_URL = 'https://ja.wikipedia.org/w/api.php?origin=*&action=query&format=json&formatversion=2&list=search&srsearch=%E9%87%8F%E5%AD%90%E3%82%B3%E3%83%B3%E3%83%94%E3%83%A5%E3%83%BC%E3%82%BF&srlimit=30&srnamespace=0&srprop=&srinfo='

describe('privacyFetch standalone client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches directly after validating the URL', async () => {
    const body = new TextEncoder().encode('{"ok":true}').buffer
    const response = new Response(body.slice(0), {
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'application/json',
        'retry-after': '5',
      },
    })
    Object.defineProperty(response, 'url', {
      configurable: true,
      value: VALID_SEARCH_URL,
    })
    Object.defineProperty(response, 'type', {
      configurable: true,
      value: 'cors',
    })

    const fetchMock = vi.fn<typeof fetch>()
    fetchMock.mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)

    const result = await privacyFetch({
      request: {
        url: VALID_SEARCH_URL,
        signal: undefined,
      },
    })

    expect(fetchMock).toHaveBeenCalledWith(VALID_SEARCH_URL, {
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: undefined,
    })
    expect(result).toMatchObject({
      url: VALID_SEARCH_URL,
      status: 200,
      statusText: 'OK',
      ok: true,
      redirected: false,
      responseType: 'cors',
      bodyByteLength: body.byteLength,
      policyName: 'wikipedia_api',
    })
    expect(result.body.byteLength).toBe(body.byteLength)
    expect(result.headers).toBeInstanceOf(Headers)
    expect(result.headers.get('content-type')).toBe('application/json')
    expect(result.headers.get('retry-after')).toBe('5')
  })

  it('rejects invalid URLs before fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)

    await expect(privacyFetch({
      request: {
        url: 'https://example.com/w/api.php?origin=*',
        signal: undefined,
      },
    })).rejects.toMatchObject({
      code: 'rejected',
      name: 'PrivacyFetchError',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps an already-aborted signal to AbortError before fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()

    await expect(privacyFetch({
      request: {
        url: VALID_SEARCH_URL,
        signal: controller.signal,
      },
    })).rejects.toMatchObject({
      code: 'aborted',
      name: 'AbortError',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps fetch failures to PrivacyFetchError', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    fetchMock.mockRejectedValue(new Error('network failed'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(privacyFetch({
      request: {
        url: VALID_SEARCH_URL,
        signal: undefined,
      },
    })).rejects.toSatisfy((error: unknown) => (
      isPrivacyFetchError(error)
      && error.code === 'fetch_failed'
      && error.message.includes('network failed')
    ))
  })
})
