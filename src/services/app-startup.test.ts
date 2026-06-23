import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  recordFileProtocolStandaloneStartupPhase,
  reportAppStartupFailure,
  scheduleAppStartup,
  type FileProtocolStandaloneStartupState,
} from './app-startup'

function setReadyState({ value }: { value: DocumentReadyState }): void {
  Object.defineProperty(document, 'readyState', {
    configurable: true,
    value,
  })
}

function createStartupState(): FileProtocolStandaloneStartupState {
  return {
    format: 'file-protocol-standalone-startup-v1',
    phase: 'importing-entry',
    startedAt: 1,
    updatedAt: 1,
    documentReadyState: document.readyState,
    entryFileName: 'assets/index.js',
    history: [{
      phase: 'importing-entry',
      at: 1,
      documentReadyState: document.readyState,
      details: undefined,
    }],
    error: undefined,
    watchdog: undefined,
  }
}

function installStandaloneNamespace(): void {
  const startup = createStartupState()
  globalThis.__FILE_PROTOCOL_STANDALONE__ = {
    internal: {
      startup,
      systemJsPatch: undefined,
      systemJsRetry: undefined,
      workerRuntime: undefined,
    },
    getDiagnostics: () => ({
      format: 'file-protocol-standalone-diagnostics-v1',
      protocol: location.protocol,
      documentReadyState: document.readyState,
      systemJsAvailable: false,
      systemJsPatch: undefined,
      systemJsRetry: undefined,
      workerRuntime: undefined,
      startup,
    }),
  }
}

function readStartupState(): FileProtocolStandaloneStartupState | undefined {
  return globalThis.__FILE_PROTOCOL_STANDALONE__?.internal.startup
}

describe('app startup scheduling', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>'
    installStandaloneNamespace()
  })

  afterEach(() => {
    delete globalThis.__FILE_PROTOCOL_STANDALONE__
    vi.restoreAllMocks()
  })

  it('waits for DOMContentLoaded when the entry evaluates during parsing', async () => {
    setReadyState({ value: 'loading' })
    const bootstrap = vi.fn(async () => {})
    const onFailure = vi.fn()

    scheduleAppStartup({ document, bootstrap, onFailure })
    expect(bootstrap).not.toHaveBeenCalled()
    expect(readStartupState()?.phase).toBe('waiting-dom')

    document.dispatchEvent(new Event('DOMContentLoaded'))
    document.dispatchEvent(new Event('DOMContentLoaded'))
    await Promise.resolve()

    expect(bootstrap).toHaveBeenCalledTimes(1)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('starts immediately when asynchronous SystemJS evaluation missed DOMContentLoaded', async () => {
    setReadyState({ value: 'complete' })
    const bootstrap = vi.fn(async () => {})

    scheduleAppStartup({
      document,
      bootstrap,
      onFailure: vi.fn(),
    })
    await Promise.resolve()

    expect(bootstrap).toHaveBeenCalledTimes(1)
  })

  it('routes a rejected bootstrap to the explicit failure handler', async () => {
    setReadyState({ value: 'interactive' })
    const failure = new Error('storage initialization failed')
    const onFailure = vi.fn()

    scheduleAppStartup({
      document,
      bootstrap: async () => {
        throw failure
      },
      onFailure,
    })
    await vi.waitFor(() => {
      expect(onFailure).toHaveBeenCalledWith({ error: failure })
    })
  })
})

describe('app startup diagnostics', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>'
    installStandaloneNamespace()
  })

  afterEach(() => {
    delete globalThis.__FILE_PROTOCOL_STANDALONE__
    vi.restoreAllMocks()
  })

  it('records app phases in the loader-created startup history', () => {
    recordFileProtocolStandaloneStartupPhase({
      phase: 'waiting-router',
      details: { route: '/chat/example' },
    })

    expect(readStartupState()).toMatchObject({
      phase: 'waiting-router',
      documentReadyState: document.readyState,
      error: undefined,
    })
    expect(readStartupState()?.history.at(-1)).toMatchObject({
      phase: 'waiting-router',
      details: { route: '/chat/example' },
    })
  })

  it('renders a pre-Vue failure panel and keeps a serializable error in global state', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    reportAppStartupFailure({
      document,
      error: new TypeError('bootstrap exploded'),
    })

    expect(readStartupState()).toMatchObject({
      phase: 'bootstrap-failed',
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
})
