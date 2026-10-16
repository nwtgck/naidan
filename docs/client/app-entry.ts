import { updateAppEntryLinks } from './app-entry-enhancement';

const update = () => updateAppEntryLinks({ document, locationHref: window.location.href });

switch (document.readyState) {
case 'loading': document.addEventListener('DOMContentLoaded', update, { once: true });
  break;
case 'interactive':
  // The language-neutral home is still a fallback until the classic locale bootstrap mounts its template.
  if (document.querySelector('[data-docs-language-fallback]')) {
    document.addEventListener('DOMContentLoaded', update, { once: true });
  } else {
    update();
  }
  break;
case 'complete': update();
  break;
default: {
  const unreachable: never = document.readyState;
  throw new Error(`Unexpected document state: ${unreachable}`);
}
}
