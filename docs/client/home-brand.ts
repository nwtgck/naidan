import { startHomeBrandMotion } from './home-brand-motion';

function start(): void {
  startHomeBrandMotion({ document, window });
}

if (document.querySelector('[data-docs-hero-brand]')) start();
else {
  switch (document.readyState) {
  case 'loading':
  case 'interactive': document.addEventListener('DOMContentLoaded', start, { once: true }); break;
  case 'complete': break;
  default: { const unreachable: never = document.readyState; throw new Error(`Unexpected document state: ${unreachable}`); }
  }
}
