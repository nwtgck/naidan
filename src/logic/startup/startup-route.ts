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
