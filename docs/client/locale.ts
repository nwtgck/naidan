import { DOCS_BASE } from '../site/routes';
import { selectDocsLocale } from '../site/locale';
import '../site/site.css';

// Root only. Explicit language URLs always win over browser preferences.
const url = new URL(window.location.href);
if (url.pathname === DOCS_BASE || url.pathname === `${DOCS_BASE}index.html`) {
  const locale = selectDocsLocale({ languages: navigator.languages.length ? navigator.languages : [navigator.language] });
  url.pathname = `${DOCS_BASE}${locale}/`;
  window.location.replace(url.href);
}
