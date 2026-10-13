import { createSSRApp } from 'vue';
import type { App } from 'vue';
import BranchingDemo from './BranchingDemo.vue';
import { branchingPayloadSchema } from '../../site/messages';

export function hydrateBranchingDemos({ document }: { document: Document }): App<Element>[] {
  const apps: App<Element>[] = [];
  for (const root of document.querySelectorAll<HTMLElement>('[data-docs-island="branching"]')) {
    if (root.dataset.docsHydrated === 'ready') continue;
    try {
      const raw = root.getAttribute('data-docs-props');
      if (!raw) throw new Error('Missing branching demonstration props');
      const input: unknown = JSON.parse(raw);
      const payload = branchingPayloadSchema.parse(input);
      const app = createSSRApp(BranchingDemo, payload);
      app.config.errorHandler = error => console.error('[Docs interaction]', error);
      app.mount(root);
      root.dataset.docsHydrated = 'ready';
      apps.push(app);
    } catch (error) {
      // Leave the readable pre-rendered demonstration in place if startup fails.
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
