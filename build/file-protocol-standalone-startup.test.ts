import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { createFileProtocolStandaloneEntryBootstrapSource } from './file-protocol-standalone/systemjs'

type StartupState = Readonly<{
  checkpoint: string
  checkpointHistory: ReadonlyArray<Readonly<{
    source: string
    name: string
    details: Readonly<Record<string, unknown>> | undefined
  }>>
  error: Readonly<{
    name: string
    message: string
  }> | undefined
  slowStartupNotice: Readonly<{
    delayMs: number
    stalledCheckpoint: string
    panelShownAt: number | undefined
  }> | undefined
}>

function executeEntryBootstrap({
  systemImport,
  slowStartupNoticeDelayMs,
  initialNamespace,
}: {
  systemImport: (specifier: string) => Promise<unknown>
  slowStartupNoticeDelayMs: number
  initialNamespace: unknown | undefined
}): Readonly<{
  document: Document
  globalObject: Record<string, unknown>
  runSlowStartupNotice: () => void
  consoleError: ReturnType<typeof vi.fn>
  consoleWarn: ReturnType<typeof vi.fn>
}> {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'file:///__nonexistent_file_protocol_test_root__/index.html',
  })
  const callbacks: Array<() => void> = []
  const globalObject: Record<string, unknown> = {
    performance: { now: () => 123 },
  }
  if (initialNamespace !== undefined) {
    globalObject['__FILE_PROTOCOL_STANDALONE__'] = initialNamespace
  }
  const consoleError = vi.fn()
  const consoleWarn = vi.fn()
  const source = createFileProtocolStandaloneEntryBootstrapSource({
    entryFileName: 'assets/index-legacy.js',
    debugSlowStartupNoticeDelayMs: slowStartupNoticeDelayMs,
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
    console: Readonly<{
      error: (...args: unknown[]) => void
      warn: (...args: unknown[]) => void
    }>,
    setTimeout: (callback: () => void, timeoutMs: number) => number,
  ) => void

  execute(
    globalObject,
    dom.window.document,
    { import: systemImport },
    { error: consoleError, warn: consoleWarn },
    (callback, timeoutMs) => {
      expect(timeoutMs).toBe(slowStartupNoticeDelayMs)
      callbacks.push(callback)
      return callbacks.length
    },
  )

  return {
    document: dom.window.document,
    globalObject,
    runSlowStartupNotice: () => {
      const callback = callbacks.shift()
      if (callback === undefined) throw new Error('Expected a slow-startup notice callback.')
      callback()
    },
    consoleError,
    consoleWarn,
  }
}

function readStartupState({ globalObject }: {
  globalObject: Record<string, unknown>
}): StartupState {
  const namespace = globalObject['__FILE_PROTOCOL_STANDALONE__'] as Readonly<{
    internal?: Readonly<{
      debug?: Readonly<{ startup?: unknown }>
    }>
  }> | undefined
  const state = namespace?.internal?.debug?.startup
  if (state === undefined) throw new Error('Expected startup Debug state to be created.')
  return state as StartupState
}

describe('standalone application entry bootstrap', () => {
  it('exposes detached Debug diagnostics before the application entry resolves', () => {
    const harness = executeEntryBootstrap({
      systemImport: () => new Promise(() => {}),
      slowStartupNoticeDelayMs: 25,
      initialNamespace: undefined,
    })
    const namespace = harness.globalObject['__FILE_PROTOCOL_STANDALONE__'] as Readonly<{
      getDiagnostics: () => Readonly<Record<string, unknown>>
    }>

    expect(harness.globalObject).not.toHaveProperty('__FILE_PROTOCOL_STANDALONE_STARTUP__')
    const snapshot = namespace.getDiagnostics()
    expect(snapshot).toMatchObject({
      format: 'file-protocol-standalone-diagnostics-v2',
      startup: {
        checkpoint: 'importing-entry',
        entryFileName: 'assets/index-legacy.js',
      },
    })
    ;(snapshot.startup as { checkpoint: string }).checkpoint = 'mutated-from-devtools'
    expect(readStartupState({ globalObject: harness.globalObject }).checkpoint).toBe('importing-entry')
  })

  it('records an import rejection and renders diagnostics before Vue exists', async () => {
    const failure = new TypeError('entry failed')
    const harness = executeEntryBootstrap({
      systemImport: () => Promise.reject(failure),
      slowStartupNoticeDelayMs: 15_000,
      initialNamespace: undefined,
    })

    await vi.waitFor(() => {
      expect(readStartupState({ globalObject: harness.globalObject })).toMatchObject({
        checkpoint: 'entry-import-failed',
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

  it('records a slow-startup notice without changing the current checkpoint or cancelling import', () => {
    const harness = executeEntryBootstrap({
      systemImport: () => new Promise(() => {}),
      slowStartupNoticeDelayMs: 25,
      initialNamespace: undefined,
    })

    harness.runSlowStartupNotice()

    const state = readStartupState({ globalObject: harness.globalObject })
    expect(state.checkpoint).toBe('importing-entry')
    expect(state.slowStartupNotice).toEqual({
      delayMs: 25,
      delayElapsedAt: 123,
      stalledCheckpoint: 'importing-entry',
      panelShownAt: 123,
    })
    expect(state.checkpointHistory.at(-1)).toMatchObject({
      source: 'entry-loader',
      name: 'importing-entry',
    })
    expect(harness.document.querySelector('#file-protocol-standalone-slow-startup-notice')?.textContent)
      .toContain('checkpoint "importing-entry"')
  })

  it('does not show the slow-startup notice after a generic entry import has completed', async () => {
    const harness = executeEntryBootstrap({
      systemImport: async () => undefined,
      slowStartupNoticeDelayMs: 25,
      initialNamespace: undefined,
    })

    await vi.waitFor(() => {
      expect(readStartupState({ globalObject: harness.globalObject }).checkpoint).toBe('entry-imported')
    })
    harness.runSlowStartupNotice()

    expect(harness.document.querySelector('#file-protocol-standalone-slow-startup-notice')).toBeNull()
    expect(readStartupState({ globalObject: harness.globalObject }).slowStartupNotice).toBeUndefined()
  })

  it('imports the application entry even when Debug namespace initialization fails', () => {
    const systemImport = vi.fn(async () => undefined)
    const harness = executeEntryBootstrap({
      systemImport,
      slowStartupNoticeDelayMs: 25,
      initialNamespace: Object.freeze({}),
    })

    expect(systemImport).toHaveBeenCalledWith('./assets/index-legacy.js')
    expect(harness.consoleWarn).toHaveBeenCalledWith(
      '[file-protocol-standalone] Failed to initialize debug diagnostics. Application entry import will continue.',
      expect.any(TypeError),
    )
  })
})
