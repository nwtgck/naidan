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
  onWaitingForDom,
  onFailure,
}: {
  document: Document,
  bootstrap: () => Promise<void>,
  onWaitingForDom: () => void,
  onFailure: ({ error }: { error: unknown }) => void,
}): void {
  let started = false;
  const startOnce = (): void => {
    if (started) return;
    started = true;
    void Promise.resolve()
      .then(bootstrap)
      .catch((error: unknown) => {
        onFailure({ error });
      });
  };

  const readyState = document.readyState;
  switch (readyState) {
  case 'loading':
    onWaitingForDom();
    document.addEventListener('DOMContentLoaded', startOnce, { once: true });
    return;
  case 'interactive':
  case 'complete':
    startOnce();
    return;
  default: {
    const _ex: never = readyState;
    throw new Error(`Unhandled document ready state: ${_ex}`);
  }
  }
}
