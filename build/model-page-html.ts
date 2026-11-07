import { createBuildDom } from './jsdom';
import { MODEL_PAGE_PREFIX } from '../src/features/llama-cpp-browser/model-launch/page-url';
import type { ModelPageEntry } from '../src/features/llama-cpp-browser/model-launch/page-entries';
import { applyDocumentCanonicalUrl, applyDocumentMetadata } from '../src/logic/document-metadata';

/** Resolve before parser-discovered scripts/styles. Do not pin ZIPs to /. */
function installHostedBase({ document, entry }: { document: Document, entry: ModelPageEntry | undefined }): void {
  for (const previous of document.head.querySelectorAll('base, script[data-naidan-hosted-base]')) {
    previous.remove();
  }
  const base = document.createElement('base');
  base.setAttribute('data-naidan-hosted-base', '');
  // A directory index has a useful no-JS base too, even under /my-naidan/.
  base.setAttribute('href', entry === undefined ? './' : '../'.repeat(entry.pathname.split('/').filter(Boolean).length));
  const bootstrap = document.createElement('script');
  bootstrap.setAttribute('data-naidan-hosted-base', '');
  // The namespace rule mirrors modelPageLocation; tests check both against
  // the same mounted paths. No user text is interpolated into this script.
  bootstrap.textContent = `\
(function () {
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return;
  var pathname = location.pathname;
  var prefix = ${JSON.stringify(MODEL_PAGE_PREFIX)};
  var index = pathname.indexOf(prefix);
  if (index < 0 && pathname.endsWith(prefix.slice(0, -1))) {
    index = pathname.length - prefix.length + 1;
  }
  var url = new URL(location.href);
  if (index >= 0 && pathname.startsWith('/') && !pathname.startsWith('//')) {
    url.pathname = pathname.slice(0, index + 1);
  } else if (pathname.endsWith('/') || pathname.endsWith('/index.html')) {
    url = new URL('./', url);
  } else {
    // An unmatched, non-directory path uses a root-hosted SPA fallback.
    // Subdirectory mounts must expose their directory/index.html entry.
    url.pathname = '/';
  }
  url.search = '';
  url.hash = '';
  document.querySelector('base[data-naidan-hosted-base]').href = url.href;
})();`;
  const charset = document.head.querySelector('meta[charset]');
  if (charset) {
    document.head.prepend(charset, base, bootstrap);
  } else {
    document.head.prepend(base, bootstrap);
  }
}

function renderPublicHtml({ html, entry }: { html: string, entry: ModelPageEntry | undefined }): string {
  const dom = createBuildDom({ html, options: undefined });
  try {
    const { document } = dom.window;
    const app = document.querySelector('#app');
    if (!app) {
      throw new Error('Model page template is missing #app');
    }
    installHostedBase({ document, entry });
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
      home.setAttribute('href', './#/');
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

/** Shared hosted entry, also used by a static server's SPA fallback. */
export function renderPublicAppHtml({ html }: { html: string }): string {
  return renderPublicHtml({ html, entry: undefined });
}

export const TEST_ONLY = {
};
