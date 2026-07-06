export type RefreshCoordinator<TContext> = {
  request({ context }: { context: TContext }): Promise<void>;
  hasPendingRefresh(): boolean;
};

type RefreshWaiter = {
  generation: number;
  resolve(): void;
  reject(error: unknown): void;
};

export function createRefreshCoordinator<TContext>({ refresh }: {
  refresh({ context }: { context: TContext }): Promise<void>;
}): RefreshCoordinator<TContext> {
  let requestedGeneration = 0;
  let completedGeneration = 0;
  let latestRequest: { generation: number; context: TContext } | undefined;
  let runner: Promise<void> | undefined;
  const waiters: RefreshWaiter[] = [];

  function settleWaiters({ generation, error }: {
    generation: number,
    error: unknown | undefined,
  }): void {
    const completedWaiters = waiters.filter((waiter) => waiter.generation <= generation);
    const remainingWaiters = waiters.filter((waiter) => waiter.generation > generation);
    waiters.splice(0, waiters.length, ...remainingWaiters);
    for (const waiter of completedWaiters) {
      if (error === undefined) waiter.resolve();
      else waiter.reject(error);
    }
  }

  async function runRefreshLoop(): Promise<void> {
    while (completedGeneration < requestedGeneration) {
      const request = latestRequest;
      if (request === undefined) {
        const generation = requestedGeneration;
        completedGeneration = generation;
        settleWaiters({
          generation,
          error: new Error('[tw-class] Refresh request was not initialized.'),
        });
        continue;
      }
      const { generation, context } = request;
      try {
        await refresh({ context });
        completedGeneration = generation;
        settleWaiters({ generation, error: undefined });
      } catch (error) {
        completedGeneration = generation;
        settleWaiters({ generation, error });
      }
    }
  }

  function ensureRunner(): void {
    if (runner !== undefined) return;
    // Vite may deliver several filesystem events in the same turn. Starting in a
    // microtask lets those requests share one refresh using the latest context.
    runner = Promise.resolve()
      .then(() => runRefreshLoop())
      .finally(() => {
        runner = undefined;
        if (completedGeneration < requestedGeneration) ensureRunner();
      });
  }

  return {
    request({ context }) {
      requestedGeneration += 1;
      const generation = requestedGeneration;
      latestRequest = { generation, context };
      const result = new Promise<void>((resolve, reject) => {
        waiters.push({ generation, resolve, reject });
      });
      ensureRunner();
      return result;
    },
    hasPendingRefresh() {
      return completedGeneration < requestedGeneration;
    },
  };
}
