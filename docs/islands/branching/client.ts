import { createSSRApp } from 'vue';
import type { App } from 'vue';
import BranchingDemo from './BranchingDemo.vue';
import { parseBranchingPayload } from './contracts';

export function hydrateBranchingDemos({ document }: { document: Document }): App<Element>[] {
  const apps: App<Element>[] = [];
  for (const root of document.querySelectorAll<HTMLElement>('[data-docs-island="branching"]')) {
    if (root.dataset.docsHydrated === 'ready') continue;
    let app: App<Element> | undefined;
    let mounted = false;
    let staticHtml: string | undefined;
    try {
      const raw = root.getAttribute('data-docs-props');
      if (!raw) throw new Error('Missing branching demonstration props');
      const payload = parseBranchingPayload({ serialized: raw });
      staticHtml = root.innerHTML;
      app = createSSRApp(BranchingDemo, payload);
      let hydrationError: unknown;
      let hydrationFailed = false;
      app.config.errorHandler = error => {
        hydrationFailed = true;
        hydrationError = error;
      };
      app.mount(root);
      mounted = true;
      if (hydrationFailed) throw hydrationError;
      app.config.errorHandler = error => console.error('[Docs interaction]', error);
      root.dataset.docsHydrated = 'ready';
      apps.push(app);
    } catch (error) {
      if (mounted) {
        try {
          app?.unmount();
        } catch (cleanupError) {
          console.error('[Docs interaction] Could not stop failed branching demonstration.', cleanupError);
        }
      }
      if (staticHtml !== undefined) root.innerHTML = staticHtml;
      delete root.dataset.docsHydrated;
      // Restore the readable, disabled pre-rendered demonstration after a failed mount.
      console.error('[Docs interaction] Could not start branching demonstration.', error);
    }
  }
  return apps;
}

switch (document.readyState) {
case 'loading':
  document.addEventListener('DOMContentLoaded', () => hydrateBranchingDemos({ document }), { once: true });
  break;
case 'interactive':
case 'complete':
  hydrateBranchingDemos({ document });
  break;
default: {
  const unreachable: never = document.readyState;
  throw new Error(`Unsupported document state: ${unreachable}`);
}
}
