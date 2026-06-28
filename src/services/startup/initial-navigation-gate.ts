import type { Router } from 'vue-router';

export type InitialNavigationGate = Readonly<{
  release: () => void,
}>;

export function createInitialNavigationGate({ router }: {
  router: Router,
}): InitialNavigationGate {
  const { promise, resolve } = Promise.withResolvers<void>();
  let state:
    | 'waiting'
    | 'released' = 'waiting';

  /**
   * WHY: Local profiling attributed roughly 0.96 s of onboarding startup to
   * initial route resolution, and excluding the normal route reduced the
   * onboarding DOM insertion time from about 1.81 s to 0.69 s. The guard delays
   * route component loading only; after onboarding, every user still rejoins
   * the same router and normal app initialization path.
   */
  const removeGuard = router.beforeEach(async () => {
    await promise;
    return true;
  });

  return {
    release: () => {
      switch (state) {
      case 'waiting':
        state = 'released';
        removeGuard();
        resolve();
        return;
      case 'released':
        return;
      default: {
        const _ex: never = state;
        return _ex;
      }
      }
    },
  };
}
