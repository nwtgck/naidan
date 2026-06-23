export type FileProtocolStandaloneStartupPhase =
  | 'importing-entry'
  | 'entry-imported'
  | 'entry-import-failed'
  | 'entry-evaluated'
  | 'waiting-dom'
  | 'bootstrapping'
  | 'waiting-router'
  | 'initializing-settings'
  | 'loading-chats'
  | 'mounting-vue'
  | 'mounted'
  | 'startup-watchdog-fired'
  | 'bootstrap-failed'

export type FileProtocolStandaloneStartupError = Readonly<{
  name: string
  message: string
  stack: string | undefined
}>

export type FileProtocolStandaloneStartupHistoryEntry = Readonly<{
  phase: FileProtocolStandaloneStartupPhase
  at: number
  documentReadyState: DocumentReadyState
  details: Readonly<Record<string, string | number | boolean>> | undefined
}>

export type FileProtocolStandaloneStartupWatchdog = Readonly<{
  firedAt: number
  stalledPhase: FileProtocolStandaloneStartupPhase
  timeoutMs: number
}>

export type FileProtocolStandaloneStartupState = {
  format: 'file-protocol-standalone-startup-v1'
  phase: FileProtocolStandaloneStartupPhase
  startedAt: number
  updatedAt: number
  documentReadyState: DocumentReadyState
  entryFileName: string
  history: FileProtocolStandaloneStartupHistoryEntry[]
  error: FileProtocolStandaloneStartupError | undefined
  watchdog: FileProtocolStandaloneStartupWatchdog | undefined
}


function serializeError({ error }: { error: unknown }): FileProtocolStandaloneStartupError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }
  return {
    name: 'NonErrorThrownValue',
    message: String(error),
    stack: undefined,
  }
}

/**
 * The standalone entry loader creates this state before it starts the async
 * System.import graph. App startup extends the same history so a white screen
 * can be diagnosed even when Vue has not mounted and the verification route is
 * therefore unavailable. Hosted builds intentionally have no loader-created
 * state, so recording becomes a no-op there.
 */
export function recordFileProtocolStandaloneStartupPhase({
  phase,
  details,
}: {
  phase: FileProtocolStandaloneStartupPhase
  details: Readonly<Record<string, string | number | boolean>> | undefined
}): void {
  const state = globalThis.__FILE_PROTOCOL_STANDALONE__?.internal.startup
  if (state === undefined) return

  const now = performance.now()
  state.phase = phase
  state.updatedAt = now
  state.documentReadyState = document.readyState
  state.history.push({
    phase,
    at: now,
    documentReadyState: document.readyState,
    details,
  })
}

function renderStartupFailure({ document, error }: {
  document: Document
  error: FileProtocolStandaloneStartupError
}): void {
  const panelId = 'file-protocol-standalone-startup-failure'
  document.getElementById(panelId)?.remove()

  const panel = document.createElement('section')
  panel.id = panelId
  panel.setAttribute('role', 'alert')
  panel.setAttribute('data-testid', 'file-protocol-standalone-startup-failure')
  panel.style.cssText = [
    'box-sizing:border-box',
    'margin:24px',
    'padding:20px',
    'border:1px solid #dc2626',
    'border-radius:12px',
    'background:#fff7f7',
    'color:#7f1d1d',
    'font:14px/1.5 system-ui,sans-serif',
    'white-space:pre-wrap',
    'overflow-wrap:anywhere',
  ].join(';')

  const title = document.createElement('strong')
  title.textContent = 'Naidan failed to start.'
  const message = document.createElement('div')
  message.textContent = `${error.name}: ${error.message}`
  const hint = document.createElement('div')
  hint.textContent = 'Open DevTools and run: globalThis.__FILE_PROTOCOL_STANDALONE__?.getDiagnostics()'
  panel.append(title, message, hint)

  const appElement = document.querySelector('#app')
  if (appElement !== null) {
    appElement.replaceChildren(panel)
  } else {
    document.body.appendChild(panel)
  }
}

export function reportAppStartupFailure({ document, error }: {
  document: Document
  error: unknown
}): void {
  const serialized = serializeError({ error })
  const state = globalThis.__FILE_PROTOCOL_STANDALONE__?.internal.startup
  if (state !== undefined) {
    state.error = serialized
  }
  recordFileProtocolStandaloneStartupPhase({
    phase: 'bootstrap-failed',
    details: { errorName: serialized.name },
  })
  console.error('[naidan] Application startup failed:', error)
  renderStartupFailure({ document, error: serialized })
}

/**
 * SystemJS loads the standalone entry asynchronously. On a large application,
 * DOMContentLoaded can fire before this module is evaluated, so listening only
 * for the future event can leave the page permanently blank. Start immediately
 * when the DOM is already ready, while preserving the listener path for hosted
 * builds and fast standalone loads that still evaluate during parsing.
 */
export function scheduleAppStartup({
  document,
  bootstrap,
  onFailure,
}: {
  document: Document
  bootstrap: () => Promise<void>
  onFailure: ({ error }: { error: unknown }) => void
}): void {
  let started = false
  const startOnce = (): void => {
    if (started) return
    started = true
    // Promise.resolve().then() catches both a synchronous throw before bootstrap
    // returns its Promise and a later asynchronous rejection with one path.
    void Promise.resolve()
      .then(bootstrap)
      .catch((error: unknown) => {
        onFailure({ error })
      })
  }

  const readyState = document.readyState
  switch (readyState) {
  case 'loading':
    recordFileProtocolStandaloneStartupPhase({
      phase: 'waiting-dom',
      details: undefined,
    })
    document.addEventListener('DOMContentLoaded', startOnce, { once: true })
    return
  case 'interactive':
  case 'complete':
    startOnce()
    return
  default: {
    const _ex: never = readyState
    throw new Error(`Unhandled document ready state: ${_ex}`)
  }
  }
}
