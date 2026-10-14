import { createSSRApp } from 'vue';
import type { App } from 'vue';
import BrowserAiAvailability from './BrowserAiAvailability.vue';
import { parseBrowserAiAvailabilityPayload } from './contracts';

export function hydrateBrowserAiAvailability({ document }: { document: Document }): App<Element>[] {
  const apps: App<Element>[] = [];
  for (const root of document.querySelectorAll<HTMLElement>('[data-docs-island="browser-ai-availability"]')) {
    if (root.dataset.docsHydrated === 'ready') continue;
    let app: App<Element> | undefined;
    let mounted = false;
    let staticHtml: string | undefined;
    try {
      const serialized = root.getAttribute('data-docs-props');
      if (!serialized) throw new Error('Missing browser AI availability props');
      const payload = parseBrowserAiAvailabilityPayload({ serialized });
      staticHtml = root.innerHTML;
      app = createSSRApp(BrowserAiAvailability, payload);
      let hydrationError: unknown;
      let hydrationFailed = false;
      app.config.errorHandler = error => {
        hydrationFailed = true;
        hydrationError = error;
      };
      app.mount(root);
      mounted = true;
      if (hydrationFailed) throw hydrationError;
      app.config.errorHandler = error => console.error('[Docs browser AI availability]', error);
      root.dataset.docsHydrated = 'ready';
      apps.push(app);
    } catch (error) {
      if (mounted) {
        try {
          app?.unmount();
        } catch (cleanupError) {
          console.error('[Docs browser AI availability] Could not stop failed checker.', cleanupError);
        }
      }
      if (staticHtml !== undefined) root.innerHTML = staticHtml;
      delete root.dataset.docsHydrated;
      console.error('[Docs browser AI availability] Could not start checker.', error);
    }
  }
  return apps;
}

switch (document.readyState) {
case 'loading':
  document.addEventListener('DOMContentLoaded', () => hydrateBrowserAiAvailability({ document }), { once: true });
  break;
case 'interactive':
case 'complete':
  hydrateBrowserAiAvailability({ document });
  break;
default: {
  const unreachable: never = document.readyState;
  throw new Error(`Unsupported document state: ${unreachable}`);
}
}
