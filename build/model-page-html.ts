import { createBuildDom } from './jsdom';
import type { ModelPageEntry } from '../src/features/llama-cpp-browser/model-launch/page-entries';
import { applyDocumentCanonicalUrl, applyDocumentMetadata } from '../src/logic/document-metadata';

function renderPublicHtml({ html, entry }: { html: string, entry: ModelPageEntry | undefined }): string {
  const dom = createBuildDom({ html, options: undefined });
  try {
    const { document } = dom.window;
    const app = document.querySelector('#app');
    if (!app) {
      throw new Error('Model page template is missing #app');
    }
    for (const existing of document.head.querySelectorAll('base')) {
      existing.remove();
    }
    const base = document.createElement('base');
    base.setAttribute('href', '/');
    // The public app shell also handles unknown deep paths. Portable packages
    // retain their original relative base; only this publication is decorated.
    const charset = document.head.querySelector('meta[charset]');
    if (charset) {
      charset.after(base);
    } else {
      document.head.prepend(base);
    }
    if (entry !== undefined) {
      applyDocumentMetadata({ document, page: entry.metadata, documentTitle: entry.metadata.title });
      applyDocumentCanonicalUrl({ document, canonicalUrl: entry.canonicalUrl });
      document.documentElement.lang = 'en';
      const main = document.createElement('main');
      main.setAttribute('data-model-page-fallback', '');
      const heading = document.createElement('h1');
      heading.textContent = entry.label;
      const description = document.createElement('p');
      description.textContent = entry.metadata.description;
      const reference = document.createElement('p');
      reference.textContent = `Hugging Face repository: ${entry.repository}.`;
      const notice = document.createElement('p');
      notice.textContent = 'JavaScript is required to run this model. Review the model and its size, then choose Run in your browser to prepare it and start a chat. If the app does not load, reload this page or open Naidan.';
      const home = document.createElement('a');
      home.setAttribute('href', '/#/');
      home.textContent = 'Open Naidan';
      main.append(heading, description, reference, notice, home);
      app.replaceChildren(main);
      for (const previous of document.head.querySelectorAll('[data-model-page-fallback-style]')) {
        previous.remove();
      }
      const style = document.createElement('style');
      style.setAttribute('data-model-page-fallback-style', '');
      // Hide ONLY the replaceable fallback, before the first paint. Restore it
      // even when enabled scripts fail to load; no second bootstrap is needed.
      // This is a delayed visibility switch, not moving/reduced-motion content.
      style.textContent = `\
@media (scripting: enabled) {
  #app > [data-model-page-fallback] {
    visibility: hidden;
    animation: naidan-model-page-fallback-reveal 0s 8s forwards;
  }
}
@keyframes naidan-model-page-fallback-reveal {
  to { visibility: visible; }
}`;
      document.head.append(style);
    }
    return dom.serialize();
  } finally {
    dom.window.close();
  }
}

/** Decorate the real Vite HTML; never duplicate the app's scripts or UI. */
export function renderModelPageHtml({ html, entry }: { html: string, entry: ModelPageEntry }): string {
  return renderPublicHtml({ html, entry });
}

/** Shared root response for Cloudflare's static SPA fallback, not per-request SSR. */
export function renderPublicAppHtml({ html }: { html: string }): string {
  return renderPublicHtml({ html, entry: undefined });
}

export const TEST_ONLY = {
};
