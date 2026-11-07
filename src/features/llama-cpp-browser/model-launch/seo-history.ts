import { createWebHistory, type RouterHistory } from 'vue-router';
import { findModelSeoEntry, type ModelSeoEntry } from './seo-entries';

const modelQuery = 'llama-cpp-browser-model';

/** A presentation adapter; Vue Router still owns history state and popstate. */
export function createModelSeoHistory({ entry }: { entry: ModelSeoEntry }): RouterHistory {
  const initialSearch = window.location.search;
  // A pasted legacy route takes precedence, never combine two model selectors.
  if (window.location.hash.startsWith('#/')) {
    window.history.replaceState(window.history.state, '', `/${window.location.hash}`);
  }
  const delegate = createWebHistory('/');

  function toLogical({ location }: { location: string }): string {
    const url = new URL(location, window.location.origin);
    if (url.hash.startsWith('#/')) {
      return url.hash.slice(1);
    }
    const selected = findModelSeoEntry({ pathname: url.pathname });
    return selected === undefined ? '/' : `/?${new URLSearchParams({ [modelQuery]: selected.modelId })}`;
  }

  function toPhysical({ location }: { location: string }): string {
    // Only the entry route has a path representation. Other model links and
    // normal app routes keep their legacy fragment semantics in this session.
    const url = new URL(location, window.location.origin);
    if (url.pathname === '/' && url.hash === '' && [...url.searchParams].length === 1
      && url.searchParams.get(modelQuery) === entry.modelId) {
      return `${entry.pathname}${initialSearch}`;
    }
    return `/#${location}`;
  }

  return {
    base: '/',
    get location() {
      return toLogical({ location: delegate.location });
    },
    get state() {
      return delegate.state;
    },
    push(to, data) {
      delegate.push(toPhysical({ location: to }), data);
    },
    replace(to, data) {
      delegate.replace(toPhysical({ location: to }), data);
    },
    createHref(to) {
      return toPhysical({ location: to });
    },
    listen(callback) {
      return delegate.listen((to, from, information) => callback(toLogical({ location: to }), toLogical({ location: from }), information));
    },
    go: delegate.go,
    destroy: delegate.destroy,
  } satisfies RouterHistory;
}

export const TEST_ONLY = {
};
