export type RenderedResourceHintInput = Readonly<{
  url: string,
  destination: 'image' | 'media' | 'style' | 'font' | 'form',
  realm: 'document',
}>;

const MAX_ELEMENTS = 256;
const MAX_CSS_RULES = 64;
const MAX_CSS_LENGTH = 8_192;
const MAX_TOTAL_CSS_LENGTH = 32_768;
const MAX_URL_LENGTH = 4_096;
const MAX_RESOURCES = 16;
const IMAGE_PROPERTIES = ['background', 'background-image', 'border-image', 'border-image-source', 'list-style', 'list-style-image', 'mask', 'mask-image', 'cursor'];

function hasStyle(rule: CSSRule): rule is CSSRule & { style: CSSStyleDeclaration } {
  return 'style' in rule;
}

function hasRules(rule: CSSRule): rule is CSSRule & { cssRules: CSSRuleList } {
  return 'cssRules' in rule;
}

function hasStyleSheet(element: Element): element is Element & { sheet: CSSStyleSheet | null } {
  return 'sheet' in element;
}

/** Read literal URL functions without interpreting CSS or following references. */
function cssUrls({ value }: { value: string }): string[] | undefined {
  if (value.length > MAX_CSS_LENGTH) {
    return undefined;
  }
  const result: string[] = [];
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (char === '/' && value[index + 1] === '*') {
      const end = value.indexOf('*/', index + 2);
      if (end < 0) {
        return result;
      }
      index = end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      index++;
      while (index < value.length && value[index] !== quote) {
        index += value[index] === '\\' ? 2 : 1;
      }
      index++;
      continue;
    }
    const previous = value[index - 1];
    const followsName = previous !== undefined && (/[a-z0-9_\\-]/i.test(previous) || previous.charCodeAt(0) >= 128);
    if (value.slice(index, index + 4).toLowerCase() !== 'url(' || followsName) {
      index++;
      continue;
    }
    index += 4;
    while (/\s/.test(value[index] ?? '')) {
      index++;
    }
    const quote = value[index] === '"' || value[index] === "'" ? value[index++] : undefined;
    const start = index;
    while (index < value.length && value[index] !== (quote ?? ')')) {
      index += value[index] === '\\' ? 2 : 1;
    }
    const raw = value.slice(start, index);
    if (quote !== undefined) {
      index++;
      while (/\s/.test(value[index] ?? '')) {
        index++;
      }
    }
    if (value[index] === ')' && !/[\\()\r\n]/.test(raw) && (quote !== undefined || !/[\s"']/.test(raw))) {
      result.push(raw.trim());
      if (result.length > MAX_RESOURCES) {
        return undefined;
      }
    }
    index++;
  }
  return result;
}

/**
 * Observe resources already rendered by Markdown/Mermaid. This never parses
 * another HTML document, follows imported stylesheets, or starts a request.
 */
export function collectRenderedResourceHintInputs({ root }: { root: Element | undefined }): readonly RenderedResourceHintInput[] {
  try {
    if (root === undefined) {
      return [];
    }
    const resources: RenderedResourceHintInput[] = [];
    const seen = new Set<string>();
    let elements = 0;
    let cssRules = 0;
    let cssLength = 0;
    let exceeded = false;

    function append({ raw, destination, base }: { raw: string | null, destination: RenderedResourceHintInput['destination'], base: string }): void {
      if (exceeded || raw === null || raw.length > MAX_URL_LENGTH || raw.trim() === '' || raw.trim().startsWith('#')) {
        return;
      }
      const absolute = /^[a-z][a-z0-9+.-]*:/i.test(raw.trim());
      if (!absolute && base.length > MAX_URL_LENGTH) {
        return;
      }
      const url = absolute ? new URL(raw) : new URL(raw, base);
      if (!['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) {
        return;
      }
      const key = `${destination}\n${url.href}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      resources.push(Object.freeze({ url: url.href, destination, realm: 'document' }));
      if (resources.length > MAX_RESOURCES) {
        exceeded = true;
      }
    }

    function readCssUrls({ value }: { value: string }): string[] | undefined {
      cssLength += value.length;
      if (cssLength > MAX_TOTAL_CSS_LENGTH) {
        exceeded = true;
        return undefined;
      }
      return cssUrls({ value });
    }

    function readStyle({ style, base }: { style: CSSStyleDeclaration, base: string }): void {
      for (const property of IMAGE_PROPERTIES) {
        const urls = readCssUrls({ value: style.getPropertyValue(property) });
        if (urls === undefined) {
          exceeded = true;
          return;
        }
        for (const raw of urls) {
          append({ raw, destination: 'image', base });
        }
      }
    }

    function readRules({ rules, base, depth }: { rules: CSSRuleList, base: string, depth: number }): void {
      if (depth > 4) {
        exceeded = true;
        return;
      }
      for (let index = 0; index < rules.length && !exceeded; index++) {
        if (++cssRules > MAX_CSS_RULES) {
          exceeded = true;
          return;
        }
        const rule = rules[index]!;
        if (rule.type === 3 && 'href' in rule && typeof rule.href === 'string') {
          append({ raw: rule.href, destination: 'style', base });
          // Reading an imported stylesheet would add unrelated, possibly
          // cross-origin work. Only its already declared URL is observed.
          continue;
        }
        if (hasStyle(rule)) {
          if (rule.type === 5) {
            const urls = readCssUrls({ value: rule.style.getPropertyValue('src') });
            if (urls === undefined) {
              exceeded = true;
              return;
            }
            for (const raw of urls) {
              append({ raw, destination: 'font', base });
            }
          } else {
            readStyle({ style: rule.style, base });
          }
        }
        if (hasRules(rule)) {
          readRules({ rules: rule.cssRules, base, depth: depth + 1 });
        }
      }
    }

    function readElement({ element }: { element: Element }): void {
      if (++elements > MAX_ELEMENTS) {
        exceeded = true;
        return;
      }
      const tag = element.localName.toLowerCase();
      const base = element.baseURI;
      switch (tag) {
      case 'img':
        append({ raw: element instanceof HTMLImageElement ? element.currentSrc || element.getAttribute('src') : element.getAttribute('src'), destination: 'image', base });
        break;
      case 'image':
        append({ raw: element.getAttribute('href') ?? element.getAttributeNS('http://www.w3.org/1999/xlink', 'href'), destination: 'image', base });
        break;
      case 'video':
        append({ raw: element.getAttribute('poster'), destination: 'image', base });
        append({ raw: element.getAttribute('src'), destination: 'media', base });
        break;
      case 'audio':
        append({ raw: element.getAttribute('src'), destination: 'media', base });
        break;
      case 'source':
      case 'track':
        if (element.parentElement?.localName === 'audio' || element.parentElement?.localName === 'video') {
          append({ raw: element.getAttribute('src'), destination: 'media', base });
        }
        break;
      case 'input':
        if (element.getAttribute('type')?.toLowerCase() === 'image') {
          append({ raw: element.getAttribute('src'), destination: 'image', base });
        }
        break;
      case 'table':
      case 'td':
      case 'th':
        append({ raw: element.getAttribute('background'), destination: 'image', base });
        break;
      case 'form':
        if (element.getAttribute('method')?.toLowerCase() !== 'dialog') {
          append({ raw: element.getAttribute('action') || element.ownerDocument.URL, destination: 'form', base });
        }
        break;
      case 'style':
        if (hasStyleSheet(element) && element.sheet !== null) {
          readRules({ rules: element.sheet.cssRules, base, depth: 0 });
        }
        break;
      default:
        break;
      }
      if (element instanceof HTMLElement || element instanceof SVGElement) {
        readStyle({ style: element.style, base });
      }
    }

    readElement({ element: root });
    const walker = root.ownerDocument.createTreeWalker(root, 1);
    let node = walker.nextNode();
    while (node !== null && !exceeded) {
      if (node instanceof Element) {
        readElement({ element: node });
      }
      node = walker.nextNode();
    }
    return exceeded ? [] : Object.freeze(resources);
  } catch {
    // URL/CSSOM/DOM inspection is optional and cannot alter the rendered content.
    return [];
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
