import { DOCS_BASE, DOCS_LOCALES } from '../navigation/routes';
import { selectDocsLocale } from '../navigation/locale';
import { startDocsPreferences } from './preferences';

// Every Docs page restores its native display controls before the body is painted.
// Only the language-neutral entrance mounts a pre-rendered language template.
const motionPreference = startDocsPreferences({ document, window });
const url = new URL(window.location.href);
const neutralHome = url.pathname === DOCS_BASE || url.pathname === `${DOCS_BASE}index.html` || url.pathname === DOCS_BASE.slice(0, -1);
const localizedHome = DOCS_LOCALES.some(locale => url.pathname === `${DOCS_BASE}${locale}/` || url.pathname === `${DOCS_BASE}${locale}/index.html`);
const html = document.documentElement;
let brandPending = false;
if ((neutralHome || localizedHome) && motionPreference === 'auto' && typeof window.matchMedia === 'function') {
  try {
    brandPending = !window.matchMedia('(max-width: 480px)').matches
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { /* Keep the complete static home if media queries are unavailable. */ }
}
if (neutralHome || localizedHome) {
  html.dataset.docsHomeBrandStartup = brandPending ? 'pending' : 'ready';
}
if (neutralHome) {
  html.dataset.docsStarting = '';
}

// One bounded recovery covers a blocked home client and the neutral entrance.
const watchdog = neutralHome || brandPending ? window.setTimeout(() => {
  delete html.dataset.docsStarting;
  if (html.dataset.docsHomeBrandStartup === 'pending') {
    html.dataset.docsHomeBrandStartup = 'aborted';
  }
}, 3000) : undefined;
if (brandPending) {
  window.addEventListener('load', () => {
    if (html.dataset.docsHomeBrandStartup === 'pending') {
      html.dataset.docsHomeBrandStartup = 'aborted';
    }
    if (watchdog !== undefined) {
      window.clearTimeout(watchdog);
    }
  }, { once: true });
}

if (neutralHome) {
  const locale = selectDocsLocale({ languages: navigator.languages.length ? navigator.languages : [navigator.language] });
  html.lang = locale;
  // A blocked script leaves the manual language links visible. This watchdog
  // also recovers that fallback if an unexpected initialization failure occurs.
  const mount = (): void => {
    try {
      const template = document.querySelector<HTMLTemplateElement>(`template[data-docs-locale="${locale}"]`);
      const fallback = document.querySelector<HTMLElement>('[data-docs-language-fallback]');
      if (!template || !fallback || !template.dataset.title || !template.dataset.description) {
        throw new Error('Missing pre-rendered Docs home');
      }
      fallback.replaceWith(document.importNode(template.content, true));
      document.title = template.dataset.title;
      document.querySelector('meta[name="description"]')?.setAttribute('content', template.dataset.description);
      for (const other of document.querySelectorAll('template[data-docs-locale]')) {
        other.remove();
      }
      if (url.hash) {
        try {
          document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
        } catch { /* Keep malformed fragments harmless. */ }
      }
    } catch (error) {
      console.error('[Docs] Could not initialize the language-neutral home.', error);
    } finally {
      delete html.dataset.docsStarting;
      if (html.dataset.docsHomeBrandStartup !== 'pending' && watchdog !== undefined) {
        window.clearTimeout(watchdog);
      }
    }
  };
  switch (document.readyState) {
  case 'loading': document.addEventListener('DOMContentLoaded', mount, { once: true });
    break;
  case 'interactive':
  case 'complete': mount();
    break;
  default: {
    const unreachable: never = document.readyState;
    throw new Error(`Unexpected document state: ${unreachable}`);
  }
  }
}
