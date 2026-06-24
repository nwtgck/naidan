import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DebugFileProtocolStandaloneGlobalDiagnostics,
  DebugFileProtocolStandaloneStartupState,
  FileProtocolStandaloneInternalState,
} from './runtime-state'
import {
  debugInstallVueErrorHandler,
  debugRecordFileProtocolStandaloneStartupCheckpoint,
  debugReportFileProtocolStandaloneAppStartupFailure,
} from './startup'

type MutableNamespace = {
  getDiagnostics: () => DebugFileProtocolStandaloneGlobalDiagnostics
  internal: FileProtocolStandaloneInternalState
}

function createStartupState(): DebugFileProtocolStandaloneStartupState {
  return {
    format: 'file-protocol-standalone-startup-v2',
    checkpoint: 'importing-entry',
    startedAt: 1,
    updatedAt: 1,
    documentReadyState: document.readyState,
    entryFileName: 'assets/index.js',
    checkpointHistory: [{
      source: 'entry-loader',
      name: 'importing-entry',
      at: 1,
      documentReadyState: document.readyState,
      details: undefined,
    }],
    error: undefined,
    slowStartupNotice: undefined,
  }
}

function installStandaloneNamespace(): DebugFileProtocolStandaloneStartupState {
  const startup = createStartupState()
  const namespace: MutableNamespace = {
    internal: {
      core: {},
      debug: { startup },
    },
    getDiagnostics: () => ({
      format: 'file-protocol-standalone-diagnostics-v2',
      protocol: location.protocol,
      documentReadyState: document.readyState,
      systemJsAvailable: false,
      systemJsPatch: undefined,
      systemJsRetry: undefined,
      workerRuntime: undefined,
      startup,
    }),
  }
  globalThis.__FILE_PROTOCOL_STANDALONE__ = namespace
  return startup
}

describe('file-protocol standalone startup Debug state', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>'
    installStandaloneNamespace()
  })

  afterEach(() => {
    delete globalThis.__FILE_PROTOCOL_STANDALONE__
    vi.restoreAllMocks()
  })


  it('fails open when installing the Debug Vue error handler is rejected', () => {
    const app = {
      config: {},
    }
    Object.defineProperty(app.config, 'errorHandler', {
      configurable: true,
      set() {
        throw new Error('read-only error handler')
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => {
      debugInstallVueErrorHandler({ app: app as never })
    }).not.toThrow()
    expect(warn).toHaveBeenCalledWith(
      '[naidan] Failed to install the Debug Vue error handler:',
      expect.objectContaining({ message: 'read-only error handler' }),
    )
  })

  it('records Naidan app checkpoints in the loader-created Debug timeline', () => {
    debugRecordFileProtocolStandaloneStartupCheckpoint({
      checkpoint: 'waiting-router',
      details: { route: '/chat/example' },
    })

    const namespace = globalThis.__FILE_PROTOCOL_STANDALONE__ as unknown as MutableNamespace
    const startup = namespace.internal.debug?.startup
    expect(startup).toMatchObject({
      checkpoint: 'waiting-router',
      documentReadyState: document.readyState,
      error: undefined,
    })
    expect(startup?.checkpointHistory.at(-1)).toMatchObject({
      source: 'naidan-app',
      name: 'waiting-router',
      details: { route: '/chat/example' },
    })
  })

  it('renders a pre-Vue failure panel and keeps a serializable error in Debug state', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    debugReportFileProtocolStandaloneAppStartupFailure({
      document,
      error: new TypeError('bootstrap exploded'),
    })

    const namespace = globalThis.__FILE_PROTOCOL_STANDALONE__ as unknown as MutableNamespace
    expect(namespace.internal.debug?.startup).toMatchObject({
      checkpoint: 'bootstrap-failed',
      error: {
        name: 'TypeError',
        message: 'bootstrap exploded',
      },
    })
    expect(document.querySelectorAll('[data-testid="file-protocol-standalone-startup-failure"]')).toHaveLength(1)
    expect(document.querySelector('#app')?.textContent).toContain('Naidan failed to start.')
    expect(document.querySelector('#app')?.textContent).toContain('__FILE_PROTOCOL_STANDALONE__')
    expect(document.querySelector('#app')?.textContent).toContain('getDiagnostics()')
  })

  it('fails open when the Debug namespace is unavailable', () => {
    delete globalThis.__FILE_PROTOCOL_STANDALONE__
    Object.defineProperty(globalThis, '__FILE_PROTOCOL_STANDALONE__', {
      configurable: true,
      value: Object.freeze({}),
      writable: false,
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => {
      debugRecordFileProtocolStandaloneStartupCheckpoint({
        checkpoint: 'waiting-router',
        details: undefined,
      })
    }).not.toThrow()

    delete globalThis.__FILE_PROTOCOL_STANDALONE__
  })
})
