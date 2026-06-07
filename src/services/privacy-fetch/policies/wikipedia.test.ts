import { describe, expect, it } from 'vitest'
import { validateWikipediaPrivacyFetchUrl } from './wikipedia'

describe('validateWikipediaPrivacyFetchUrl', () => {
  it('accepts a supported search URL', () => {
    expect(validateWikipediaPrivacyFetchUrl({
      url: new URL('https://en.wikipedia.org/w/api.php?origin=*&action=query&format=json&formatversion=2&list=search&srsearch=quantum&srlimit=30&srnamespace=0&srprop=&srinfo='),
    })).toMatchObject({
      ok: true,
      policyName: 'wikipedia_api',
    })
  })

  it('rejects unsupported hostnames', () => {
    expect(validateWikipediaPrivacyFetchUrl({
      url: new URL('https://en.wikipedia.org.evil.com/w/api.php?origin=*&action=query&format=json&formatversion=2&list=search&srsearch=quantum&srlimit=30&srnamespace=0&srprop=&srinfo='),
    })).toMatchObject({
      ok: false,
      code: 'invalid_hostname',
    })
  })

  it('rejects malformed language labels', () => {
    for (const hostname of [
      '-.wikipedia.org',
      'en-.wikipedia.org',
      '-en.wikipedia.org',
    ]) {
      expect(validateWikipediaPrivacyFetchUrl({
        url: new URL(`https://${hostname}/w/api.php?origin=*&action=query&format=json&formatversion=2&list=search&srsearch=quantum&srlimit=30&srnamespace=0&srprop=&srinfo=`),
      })).toMatchObject({
        ok: false,
        code: 'invalid_hostname',
      })
    }
  })

  it('rejects unsupported query parameters like callback', () => {
    expect(validateWikipediaPrivacyFetchUrl({
      url: new URL('https://en.wikipedia.org/w/api.php?origin=*&action=query&format=json&formatversion=2&prop=extracts&explaintext=1&exsectionformat=plain&pageids=25220&callback=x'),
    })).toMatchObject({
      ok: false,
      code: 'invalid_query_parameter',
    })
  })

  it('rejects srsearch values longer than 120 characters', () => {
    expect(validateWikipediaPrivacyFetchUrl({
      url: new URL(`https://en.wikipedia.org/w/api.php?origin=*&action=query&format=json&formatversion=2&list=search&srsearch=${'a'.repeat(121)}&srlimit=30&srnamespace=0&srprop=&srinfo=`),
    })).toMatchObject({
      ok: false,
      code: 'invalid_query_parameter_value',
    })
  })
})
