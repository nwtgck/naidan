import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import {
  createEntryImportSource,
  removeTrailingSourceMapDirective,
} from './file-protocol-standalone'

type StartupState = Readonly<{
  phase: string
  history: ReadonlyArray<Readonly<{
    phase: string
    details: Readonly<Record<string, unknown>> | undefined
  }>>
  error: Readonly<{
    name: string
    message: string
  }> | undefined
  watchdog: Readonly<{
    stalledPhase: string
    timeoutMs: number
  }> | undefined
}>

function executeEntryLoader({
  systemImport,
  watchdogTimeoutMs,
}: {
  systemImport: (specifier: string) => Promise<unknown>
  watchdogTimeoutMs: number
}): Readonly<{
  document: Document
  globalObject: Record<string, unknown>
  runWatchdog: () => void
  consoleError: ReturnType<typeof vi.fn>
}> {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'file:///tmp/naidan/index.html',
  })
  const callbacks: Array<() => void> = []
  const globalObject: Record<string, unknown> = {
    performance: { now: () => 123 },
  }
  const consoleError = vi.fn()
  const source = createEntryImportSource({
    entryFileName: 'assets/index-legacy.js',
    watchdogTimeoutMs,
  })
  const execute = new Function(
    'globalThis',
    'document',
    'System',
    'console',
    'setTimeout',
    source,
  ) as (
    globalObject: Record<string, unknown>,
    document: Document,
    system: Readonly<{ import: (specifier: string) => Promise<unknown> }>,
    console: Readonly<{ error: (...args: unknown[]) => void }>,
    setTimeout: (callback: () => void, timeoutMs: number) => number,
  ) => void

  execute(
    globalObject,
    dom.window.document,
    { import: systemImport },
    { error: consoleError },
    (callback, timeoutMs) => {
      expect(timeoutMs).toBe(watchdogTimeoutMs)
      callbacks.push(callback)
      return callbacks.length
    },
  )

  return {
    document: dom.window.document,
    globalObject,
    runWatchdog: () => {
      const callback = callbacks.shift()
      if (callback === undefined) throw new Error('Expected a startup watchdog callback.')
      callback()
    },
    consoleError,
  }
}

function readStartupState({ globalObject }: {
  globalObject: Record<string, unknown>
}): StartupState {
  const state = globalObject['__FILE_PROTOCOL_STANDALONE_STARTUP__']
  if (state === undefined) throw new Error('Expected startup state to be created.')
  return state as StartupState
}

describe('standalone startup entry loader', () => {
  it('removes only a trailing source map directive from the emitted SystemJS runtime', () => {
    const trailingDirective = '//# ' + 'sourceMappingURL=system.min.js.map'
    const nonTrailingDirective = '//# ' + 'sourceMappingURL=kept-because-not-final.map'

    expect(removeTrailingSourceMapDirective({
      source: `\
console.log('runtime')
${trailingDirective}
`,
    })).toBe(`\
console.log('runtime')
`)

    expect(removeTrailingSourceMapDirective({
      source: `\
${nonTrailingDirective}
console.log('runtime')
`,
    })).toBe(`\
${nonTrailingDirective}
console.log('runtime')
`)
  })

  it('records an import rejection and renders diagnostics before Vue exists', async () => {
    const failure = new TypeError('entry failed')
    const harness = executeEntryLoader({
      systemImport: () => Promise.reject(failure),
      watchdogTimeoutMs: 15_000,
    })

    await vi.waitFor(() => {
      expect(readStartupState({ globalObject: harness.globalObject })).toMatchObject({
        phase: 'entry-import-failed',
        error: {
          name: 'TypeError',
          message: 'entry failed',
        },
      })
    })
    expect(harness.consoleError).toHaveBeenCalledWith(
      '[file-protocol-standalone] Entry import failed:',
      failure,
    )
    expect(harness.document.querySelector('#file-protocol-standalone-startup-failure')?.textContent)
      .toContain('entry failed')
  })

  it('reports a stalled pre-Vue phase without discarding the phase that stalled', () => {
    const harness = executeEntryLoader({
      systemImport: () => new Promise(() => {}),
      watchdogTimeoutMs: 25,
    })

    harness.runWatchdog()

    const state = readStartupState({ globalObject: harness.globalObject })
    expect(state.phase).toBe('importing-entry')
    expect(state.watchdog).toEqual({
      firedAt: 123,
      stalledPhase: 'importing-entry',
      timeoutMs: 25,
    })
    expect(state.history.at(-1)).toEqual({
      phase: 'startup-watchdog-fired',
      at: 123,
      documentReadyState: harness.document.readyState,
      details: {
        stalledPhase: 'importing-entry',
        timeoutMs: 25,
      },
    })
    expect(harness.document.querySelector('#file-protocol-standalone-startup-watchdog')?.textContent)
      .toContain('phase "importing-entry"')
  })

  it('does not show the watchdog after a generic entry import has completed', async () => {
    const harness = executeEntryLoader({
      systemImport: async () => undefined,
      watchdogTimeoutMs: 25,
    })

    await vi.waitFor(() => {
      expect(readStartupState({ globalObject: harness.globalObject }).phase).toBe('entry-imported')
    })
    harness.runWatchdog()

    expect(harness.document.querySelector('#file-protocol-standalone-startup-watchdog')).toBeNull()
    expect(readStartupState({ globalObject: harness.globalObject }).watchdog).toBeUndefined()
  })
})
