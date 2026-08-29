import { JSDOM } from 'jsdom';

import { STANDALONE_PACKAGE_LOCALE_META_NAME } from '../../../src/features/file-protocol-standalone/logic/package-locale-contract.js';

export const PACKAGE_LOCALE_META_NAME = STANDALONE_PACKAGE_LOCALE_META_NAME;

function hasStartOffset(value: unknown): value is Readonly<{ startOffset: number }> {
  return value !== null
    && typeof value === 'object'
    && 'startOffset' in value
    && typeof value.startOffset === 'number';
}

function findSafeInsertionOffset({ dom, html }: Readonly<{
  dom: JSDOM;
  html: string;
}>): number | undefined {
  const document = dom.window.document;
  const firstScript = document.head.querySelector('script');
  if (firstScript !== null) {
    const scriptLocation = dom.nodeLocation(firstScript);
    if (hasStartOffset(scriptLocation)) return scriptLocation.startOffset;
  }

  const headLocation = dom.nodeLocation(document.head);
  const endTagLocation = headLocation !== null
    && headLocation !== undefined
    && 'endTag' in headLocation
    ? headLocation.endTag
    : undefined;
  if (hasStartOffset(endTagLocation)) return endTagLocation.startOffset;

  // Keep the argument part of this helper's contract explicit: callers insert
  // into the original source only when JSDOM supplied a structural source offset.
  void html;
  return undefined;
}

export function insertPackageLocaleMetadata({ html, locale }: Readonly<{
  html: string;
  locale: string;
}>): string {
  const dom = new JSDOM(html, { includeNodeLocations: true });
  try {
    const document = dom.window.document;
    if (document.querySelector(`meta[name=${JSON.stringify(PACKAGE_LOCALE_META_NAME)}]`) !== null) {
      throw new Error('Package locale metadata already exists');
    }

    const meta = document.createElement('meta');
    meta.name = PACKAGE_LOCALE_META_NAME;
    meta.content = locale;
    const generatedMarkup = meta.outerHTML;

    const offset = findSafeInsertionOffset({ dom, html });
    let result: string;
    if (offset !== undefined) {
      // Insert before the first script in <head>, not merely before </head>.
      // HTML parsing pauses for classic scripts, so metadata placed after the
      // standalone entry is not observable by application code at startup.
      result = `${html.slice(0, offset)}${generatedMarkup}${html.slice(offset)}`;
    } else {
      document.head.prepend(meta);
      result = dom.serialize();
    }

    assertPackageLocaleMetadata({ html: result, expectedLocale: locale });
    return result;
  } finally {
    dom.window.close();
  }
}

export function assertPackageLocaleMetadata({ html, expectedLocale }: Readonly<{
  html: string;
  expectedLocale: string | undefined;
}>): void {
  const dom = new JSDOM(html);
  try {
    const metas = [...dom.window.document.querySelectorAll(`meta[name=${JSON.stringify(PACKAGE_LOCALE_META_NAME)}]`)];
    if (expectedLocale === undefined) {
      if (metas.length !== 0) throw new Error(`Expected no package locale metadata, found ${metas.length}`);
      return;
    }
    if (metas.length !== 1) throw new Error(`Expected exactly one package locale metadata element, found ${metas.length}`);
    if (metas[0]?.getAttribute('content') !== expectedLocale) {
      throw new Error(`Package locale metadata mismatch: expected ${expectedLocale}`);
    }
  } finally {
    dom.window.close();
  }
}
