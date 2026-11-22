import { expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from 'vue-router/auto-routes';

it('registers translation as one workspace and removes the separate model page', () => {
  const router = createRouter({ history: createMemoryHistory(), routes });
  expect(router.resolve('/translation?from=ja&to=en#detail').name).toBe('/translation');
  expect(router.getRoutes().some(route => route.path === '/translation/models')).toBe(false);
});
