import { createSSRApp } from 'vue';
import type { App } from 'vue';
import SearchIsland from './SearchIsland.vue';
import { parseSearchPayload } from './contracts';

export function hydrateSearch({ document }: { document: Document }): App<Element>[] {
  const apps: App<Element>[] = [];
  for (const root of document.querySelectorAll<HTMLElement>('[data-docs-island="search"]')) {
    if (root.dataset.docsHydrated === 'ready') continue;
    let app: App<Element> | undefined;
    let mounted = false;
    let staticHtml: string | undefined;
    try {
      const raw = root.getAttribute('data-docs-props');
      if (!raw) throw new Error('Missing Docs search props');
      const payload = parseSearchPayload({ serialized: raw });
      staticHtml = root.innerHTML;
      app = createSSRApp(SearchIsland, payload);
      let hydrationError: unknown;
      let hydrationFailed = false;
      app.config.errorHandler = error => {
        hydrationFailed = true;
        hydrationError = error;
      };
      app.mount(root);
      mounted = true;
      if (hydrationFailed) throw hydrationError;
      app.config.errorHandler = error => console.error('[Docs search]', error);
      root.dataset.docsHydrated = 'ready';
      apps.push(app);
    } catch (error) {
      if (mounted) app?.unmount();
      if (staticHtml !== undefined) root.innerHTML = staticHtml;
      delete root.dataset.docsHydrated;
      console.error('[Docs search] Could not start search.', error);
    }
  }
  return apps;
}

switch (document.readyState) {
case 'loading':
case 'interactive':
  document.addEventListener('DOMContentLoaded', () => hydrateSearch({ document }), { once: true });
  break;
case 'complete':
  hydrateSearch({ document });
  break;
default: {
  const unreachable: never = document.readyState;
  throw new Error(`Unsupported document state: ${unreachable}`);
}
}
