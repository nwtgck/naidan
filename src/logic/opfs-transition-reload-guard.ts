type ReloadGuardDocument = Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
type ReloadGuardWindow = Pick<Window, 'addEventListener' | 'removeEventListener'> & {
  readonly location: Pick<Location, 'reload'>;
};

export interface OpfsTransitionReloadGuard {
  readonly markTransitionStarted: () => void;
  readonly reloadAfterSettlement: () => void;
  readonly dispose: () => void;
}

export function createOpfsTransitionReloadGuard({
  document,
  window,
}: {
  document: ReloadGuardDocument;
  window: ReloadGuardWindow;
}): OpfsTransitionReloadGuard {
  let transitionPending = false;
  let reloadRequested = false;

  const requestReloadIfPending = (): void => {
    if (!transitionPending || reloadRequested) {
      return;
    }
    reloadRequested = true;
    window.location.reload();
  };
  const handlePageShow = (): void => {
    requestReloadIfPending();
  };
  const handleVisibilityChange = (): void => {
    switch (document.visibilityState) {
    case 'hidden': return;
    case 'visible':
      requestReloadIfPending();
      return;
    default: return document.visibilityState satisfies never;
    }
  };

  window.addEventListener('pageshow', handlePageShow);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  return {
    markTransitionStarted() {
      transitionPending = true;
    },
    reloadAfterSettlement() {
      requestReloadIfPending();
    },
    dispose() {
      window.removeEventListener('pageshow', handlePageShow);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
