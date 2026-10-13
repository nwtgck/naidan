import { DOCS_BASE } from '../site/routes';
import { selectDocsLocale } from '../site/locale';
import { startDocsPreferences } from './preferences';

// Every Docs page restores its native display controls before the body is painted.
// Only the language-neutral entrance mounts a pre-rendered language template.
startDocsPreferences({ document, window });
const url = new URL(window.location.href);
if (url.pathname === DOCS_BASE || url.pathname === `${DOCS_BASE}index.html` || url.pathname === DOCS_BASE.slice(0, -1)) {
  const html = document.documentElement;
  const locale = selectDocsLocale({ languages: navigator.languages.length ? navigator.languages : [navigator.language] });
  html.lang = locale;
  html.dataset.docsStarting = '';
  // A blocked script leaves the manual language links visible. This watchdog
  // also recovers that fallback if an unexpected initialization failure occurs.
  const watchdog = window.setTimeout(() => {
    delete html.dataset.docsStarting;
  }, 3000);
  const mount = (): void => {
    try {
      const template = document.querySelector<HTMLTemplateElement>(`template[data-docs-locale="${locale}"]`);
      const fallback = document.querySelector<HTMLElement>('[data-docs-language-fallback]');
      if (!template || !fallback || !template.dataset.title || !template.dataset.description) throw new Error('Missing pre-rendered Docs home');
      fallback.replaceWith(document.importNode(template.content, true));
      document.title = template.dataset.title;
      document.querySelector('meta[name="description"]')?.setAttribute('content', template.dataset.description);
      for (const other of document.querySelectorAll('template[data-docs-locale]')) other.remove();
      if (url.hash) {
        try {
          document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
        } catch { /* Keep malformed fragments harmless. */ }
      }
    } catch (error) {
      console.error('[Docs] Could not initialize the language-neutral home.', error);
    } finally {
      delete html.dataset.docsStarting;
      window.clearTimeout(watchdog);
    }
  };
  switch (document.readyState) {
  case 'loading': document.addEventListener('DOMContentLoaded', mount, { once: true }); break;
  case 'interactive':
  case 'complete': mount(); break;
  default: { const unreachable: never = document.readyState; throw new Error(`Unexpected document state: ${unreachable}`); }
  }
}
