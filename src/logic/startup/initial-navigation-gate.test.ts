import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createInitialNavigationGate } from './initial-navigation-gate';

describe('initial navigation gate', () => {
  it('prevents lazy route component loading until released', async () => {
    const loadRouteComponent = vi.fn(async () => ({
      template: '<div />',
    }));
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: loadRouteComponent }],
    });
    const gate = createInitialNavigationGate({ router });

    const navigation = router.push('/');
    await Promise.resolve();
    await Promise.resolve();

    expect(loadRouteComponent).not.toHaveBeenCalled();

    gate.release();
    await navigation;

    expect(loadRouteComponent).toHaveBeenCalledOnce();
  });

  it('can be released more than once without changing navigation behavior', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    });
    const gate = createInitialNavigationGate({ router });
    const navigation = router.push('/');

    gate.release();
    gate.release();
    await navigation;

    expect(router.currentRoute.value.path).toBe('/');
  });
});
