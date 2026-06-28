import { FILE_PROTOCOL_STANDALONE_GLOBAL_NAME } from '@/features/file-protocol-standalone/logic/file-protocol-standalone-protocol';
import { debugRecordFileProtocolStandaloneAppStartupFailure } from '@/features/file-protocol-standalone/debug/startup';

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

function recordAppStartupFailureDetails({ error }: {
  error: unknown,
}): AppStartupErrorDetails {
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
  return serialized;
}

export function recordAppStartupFailure({ error }: {
  error: unknown,
}): void {
  recordAppStartupFailureDetails({ error });
}

/**
 * Report a failure that occurs before Vue can own the startup UI. Once the
 * App is mounted, callers use recordAppStartupFailure() and render the
 * typed error state instead of replacing the already-live Vue tree.
 */
export function reportAppStartupFailure({ document, error }: {
  document: Document,
  error: unknown,
}): void {
  const serialized = recordAppStartupFailureDetails({ error });
  try {
    renderAppStartupFailurePanel({ document, error: serialized });
  } catch (renderError) {
    console.warn('[naidan] Failed to render the application startup failure panel:', renderError);
  }
}
