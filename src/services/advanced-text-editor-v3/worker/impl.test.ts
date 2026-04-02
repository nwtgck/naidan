import { describe, expect, it } from 'vitest'
import { createAdvancedTextEditorV3Worker } from './impl'

describe('advanced-text-editor-v3 worker', () => {
  it('searches text with case-insensitive plain matching', async () => {
    const worker = createAdvancedTextEditorV3Worker({})

    const response = await worker.searchText({
      request: {
        text: 'Apple banana apple',
        query: 'apple',
        caseSensitive: 'case-insensitive',
        useRegex: 'regex-off',
      },
    })

    expect(response.matches).toEqual([
      { start: 0, end: 5 },
      { start: 13, end: 18 },
    ])
    expect(response.isValidRegex).toBe(true)
  })

  it('returns invalid regex state without throwing', async () => {
    const worker = createAdvancedTextEditorV3Worker({})

    const response = await worker.searchText({
      request: {
        text: 'abc',
        query: '[',
        caseSensitive: 'case-sensitive',
        useRegex: 'regex-on',
      },
    })

    expect(response.matches).toEqual([])
    expect(response.isValidRegex).toBe(false)
  })

  it('replaces all matches and returns refreshed match state', async () => {
    const worker = createAdvancedTextEditorV3Worker({})

    const response = await worker.replaceAll({
      request: {
        text: 'foo bar foo',
        query: 'foo',
        replacement: 'qux',
        caseSensitive: 'case-sensitive',
        useRegex: 'regex-off',
      },
    })

    expect(response.text).toBe('qux bar qux')
    expect(response.matches).toEqual([])
    expect(response.isValidRegex).toBe(true)
  })

  it('replaces a selected single match', async () => {
    const worker = createAdvancedTextEditorV3Worker({})

    const response = await worker.replaceSingle({
      request: {
        text: 'foo bar foo',
        query: 'foo',
        replacement: 'zip',
        caseSensitive: 'case-sensitive',
        useRegex: 'regex-off',
        selectionStart: 0,
        selectionEnd: 3,
      },
    })

    expect(response.didReplace).toBe(true)
    expect(response.text).toBe('zip bar foo')
    expect(response.replacementStart).toBe(0)
    expect(response.replacementEnd).toBe(3)
    expect(response.matches).toEqual([{ start: 8, end: 11 }])
  })

  it('prepares multi-edit by expanding to the current word and applying replacement', async () => {
    const worker = createAdvancedTextEditorV3Worker({})

    const prepared = await worker.prepareMultiEdit({
      request: {
        text: 'foo bar foo baz',
        selectionStart: 1,
        selectionEnd: 1,
      },
    })

    expect(prepared.selection).toBe('foo')
    expect(prepared.selectionStart).toBe(0)
    expect(prepared.selectionEnd).toBe(3)
    expect(prepared.matchStarts).toEqual([0, 8])

    const applied = await worker.applyMultiEdit({
      request: {
        text: 'foo bar foo baz',
        target: prepared.selection!,
        replacement: 'qux',
      },
    })

    expect(applied.text).toBe('qux bar qux baz')
  })
})
