import { describe, expect, it } from 'vitest'
import { createHighlightWorker } from './highlight.worker.impl'

describe('highlight worker', () => {
  it('highlights with a named language when available', async () => {
    const worker = createHighlightWorker({})

    const response = await worker.highlight({
      request: {
        code: 'const value = 1;',
        language: 'javascript',
        mode: 'named-language',
      },
    })

    expect(response.html).toContain('const')
    expect(response.resolvedLanguage).toBe('javascript')
  })

  it('falls back to auto-detect when the named language is unknown', async () => {
    const worker = createHighlightWorker({})

    const response = await worker.highlight({
      request: {
        code: 'const value = 1;',
        language: 'not-a-real-language',
        mode: 'named-language',
      },
    })

    expect(response.html).toContain('const')
    expect(response.resolvedLanguage).not.toBe('not-a-real-language')
  })

  it('supports auto-detect mode directly', async () => {
    const worker = createHighlightWorker({})

    const response = await worker.highlight({
      request: {
        code: '{"value":1}',
        language: undefined,
        mode: 'auto-detect',
      },
    })

    expect(response.html).toContain('value')
    expect(response.resolvedLanguage.length).toBeGreaterThan(0)
  })

  it('escapes hostile html in the highlighted output', async () => {
    const worker = createHighlightWorker({})

    const response = await worker.highlight({
      request: {
        code: '<img src=x onerror=alert(1)><script>alert(2)</script>',
        language: 'html',
        mode: 'named-language',
      },
    })

    expect(response.html).toContain('&lt;')
    expect(response.html).toContain('hljs-name')
    expect(response.html).not.toContain('<img')
    expect(response.html).not.toContain('<script')
  })
})
