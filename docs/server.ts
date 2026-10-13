import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { pages, common } from 'virtual:naidan-docs/registry';
import DocLayout from './site/DocLayout.vue';
import type { DocsLocale, DocsPageId } from './site/routes';
import type { RenderedPage } from './build/contracts';

// Identical application construction in development and production. Locale data
// belongs to this render, never to a mutable module-level "current locale".
export async function renderPage({ locale, page }: { locale: DocsLocale; page: DocsPageId }): Promise<RenderedPage> {
  const entry = pages[page];
  // Give each render its own plain data. An accidental mutation by an authored
  // component cannot affect a later page, language or concurrent request.
  const messages = structuredClone(entry.messages[locale]);
  const layoutMessages = structuredClone(common[locale]);
  const app = createSSRApp({
    render: () => h(DocLayout, { locale, page, s: layoutMessages }, {
      default: () => h(entry.component, { s: messages, locale }),
    }),
  });
  app.config.errorHandler = error => {
    throw error;
  };
  app.config.warnHandler = message => {
    throw new Error(`[Docs render] ${message}`);
  };
  const body = await renderToString(app);
  return { body, title: messages.title, description: messages.description, locale, page };
}
