import {
  debugReadFileProtocolStandaloneStartupState,
  type DebugFileProtocolStandaloneStartupCheckpointName,
  type DebugFileProtocolStandaloneStartupError,
} from './runtime-state'
import type { App } from 'vue'
import { FILE_PROTOCOL_STANDALONE_GLOBAL_NAME } from '@/file-protocol-standalone-protocol'

/**
 * Install Naidan's Debug-only Vue error observer. Core rendering does not rely
 * on this handler and must continue to behave the same if it is removed.
 */
export function debugInstallVueErrorHandler({ app }: { app: App }): void {
  try {
    app.config.errorHandler = (error, instance, info) => {
      console.error('Vue Error:', error)
      console.error('Vue Instance:', instance)
      console.error('Error Info:', info)
    }
  } catch (error) {
    // Debug observability must never prevent the Core Vue bootstrap from
    // continuing. Keep failures visible without making installation mandatory
    // at runtime.
    console.warn('[naidan] Failed to install the Debug Vue error handler:', error)
  }
}

function debugSerializeFileProtocolStandaloneStartupError({ error }: {
  error: unknown
}): DebugFileProtocolStandaloneStartupError {
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
 * Append a Naidan-owned checkpoint to the optional standalone Debug timeline.
 * Core startup never reads this state. Recording is fail-open and becomes a
 * no-op in hosted builds where the standalone loader did not create the state.
 */
export function debugRecordFileProtocolStandaloneStartupCheckpoint({
  checkpoint,
  details,
}: {
  checkpoint: DebugFileProtocolStandaloneStartupCheckpointName
  details: Readonly<Record<string, string | number | boolean>> | undefined
}): void {
  try {
    const startupDebugState = debugReadFileProtocolStandaloneStartupState()
    if (startupDebugState === undefined) return

    const now = performance.now()
    startupDebugState.checkpoint = checkpoint
    startupDebugState.updatedAt = now
    startupDebugState.documentReadyState = document.readyState
    startupDebugState.checkpointHistory.push({
      source: 'naidan-app',
      name: checkpoint,
      at: now,
      documentReadyState: document.readyState,
      details,
    })
  } catch (error) {
    console.warn('[naidan] Failed to record standalone startup Debug checkpoint:', error)
  }
}

function debugRenderFileProtocolStandaloneStartupFailurePanel({ document, error }: {
  document: Document
  error: DebugFileProtocolStandaloneStartupError
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
  hint.textContent = `Open DevTools and run: globalThis.${FILE_PROTOCOL_STANDALONE_GLOBAL_NAME}?.getDiagnostics()`
  panel.append(title, message, hint)

  const appElement = document.querySelector('#app')
  if (appElement !== null) {
    appElement.replaceChildren(panel)
  } else {
    document.body.appendChild(panel)
  }
}

export function debugReportFileProtocolStandaloneAppStartupFailure({ document, error }: {
  document: Document
  error: unknown
}): void {
  const serialized = debugSerializeFileProtocolStandaloneStartupError({ error })
  try {
    const startupDebugState = debugReadFileProtocolStandaloneStartupState()
    if (startupDebugState !== undefined) startupDebugState.error = serialized
    debugRecordFileProtocolStandaloneStartupCheckpoint({
      checkpoint: 'bootstrap-failed',
      details: { errorName: serialized.name },
    })
  } catch (debugError) {
    console.warn('[naidan] Failed to update standalone startup Debug state:', debugError)
  }
  console.error('[naidan] Application startup failed:', error)
  try {
    debugRenderFileProtocolStandaloneStartupFailurePanel({ document, error: serialized })
  } catch (debugError) {
    console.warn('[naidan] Failed to render standalone startup Debug panel:', debugError)
  }
}
