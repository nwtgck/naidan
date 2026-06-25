import { FILE_PROTOCOL_STANDALONE_GLOBAL_NAME } from '@/file-protocol-standalone-protocol';
import { debugRecordFileProtocolStandaloneAppStartupFailure } from '@/services/debug-file-protocol-standalone/startup';

type AppStartupErrorDetails = Readonly<{
  name: string,
  message: string,
  stack: string | undefined,
}>;

function serializeAppStartupError({ error }: { error: unknown }): AppStartupErrorDetails {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    name: 'NonErrorThrownValue',
    message: String(error),
    stack: undefined,
  };
}

function renderAppStartupFailurePanel({ document, error }: {
  document: Document,
  error: AppStartupErrorDetails,
}): void {
  const panelId = 'app-startup-failure';
  document.getElementById(panelId)?.remove();

  const panel = document.createElement('section');
  panel.id = panelId;
  panel.setAttribute('role', 'alert');
  panel.setAttribute('data-testid', 'app-startup-failure');
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
  ].join(';');

  const title = document.createElement('strong');
  title.textContent = 'Naidan failed to start.';
  const message = document.createElement('div');
  message.textContent = `${error.name}: ${error.message}`;
  panel.append(title, message);

  if (typeof globalThis.__FILE_PROTOCOL_STANDALONE__?.getDiagnostics === 'function') {
    const hint = document.createElement('div');
    hint.textContent = `Open DevTools and run: globalThis.${FILE_PROTOCOL_STANDALONE_GLOBAL_NAME}?.getDiagnostics()`;
    panel.appendChild(hint);
  }

  const appElement = document.querySelector('#app');
  if (appElement !== null) {
    appElement.replaceChildren(panel);
  } else {
    document.body.appendChild(panel);
  }
}

/**
 * Report a failed application bootstrap in both hosted and standalone builds.
 * Standalone Debug state is updated opportunistically, but the user-facing
 * failure panel is a normal application responsibility rather than Debug UI.
 */
export function reportAppStartupFailure({ document, error }: {
  document: Document,
  error: unknown,
}): void {
  let serialized: AppStartupErrorDetails;
  try {
    serialized = serializeAppStartupError({ error });
  } catch (serializationError) {
    serialized = {
      name: 'UnserializableStartupError',
      message: 'The startup error could not be serialized.',
      stack: undefined,
    };
    console.warn('[naidan] Failed to serialize the application startup error:', serializationError);
  }

  debugRecordFileProtocolStandaloneAppStartupFailure({ error: serialized });
  try {
    console.error('[naidan] Application startup failed:', error);
  } catch {
    // Failure reporting must not create another unhandled rejection.
  }
  try {
    renderAppStartupFailurePanel({ document, error: serialized });
  } catch (renderError) {
    console.warn('[naidan] Failed to render the application startup failure panel:', renderError);
  }
}
