import createDOMPurify from 'dompurify';
import type { ExternalImagePayload } from './markdownExternalImage';
import { decodeExternalImagePayload, encodeExternalImagePayload } from './markdownExternalImage';

declare const allowedHtmlBrand: unique symbol;

export type AllowedHtml = string & {
  readonly [allowedHtmlBrand]: true;
};

export type MarkdownInlinePart =
  | { type: 'html'; html: AllowedHtml }
  | { type: 'image'; payload: ExternalImagePayload };

type MarkdownLinkKind =
  | 'external-http'
  | 'same-origin-http'
  | 'non-http'
  | 'invalid';

function getCurrentPageHref(): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return window.location.href;
}

function classifyMarkdownLink({
  href,
  currentPageHref,
}: {
  href: string;
  currentPageHref: string | undefined;
}): MarkdownLinkKind {
  try {
    const url = currentPageHref === undefined
      ? new URL(href)
      : new URL(href, currentPageHref);

    switch (url.protocol) {
    case 'http:':
    case 'https:': {
      if (currentPageHref === undefined) {
        return 'external-http';
      }

      const currentPageUrl = new URL(currentPageHref);
      return url.origin === currentPageUrl.origin
        ? 'same-origin-http'
        : 'external-http';
    }
    default:
      return 'non-http';
    }
  } catch {
    return 'invalid';
  }
}

function createDOMPurifyForCurrentWindow() {
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
}

const markdownDOMPurify = createDOMPurifyForCurrentWindow();
const highlightDOMPurify = createDOMPurifyForCurrentWindow();

markdownDOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName !== 'A' || !(node instanceof Element)) {
    return;
  }

  const href = node.getAttribute('href');

  // Normalize author- or model-provided navigation attributes so all Markdown
  // links follow Naidan's policy rather than trusting raw HTML attributes.
  node.removeAttribute('target');
  node.removeAttribute('rel');
  node.removeAttribute('referrerpolicy');
  node.removeAttribute('data-naidan-external-link');

  if (!href) {
    return;
  }

  const kind = classifyMarkdownLink({
    href,
    currentPageHref: getCurrentPageHref(),
  });

  switch (kind) {
  case 'external-http':
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
    node.setAttribute('referrerpolicy', 'no-referrer');
    node.setAttribute('data-naidan-external-link', 'true');
    return;
  case 'same-origin-http':
  case 'non-http':
  case 'invalid':
    return;
  default: {
    const _ex: never = kind;
    return _ex;
  }
  }
});

markdownDOMPurify.addHook('afterSanitizeElements', (node) => {
  // Convert sanitized Markdown <img> tags to a Vue-hydrated custom placeholder.
  // The placeholder is split out before rendering through AllowedHtmlView, so
  // the final DOM uses ExternalImage.vue rather than raw markdown image HTML.
  if (node.nodeName === 'IMG' && node instanceof Element && node.ownerDocument) {
    const src = node.getAttribute('src');
    const alt = node.getAttribute('alt') || '';
    const title = node.getAttribute('title') || null;

    if (src) {
      const payloadObj: ExternalImagePayload = { href: src, title, text: alt };
      const payload = encodeExternalImagePayload({ payload: payloadObj });

      const replacement = node.ownerDocument.createElement('naidan-external-image');
      replacement.setAttribute('data-payload', payload);
      node.replaceWith(replacement);
    }
  }
});

function brandAllowedHtml({
  html,
}: {
  html: string;
}): AllowedHtml {
  return html as AllowedHtml;
}

export function escapeTextAsHtml({
  text,
}: {
  text: string;
}): AllowedHtml {
  return brandAllowedHtml({
    html: text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;'),
  });
}

export function sanitizeMarkdownHtml({
  html,
}: {
  html: string;
}): AllowedHtml {
  return brandAllowedHtml({
    html: markdownDOMPurify.sanitize(html, {
      USE_PROFILES: { html: true, svg: true },
      FORBID_ATTR: ['onerror', 'onclick', 'onload'],
      ADD_ATTR: [
        'target',
        'rel',
        'referrerpolicy',
        'data-payload',
        'data-naidan-external-link',
      ],
      ADD_TAGS: ['naidan-external-image'],
      ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|blob|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
    }),
  });
}

export function sanitizeHighlightHtml({
  html,
}: {
  html: string;
}): AllowedHtml {
  return brandAllowedHtml({
    html: highlightDOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['span'],
      ALLOWED_ATTR: ['class'],
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
    }),
  });
}

