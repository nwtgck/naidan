import { Marked, type Token, type Tokens } from 'marked';
import markedKatex from 'marked-katex-extension';
import createDOMPurify from 'dompurify';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import 'katex/dist/katex.min.css';

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

// Configure highlight.js if needed (already configured in global)
// We might need to handle specific languages if they are not loaded by default,
// but MessageItem seemed to rely on the default build.

export const marked = new Marked();

// Custom extension for <details> support
marked.use({
  extensions: [
    {
      name: 'details',
      level: 'block',
      start(src) {
        return src.match(/<details>/)?.index;
      },
      tokenizer(src) {
        const rule = /^<details>([\s\S]*?)<\/details>/;
        const match = rule.exec(src);
        if (match) {
          const raw = match[0];
          const content = match[1];

          // Extract summary if exists
          const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(content);
          const summary = summaryMatch ? summaryMatch[1] : '';
          const body = summaryMatch ? content.replace(summaryMatch[0], '') : content;

          return {
            type: 'details',
            raw,
            summary,
            tokens: this.lexer.blockTokens(body.trim(), []),
          };
        }
        return undefined;
      },
    },
  ],
});

marked.use(markedKatex({
  throwOnError: false,
  output: 'html',
}));

// We only need inline parsing for block components, as the structure is handled by Vue
// However, marked.parseInline is still useful for Paragraphs and List Items.

export const sanitizeHtml = ({ html }: { html: string }): string => {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true },
    FORBID_ATTR: ['onerror', 'onclick', 'onload'],
    ADD_ATTR: ['target'], // Allow target="_blank" for links
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|blob|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  });
};

export const highlightCode = ({ code, lang }: { code: string, lang: string }): string => {
  const language = hljs.getLanguage(lang) ? lang : 'plaintext';
  return hljs.highlight(code, { language }).value;
};
