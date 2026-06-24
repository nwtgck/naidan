import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reportAppStartupFailure } from './app-startup-failure'
import type {
  DebugFileProtocolStandaloneGlobalDiagnostics,
  DebugFileProtocolStandaloneStartupState,
  FileProtocolStandaloneInternalState,
} from './debug-file-protocol-standalone/runtime-state'

type MutableNamespace = {
  getDiagnostics: () => DebugFileProtocolStandaloneGlobalDiagnostics
  internal: FileProtocolStandaloneInternalState
}

function installStandaloneNamespace(): DebugFileProtocolStandaloneStartupState {
  const startup: DebugFileProtocolStandaloneStartupState = {
    format: 'file-protocol-standalone-startup-v2',
    checkpoint: 'entry-evaluated',
    startedAt: 1,
    updatedAt: 1,
    documentReadyState: document.readyState,
    entryFileName: 'assets/index.js',
    checkpointHistory: [],
    error: undefined,
    slowStartupNotice: undefined,
  }
  const namespace: MutableNamespace = {
    internal: { core: {}, debug: { startup } },
    getDiagnostics: () => ({
      format: 'file-protocol-standalone-diagnostics-v2',
      protocol: 'file:',
      documentReadyState: document.readyState,
      systemJsAvailable: true,
      systemJsPatch: undefined,
      systemJsRetry: undefined,
      workerRuntime: undefined,
      startup,
    }),
  }
  globalThis.__FILE_PROTOCOL_STANDALONE__ = namespace
  return startup
}

describe('reportAppStartupFailure', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>'
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    delete globalThis.__FILE_PROTOCOL_STANDALONE__
    vi.restoreAllMocks()
  })

  it('renders a general startup failure panel in hosted builds', () => {
    reportAppStartupFailure({ document, error: new TypeError('bootstrap exploded') })

    const panel = document.querySelector('[data-testid="app-startup-failure"]')
    expect(panel?.textContent).toContain('Naidan failed to start.')
    expect(panel?.textContent).toContain('TypeError: bootstrap exploded')
    expect(panel?.textContent).not.toContain('__FILE_PROTOCOL_STANDALONE__')
  })

  it('records standalone Debug state and includes the diagnostics hint when available', () => {
    const startup = installStandaloneNamespace()

    reportAppStartupFailure({ document, error: new Error('standalone bootstrap exploded') })

    expect(startup).toMatchObject({
      checkpoint: 'bootstrap-failed',
      error: {
        name: 'Error',
        message: 'standalone bootstrap exploded',
      },
    })
    expect(document.querySelector('[data-testid="app-startup-failure"]')?.textContent)
      .toContain('__FILE_PROTOCOL_STANDALONE__?.getDiagnostics()')
  })
})