export function sanitizeJsonHighlightHtml({
  html,
}: {
  html: string;
}): AllowedHtml {
  return sanitizeHighlightHtml({ html });
}

export function allowedHtml(
  template: TemplateStringsArray,
  ...substitutions: never[]
): AllowedHtml {
  if (substitutions.length !== 0) {
    throw new Error('allowedHtml does not allow interpolations.');
  }

  return brandAllowedHtml({ html: template[0] ?? '' });
}

export function splitMarkdownHtmlByExternalImages({
  html,
}: {
  html: AllowedHtml;
}): MarkdownInlinePart[] {
  const sanitized = String(html);
  const tagRegex = /<naidan-external-image\s+data-payload="([^"]+)">\s*<\/naidan-external-image>/g;

  const result: MarkdownInlinePart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(sanitized)) !== null) {
    if (match.index > lastIndex) {
      result.push({
        type: 'html',
        html: brandAllowedHtml({ html: sanitized.substring(lastIndex, match.index) }),
      });
    }

    const payloadBase64 = match[1];
    if (payloadBase64) {
      const payload = decodeExternalImagePayload({ encodedPayload: payloadBase64 });
      if (payload) {
        result.push({
          type: 'image',
          payload,
        });
      }
    }

    lastIndex = tagRegex.lastIndex;
  }

  if (lastIndex < sanitized.length) {
    result.push({
      type: 'html',
      html: brandAllowedHtml({ html: sanitized.substring(lastIndex) }),
    });
  }

  return result;
}

export function jsonToHighlightedHtml({
  json,
  highlight,
  keyStyle,
}: {
  json: string;
  highlight: boolean;
  keyStyle: 'raw' | 'tree';
}): AllowedHtml {
  const escaped = json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  if (!highlight) {
    return sanitizeJsonHighlightHtml({ html: escaped });
  }

  const highlighted = escaped.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, (match) => {
    let cls = 'text-blue-500 dark:text-blue-400';
    if (/^"/.test(match)) {
      if (/:$/.test(match)) {
        switch (keyStyle) {
        case 'raw':
          cls = 'text-red-500 dark:text-red-400 font-bold';
          break;
        case 'tree':
          cls = 'text-red-500 dark:text-red-400 opacity-80';
          break;
        default: {
          const _ex: never = keyStyle;
          throw new Error(`Unhandled JSON key style: ${_ex}`);
        }
        }
      } else {
        cls = 'text-green-600 dark:text-green-400';
      }
    } else if (/true|false/.test(match)) {
      cls = 'text-orange-500';
    } else if (/null/.test(match)) {
      cls = 'text-magenta-500';
    }

    return `<span class="${cls}">${match}</span>`;
  });

  return sanitizeJsonHighlightHtml({ html: highlighted });
}

function escapeRegExp({
  string,
}: {
  string: string;
}): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function highlightSearchTextAsHtml({
  text,
  query,
  color,
}: {
  text: string;
  query: string;
  color: 'indigo' | 'blue';
}): AllowedHtml {
  if (!query) {
    return escapeTextAsHtml({ text });
  }

  const keywords = query.toLowerCase().split(/[\s\u3000]+/).filter(keyword => keyword.length > 0);
  if (keywords.length === 0) {
    return escapeTextAsHtml({ text });
  }

  const pattern = keywords.map(keyword => escapeRegExp({ string: keyword })).join('|');
  const regex = new RegExp(`(${pattern})`, 'gi');
  const colorClasses = (() => {
    switch (color) {
    case 'blue':
      return 'bg-blue-200 dark:bg-blue-900/50 text-blue-800 dark:text-blue-100';
    case 'indigo':
      return 'bg-indigo-200 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-100';
    default: {
      const _ex: never = color;
      throw new Error(`Unhandled color: ${_ex}`);
    }
    }
  })();

  const highlighted = text.split(regex).map(part => {
    const isMatch = keywords.some(keyword => part.toLowerCase() === keyword);
    const escaped = String(escapeTextAsHtml({ text: part }));
    if (isMatch) {
      return `<span class="${colorClasses} font-bold rounded px-0.5">${escaped}</span>`;
    }
    return escaped;
  }).join('');

  return sanitizeHighlightHtml({ html: highlighted });
}
