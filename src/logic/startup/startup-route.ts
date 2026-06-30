import type { RouteLocationResolved, Router } from 'vue-router';

export function resolveInitialRoute({ router }: {
  router: Router,
}): RouteLocationResolved {
  return router.resolve(router.options.history.location || '/');
}

export function readFirstQueryValue({ value }: {
  value: string | null | (string | null)[] | undefined,
}): string | undefined {
  const firstValue = Array.isArray(value) ? value[0] : value;
  return firstValue ?? undefined;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
