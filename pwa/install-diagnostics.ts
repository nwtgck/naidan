import { createPWAInstallFailure } from '../src/logic/pwa/install-diagnostics';

/** Best-effort reporting must neither recover nor replace the install failure. */
export function createInstallFailureReporter({ scope, buildId, clients }: {
  scope: string;
  buildId: string;
  clients: Clients;
}) {
  let reported = false;
  return async ({ resourceUrl, error }: { resourceUrl: string; error: Error }): Promise<void> => {
    if (reported) return;
    reported = true;
    console.error('[PWA] Failed to precache an application resource.', { resourceUrl, buildId }, error);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    try {
      const failure = createPWAInstallFailure({ scope, buildId, resourceUrl, error });
      const scopeUrl = new URL(scope);
      await Promise.race([
        (async () => {
          // The installing worker controls no windows yet. Include pages still
          // controlled by the old worker, but do not notify other app scopes.
          const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
          if (finished) return;
          for (const client of windows) {
            const url = new URL(client.url);
            if (url.origin !== scopeUrl.origin || !url.pathname.startsWith(scopeUrl.pathname)) continue;
            try {

              client.postMessage(failure);
            } catch {
              // A closing window must not prevent delivery to other windows.
            }
          }
        })(),
        new Promise<void>((resolve) => {
          // Diagnostic delivery must not keep a failed install alive indefinitely.
          timer = setTimeout(resolve, 1000);
        }),
      ]);
    } catch (reportError) {
      console.warn('[PWA] Could not deliver the precache failure details.', reportError);
    } finally {
      finished = true;
      clearTimeout(timer);
    }
  };
}

export const TEST_ONLY = {};
