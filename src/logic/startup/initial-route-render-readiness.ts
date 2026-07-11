import {
  inject,
  provide,
  type InjectionKey,
} from 'vue';
import { useRoute } from 'vue-router';

export interface InitialRouteRenderReadinessClaim {
  reportReady(): void,
  reportFailure({ error }: { error: unknown }): void,
  cancel(): void,
}

interface InitialRouteRenderReadinessCoordinator {
  claim({ routeKey }: { routeKey: string }): InitialRouteRenderReadinessClaim,
  reportRouteMounted({ routeKey }: { routeKey: string }): void,
}

const initialRouteRenderReadinessKey: InjectionKey<InitialRouteRenderReadinessCoordinator> = Symbol(
  'initial-route-render-readiness',
);

function createNoopClaim(): InitialRouteRenderReadinessClaim {
  return {
    reportReady(): void {},
    reportFailure(): void {},
    cancel(): void {},
  };
}

export function createInitialRouteRenderReadinessCoordinator({
  onReady,
  onFailure,
}: {
  onReady(): void,
  onFailure({ error }: { error: unknown }): void,
}): InitialRouteRenderReadinessCoordinator {
  const activeClaimsByRoute = new Map<string, Set<symbol>>();
  let mountedRouteKey: string | undefined;
  let settlement: 'pending' | 'ready' | 'failed' = 'pending';

  function settlementIsPending(): boolean {
    switch (settlement) {
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

  function activeClaimsFor({ routeKey }: { routeKey: string }): Set<symbol> | undefined {
    return activeClaimsByRoute.get(routeKey);
  }

  function finishWhenCurrentRouteIsReady({ routeKey }: { routeKey: string }): void {
    if (!settlementIsPending() || mountedRouteKey !== routeKey) {
      return;
    }
    const claims = activeClaimsFor({ routeKey });
    if (claims !== undefined && claims.size > 0) {
      return;
    }
    settlement = 'ready';
    onReady();
  }

  return {
    claim({ routeKey }): InitialRouteRenderReadinessClaim {
      if (!settlementIsPending()) {
        return createNoopClaim();
      }
      const token = Symbol(routeKey);
      const claims = activeClaimsFor({ routeKey }) ?? new Set<symbol>();
      claims.add(token);
      activeClaimsByRoute.set(routeKey, claims);
      let claimState: 'active' | 'ready' | 'failed' | 'cancelled' = 'active';

      function claimIsActive(): boolean {
        switch (claimState) {
        case 'active':
          return true;
        case 'ready':
        case 'failed':
        case 'cancelled':
          return false;
        default: {
          const _ex: never = claimState;
          return _ex;
        }
        }
      }

      function removeClaim(): void {
        const currentClaims = activeClaimsFor({ routeKey });
        currentClaims?.delete(token);
        if (currentClaims?.size === 0) {
          activeClaimsByRoute.delete(routeKey);
        }
      }

      return {
        reportReady(): void {
          if (!claimIsActive()) {
            return;
          }
          claimState = 'ready';
          removeClaim();
          finishWhenCurrentRouteIsReady({ routeKey });
        },
        reportFailure({ error }): void {
          if (!claimIsActive()) {
            return;
          }
          claimState = 'failed';
          removeClaim();
          // Ignore an async failure from a route that navigation has already
          // replaced. Only the route currently hidden behind the startup lock
          // is allowed to fail that lock's render gate.
          if (!settlementIsPending() || mountedRouteKey !== routeKey) {
            return;
          }
          settlement = 'failed';
          onFailure({ error });
        },
        cancel(): void {
          if (!claimIsActive()) {
            return;
          }
          claimState = 'cancelled';
          removeClaim();
          // Cancellation normally means a redirect or unmount. Do not mark
          // the old route ready; the replacement route's mount signal owns the
          // decision instead.
        },
      };
    },
    reportRouteMounted({ routeKey }): void {
      if (!settlementIsPending()) {
        return;
      }
      mountedRouteKey = routeKey;
      finishWhenCurrentRouteIsReady({ routeKey });
    },
  };
}

export function provideInitialRouteRenderReadiness({
  onReady,
  onFailure,
}: {
  onReady(): void,
  onFailure({ error }: { error: unknown }): void,
}): Pick<InitialRouteRenderReadinessCoordinator, 'reportRouteMounted'> {
  const coordinator = createInitialRouteRenderReadinessCoordinator({
    onReady,
    onFailure,
  });
  provide(initialRouteRenderReadinessKey, coordinator);
  return {
    reportRouteMounted: coordinator.reportRouteMounted,
  };
}

/**
 * Claims responsibility for the initial route's visual readiness.
 *
 * Most routes need no claim: their Vue mount is sufficient. Routes that must
 * finish asynchronous preparation before their real content exists, such as a
 * chat deep link, claim the boundary and report only after that preparation
 * and its resulting DOM update complete. This keeps the encrypted lock screen
 * visible until the page underneath is genuinely ready rather than merely
 * mounted.
 */
export function useInitialRouteRenderReadinessClaim(): InitialRouteRenderReadinessClaim {
  const coordinator = inject(initialRouteRenderReadinessKey, undefined);
  if (coordinator === undefined) {
    // Route components are also mounted in focused unit tests and previews
    // without MainAppSurface. In that context there is no startup presentation
    // to coordinate, so readiness reporting is intentionally a no-op.
    return createNoopClaim();
  }
  const route = useRoute();
  return coordinator.claim({ routeKey: route.fullPath });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
