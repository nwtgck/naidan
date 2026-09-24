/** Wait for actual activation, not merely postMessage() or controllerchange.
 * Install the state listener BEFORE requesting SKIP_WAITING. The caller then
 * requests a full document reload, with no dependence on controllerchange order.
 */
export function activateUpdate({ worker, signal }: {
  worker: ServiceWorker;
  signal: AbortSignal;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('The update runtime was stopped.'));
      return;
    }
    let settled = false;
    const finish = ({ error }: { error?: Error } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('statechange', check);
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      const state = worker.state;
      switch (state) {
      case 'activated': finish(); break;
      case 'redundant': finish({ error: new Error('The selected update was replaced or could not activate. Try again.') }); break;
      case 'installed':
      case 'activating': break;
      case 'parsed':
      case 'installing': finish({ error: new Error('The selected update has not finished installation.') }); break;
      default: {
        const exhaustive: never = state;
        finish({ error: new Error(`Unexpected service worker state: ${exhaustive}`) });
      }
      }
    };
    const abort = () => finish({ error: new Error('The update runtime was stopped.') });
    const timer = setTimeout(() => finish({ error: new Error('The service worker did not activate. Try again.') }), 15000);
    worker.addEventListener('statechange', check);
    signal.addEventListener('abort', abort, { once: true });
    check();
    if (!settled && worker.state === 'installed') {
      try {
        worker.postMessage({ type: 'SKIP_WAITING' });
      } catch (error) {
        finish({ error: error instanceof Error ? error : new Error(String(error)) });
      }
    }
  });
}

export const TEST_ONLY = {
};
