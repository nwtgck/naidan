import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import {
  readFirstQueryValue,
  resolveInitialRoute,
} from './startup-route';

describe('startup route', () => {
  it('resolves the current history location without starting navigation', () => {
    const history = createMemoryHistory();
    history.replace('/?storage-type=opfs&data-zip=encoded');
    const router = createRouter({
      history,
      routes: [{ path: '/', component: { template: '<div />' } }],
    });

    const route = resolveInitialRoute({ router });

    expect(route.query['storage-type']).toBe('opfs');
    expect(route.query['data-zip']).toBe('encoded');
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('reads the first meaningful query value', () => {
    expect(readFirstQueryValue({ value: ['first', 'second'] })).toBe('first');
    expect(readFirstQueryValue({ value: null })).toBeUndefined();
    expect(readFirstQueryValue({ value: undefined })).toBeUndefined();
  });
});
