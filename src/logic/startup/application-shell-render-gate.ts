export interface ApplicationShellRenderGate {
  reportInitialRender(): void,
  reportInitialRenderFailure({ error }: { error: unknown }): void,
  waitForInitialRender(): Promise<void>,
}

type ApplicationShellRenderSettlement =
  | {
    type: 'pending',
  }
  | {
    type: 'ready',
  }
  | {
    type: 'failed',
    error: unknown,
  };

/**
 * Coordinates the real application shell with the encrypted startup screen.
 * MainApp reports only after Sidebar and the initial route have completed the
 * preparation needed for their real first render. Startup then waits for a
 * presentation paint before removing the lock, so the user never sees the
 * application assemble lazily underneath it.
 */
export function createApplicationShellRenderGate(): ApplicationShellRenderGate {
  const completion = Promise.withResolvers<void>();
  let settlement: ApplicationShellRenderSettlement = {
    type: 'pending',
  };

  function isPending(): boolean {
    switch (settlement.type) {
    case 'pending':
      return true;
    case 'ready':
    case 'failed':
      return false;
    default: {
      const _ex: never = settlement;
      return _ex;
    }
    }
  }

  return {
    reportInitialRender(): void {
      if (!isPending()) {
        return;
      }
      settlement = {
        type: 'ready',
      };
      completion.resolve();
    },
    reportInitialRenderFailure({ error }): void {
      if (!isPending()) {
        return;
      }
      settlement = {
        type: 'failed',
        error,
      };
      // Resolve rather than rejecting here. A route can fail before startApp
      // reaches its await, and retaining the error until the waiter arrives
      // avoids a transient unhandled-rejection report.
      completion.resolve();
    },
    waitForInitialRender: async (): Promise<void> => {
      await completion.promise;
      switch (settlement.type) {
      case 'ready':
        return;
      case 'failed':
        throw settlement.error;
      case 'pending':
        throw new Error('Application shell render gate resolved without a settlement.');
      default: {
        const _ex: never = settlement;
        return _ex;
      }
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
