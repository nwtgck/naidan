import { updateAppEntryLinks } from './app-entry-enhancement';

const update = () => updateAppEntryLinks({ document, locationHref: window.location.href });

switch (document.readyState) {
case 'loading': document.addEventListener('DOMContentLoaded', update, { once: true }); break;
case 'interactive':
case 'complete': update(); break;
default: { const unreachable: never = document.readyState; throw new Error(`Unexpected document state: ${unreachable}`); }
}
