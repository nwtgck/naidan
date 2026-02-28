import { Marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import createDOMPurify from 'dompurify';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import 'katex/dist/katex.min.css';

// Import custom extensions from the extensions/ directory to keep this file lean.
import { detailsExtension } from './extensions/details';

const DOMPurify = (() => {
  const t = typeof window;
  switch (t) {
  case 'undefined': return createDOMPurify();
  case 'object':
  case 'boolean':
  case 'string':
  case 'number':
  case 'function':
  case 'symbol':
  case 'bigint':
    return createDOMPurify(window);
  default: {
    const _ex: never = t;
    return _ex;
  }
  }
})();

export const marked = new Marked();

// Register extensions. Add new extensions to the ./extensions directory.
marked.use({
  extensions: [
    detailsExtension,
  ],
});

marked.use(markedKatex({
  throwOnError: false,
  output: 'html',
}));

export const sanitizeHtml = ({ html }: { html: string }): string => {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true },
    FORBID_ATTR: ['onerror', 'onclick', 'onload'],
    ADD_ATTR: ['target'],
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|blob|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  });
};

export const highlightCode = ({ code, lang }: { code: string, lang: string }): string => {
  const language = hljs.getLanguage(lang) ? lang : 'plaintext';
  return hljs.highlight(code, { language }).value;
};
