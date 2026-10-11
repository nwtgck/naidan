import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  assertPackageLocaleMetadata,
  insertPackageLocaleMetadata,
  PACKAGE_LOCALE_META_NAME,
} from './plugin/package-html.js';
import { createTestDisposable } from '../../src/utils/resource-cleanup.test-support';

describe('package locale HTML metadata', () => {
  it('uses the parsed real head end instead of a literal </head> inside script text', () => {
    const html = '<!doctype html><html><head><script>const x = "</head>";</script><title>x</title></head><body></body></html>';
    const result = insertPackageLocaleMetadata({ html, locale: 'ja' });
    expect(result).toContain('<script>const x = "</head>";</script>');
    const dom = new JSDOM(result);
    using _cleanupResource = createTestDisposable({
      dispose: () => {
        dom.window.close();
      },
    });
    const meta = dom.window.document.querySelector(`meta[name="${PACKAGE_LOCALE_META_NAME}"]`);
    expect(meta?.getAttribute('content')).toBe('ja');
    expect(meta?.nextElementSibling?.tagName).toBe('SCRIPT');
  });

  it('is visible to a head script at parser execution time', () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"><script>globalThis.__PACKAGE_META_SEEN__ = document.querySelector(\'meta[name="naidan-package-locale"]\')?.content;</script></head><body></body></html>';
    const result = insertPackageLocaleMetadata({ html, locale: 'ja' });
    const dom = new JSDOM(result, { runScripts: 'dangerously' });
    using _cleanupResource = createTestDisposable({
      dispose: () => {
        dom.window.close();
      },
    });
    expect((dom.window as unknown as { __PACKAGE_META_SEEN__?: string }).__PACKAGE_META_SEEN__).toBe('ja');
  });

  it('rejects duplicate package metadata instead of overwriting it', () => {
    const html = '<!doctype html><html><head><meta name="naidan-package-locale" content="en"></head><body></body></html>';
    expect(() => insertPackageLocaleMetadata({ html, locale: 'ja' })).toThrow(/already exists/u);
  });

  it('falls back to DOM serialization when head is parser-created', () => {
    const result = insertPackageLocaleMetadata({ html: '<body>ok</body>', locale: 'en' });
    assertPackageLocaleMetadata({ html: result, expectedLocale: 'en' });
  });

  it('asserts that all-locales HTML has no package constraint', () => {
    expect(() => assertPackageLocaleMetadata({ html: '<html><head></head><body></body></html>', expectedLocale: undefined })).not.toThrow();
  });
});
