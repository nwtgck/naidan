import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { pages, common } from 'virtual:naidan-docs/registry';
import DocLayout from './components/DocLayout.vue';
import type { DocsLocale, DocsPageId } from './navigation/routes';
import type { RenderedPage } from './build/contracts';

// Identical application construction in development and production. Locale data
// belongs to this render, never to a mutable module-level "current locale".
export async function renderPage({ locale, page }: { locale: DocsLocale; page: DocsPageId }): Promise<RenderedPage> {
  try {
    const entry = pages[page];
    const component = (await entry.component()).default;
    // Article dictionaries contain plain scalar values and pure functions. Copy
    // their fields per render; each rich function creates fresh VNodes or lists.
    const messages = { ...(await entry.messages[locale]()).messages };
    // Common dictionaries follow the same contract; nested navigation data is read-only.
    const layoutMessages = { ...(await common[locale]()).messages };
    const app = createSSRApp({
      render: () => h(DocLayout, { locale, page, s: layoutMessages }, {
        default: () => h(component, { s: messages, locale, common: layoutMessages }),
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
  } catch (error) {
    throw new Error(`Docs ${locale}/${page} failed: ${String(error)}`, { cause: error });
  }
}
