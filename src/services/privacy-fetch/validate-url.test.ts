import { describe, expect, it } from 'vitest'
import { validatePrivacyFetchUrl } from './validate-url'

describe('validatePrivacyFetchUrl', () => {
  it('accepts a valid wikipedia search URL', () => {
    expect(validatePrivacyFetchUrl({
      urlText: 'https://ja.wikipedia.org/w/api.php?origin=*&action=query&format=json&formatversion=2&list=search&srsearch=%E9%87%8F%E5%AD%90%E3%82%B3%E3%83%B3%E3%83%94%E3%83%A5%E3%83%BC%E3%82%BF&srlimit=30&srnamespace=0&srprop=&srinfo=',
    })).toEqual({
      ok: true,
      policyName: 'wikipedia_api',
      normalizedUrl: 'https://ja.wikipedia.org/w/api.php?origin=*&action=query&format=json&formatversion=2&list=search&srsearch=%E9%87%8F%E5%AD%90%E3%82%B3%E3%83%B3%E3%83%94%E3%83%A5%E3%83%BC%E3%82%BF&srlimit=30&srnamespace=0&srprop=&srinfo=',
    })
  })

  it('accepts a valid wikipedia get page URL', () => {
    expect(validatePrivacyFetchUrl({
      urlText: 'https://en.wikipedia.org/w/api.php?origin=*&action=query&format=json&formatversion=2&prop=extracts&explaintext=1&exsectionformat=plain&pageids=25220',
    })).toEqual({
      ok: true,
      policyName: 'wikipedia_api',
      normalizedUrl: 'https://en.wikipedia.org/w/api.php?origin=*&action=query&format=json&formatversion=2&prop=extracts&explaintext=1&exsectionformat=plain&pageids=25220',
    })
  })

  it('rejects http URLs', () => {
    expect(validatePrivacyFetchUrl({
      urlText: 'http://en.wikipedia.org/w/api.php?action=query',
    })).toMatchObject({
      ok: false,
      code: 'invalid_protocol',
    })
  })

  it('rejects username and password in URLs', () => {
    expect(validatePrivacyFetchUrl({
      urlText: 'https://user:pass@en.wikipedia.org/w/api.php?action=query',
    })).toMatchObject({
      ok: false,
      code: 'invalid_username_or_password',
    })
  })

  it('rejects explicit ports', () => {
    expect(validatePrivacyFetchUrl({
      urlText: 'https://en.wikipedia.org:8443/w/api.php?action=query',
    })).toMatchObject({
      ok: false,
      code: 'invalid_port',
    })
  })

  it('rejects URL hashes', () => {
    expect(validatePrivacyFetchUrl({
      urlText: 'https://en.wikipedia.org/w/api.php?action=query#frag',
    })).toMatchObject({
      ok: false,
      code: 'invalid_hash',
    })
  })

  it('rejects wikipedia.org.evil.com', () => {
    expect(validatePrivacyFetchUrl({
      urlText: 'https://en.wikipedia.org.evil.com/w/api.php?action=query',
    })).toMatchObject({
      ok: false,
      code: 'invalid_hostname',
    })
  })

  it('rejects unsupported pathname', () => {
    expect(validatePrivacyFetchUrl({
      urlText: 'https://en.wikipedia.org/wiki/Quantum_computing',
    })).toMatchObject({
      ok: false,
      code: 'invalid_pathname',
    })
  })

  it('rejects unknown query parameters', () => {
    expect(validatePrivacyFetchUrl({
      urlText: 'https://en.wikipedia.org/w/api.php?origin=*&action=query&format=json&formatversion=2&list=search&srsearch=x&srlimit=30&srnamespace=0&srprop=&srinfo=&callback=x',
    })).toMatchObject({
      ok: false,
      code: 'invalid_query_parameter',
    })
  })

  it('rejects duplicate query parameters', () => {
    expect(validatePrivacyFetchUrl({
      urlText: 'https://en.wikipedia.org/w/api.php?origin=*&action=query&action=query&format=json&formatversion=2&list=search&srsearch=x&srlimit=30&srnamespace=0&srprop=&srinfo=',
    })).toMatchObject({
      ok: false,
      code: 'duplicate_query_parameter',
    })
  })

  it('rejects srlimit above the current maximum', () => {
    expect(validatePrivacyFetchUrl({
      urlText: 'https://en.wikipedia.org/w/api.php?origin=*&action=query&format=json&formatversion=2&list=search&srsearch=x&srlimit=31&srnamespace=0&srprop=&srinfo=',
    })).toMatchObject({
      ok: false,
      code: 'invalid_query_parameter_value',
    })
  })

  it('rejects non-positive pageids', () => {
    expect(validatePrivacyFetchUrl({
      urlText: 'https://en.wikipedia.org/w/api.php?origin=*&action=query&format=json&formatversion=2&prop=extracts&explaintext=1&exsectionformat=plain&pageids=0',
    })).toMatchObject({
      ok: false,
      code: 'invalid_query_parameter_value',
    })
  })
})
