import { createBuildDom } from './jsdom';
import type { ModelSeoEntry } from '../src/features/llama-cpp-browser/model-launch/seo-entries';
import { applyDocumentCanonicalUrl, applyDocumentMetadata } from '../src/logic/document-metadata';

/** Decorate the real Vite HTML; never duplicate the app's scripts or UI. */
export function renderModelSeoHtml({ html, entry }: { html: string, entry: ModelSeoEntry }): string {
  const dom = createBuildDom({ html, options: undefined });
  try {
    const { document } = dom.window;
    const app = document.querySelector('#app');
    if (!app) {
      throw new Error('Model SEO template is missing #app');
    }
    for (const existing of document.head.querySelectorAll('base')) {
      existing.remove();
    }
    const base = document.createElement('base');
    base.setAttribute('href', '/');
    // charset must remain first. The base precedes all URL-bearing tags.
    const charset = document.head.querySelector('meta[charset]');
    if (charset) {
      charset.after(base);
    } else {
      document.head.prepend(base);
    }
    applyDocumentMetadata({ document, page: entry.metadata, documentTitle: entry.metadata.title });
    applyDocumentCanonicalUrl({ document, canonicalUrl: entry.canonicalUrl });
    document.documentElement.lang = 'en';
    const main = document.createElement('main');
    const heading = document.createElement('h1');
    heading.textContent = `${entry.repository.split('/').slice(1).join('/').replace(/-gguf$/i, '')} ${entry.quantization}`;
    const description = document.createElement('p');
    description.textContent = entry.metadata.description;
    const reference = document.createElement('p');
    reference.textContent = `Hugging Face repository: ${entry.repository}. Quantization: ${entry.quantization}.`;
    const notice = document.createElement('p');
    notice.textContent = 'JavaScript is required to run this model. Review the model and its size, then choose Run in your browser to prepare it and start a chat.';
    main.append(heading, description, reference, notice);
    app.replaceChildren(main);
    return dom.serialize();
  } finally {
    dom.window.close();
  }
}

export function modelSeoNotFoundHtml(): string {
  return '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Page not found | Naidan</title></head><body><main><h1>Page not found</h1><p>This model page is not published.</p><a href="/#/">Open Naidan</a></main></body></html>';
}

export const TEST_ONLY = {
};
