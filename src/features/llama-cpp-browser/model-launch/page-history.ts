import { createWebHistory, type RouterHistory } from 'vue-router';
import { modelPageLocation, readModelPageRequest } from './page-url';

const modelQuery = 'llama-cpp-browser-model';

/** A presentation adapter; Vue Router still owns history state and popstate. */
export function createModelPageHistory(): RouterHistory {
  const appBase = modelPageLocation({ pathname: window.location.pathname })?.appBase ?? '/';
  // A pasted legacy route takes precedence, never combine two model selectors.
  if (window.location.hash.startsWith('#/')) {
    window.history.replaceState(window.history.state, '', `${appBase}${window.location.hash}`);
  }
  const initialPhysical = `${window.location.pathname.slice(appBase.length - 1)}${window.location.search}${window.location.hash}`;
  const initialRequest = readModelPageRequest({ pathname: window.location.pathname, search: window.location.search });
  const initialInput = (() => {
    switch (initialRequest.kind) {
    case 'model': return initialRequest.launchInput;
    case 'invalid': case 'outside': return '';
    default: {
      const exhaustive: never = initialRequest;
      return exhaustive;
    }
    }
  })();
  const delegate = createWebHistory(appBase);

  function toLogical({ location }: { location: string }): string {
    const url = new URL(location, window.location.origin);
    if (url.hash.startsWith('#/')) {
      return url.hash.slice(1);
    }
    const request = readModelPageRequest({ pathname: url.pathname, search: url.search });
    switch (request.kind) {
    case 'model': return `/?${new URLSearchParams({ [modelQuery]: request.launchInput })}`;
    // The existing repair UI handles invalid inputs without fetching a model.
    case 'invalid': return `/?${new URLSearchParams({ [modelQuery]: '' })}`;
    case 'outside': return '/';
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
    }
  }

  function toPhysical({ location }: { location: string }): string {
    const url = new URL(location, window.location.origin);
    if (initialRequest.kind !== 'outside' && url.pathname === '/' && url.hash === ''
      && [...url.searchParams].length === 1 && url.searchParams.get(modelQuery) === initialInput) {
      return initialPhysical;
    }
    // Other model links and app routes retain their fragment semantics.
    return `/#${location}`;
  }

  return {
    base: delegate.base,
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
      return delegate.createHref(toPhysical({ location: to }));
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
