import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { UI_LOCALES } from '@/01-models/ui-locale';
import {
  STANDALONE_PACKAGE_LOCALE_META_NAME,
  STANDALONE_PACKAGE_LOCALE_WORKER_GLOBAL_NAME,
  TEST_ONLY,
} from './package-locale';

function withDocument<T>({ html, run }: {
  html: string;
  run: ({ documentValue }: { documentValue: Document }) => T;
}): T {
  const dom = new JSDOM(html);
  try {
    return run({ documentValue: dom.window.document });
  } finally {
    dom.window.close();
  }
}

describe('standalone package locale contract', () => {
  it('treats missing metadata as all-locales', () => {
    expect(withDocument({
      html: '<!doctype html><html><head></head><body></body></html>',
      run: ({ documentValue }) => TEST_ONLY.resolveStandalonePackageLocaleFromDocument({ documentValue }),
    })).toBeUndefined();
  });

  it.each(UI_LOCALES)('accepts the supported %s locale', (locale) => {
    expect(withDocument({
      html: `<!doctype html><html><head><meta name=${JSON.stringify(STANDALONE_PACKAGE_LOCALE_META_NAME)} content=${JSON.stringify(locale)}></head></html>`,
      run: ({ documentValue }) => TEST_ONLY.resolveStandalonePackageLocaleFromDocument({ documentValue }),
    })).toBe(locale);
  });

  it('fails closed on duplicate metadata', () => {
    expect(() => withDocument({
      html: `<!doctype html><html><head><meta name=${JSON.stringify(STANDALONE_PACKAGE_LOCALE_META_NAME)} content="ja"><meta name=${JSON.stringify(STANDALONE_PACKAGE_LOCALE_META_NAME)} content="ja"></head></html>`,
      run: ({ documentValue }) => TEST_ONLY.resolveStandalonePackageLocaleFromDocument({ documentValue }),
    })).toThrow(/at most one/u);
  });

  it('fails closed on an unsupported locale', () => {
    expect(() => withDocument({
      html: `<!doctype html><html><head><meta name=${JSON.stringify(STANDALONE_PACKAGE_LOCALE_META_NAME)} content="fr"></head></html>`,
      run: ({ documentValue }) => TEST_ONLY.resolveStandalonePackageLocaleFromDocument({ documentValue }),
    })).toThrow(/Unsupported standalone package locale/u);
  });
  it.each(UI_LOCALES)('accepts the supported %s locale from the Worker bootstrap global', (locale) => {
    expect(TEST_ONLY.resolveStandalonePackageLocaleFromWorkerGlobal({ value: locale })).toBe(locale);
  });

  it('treats a missing Worker bootstrap global as all-locales', () => {
    expect(TEST_ONLY.resolveStandalonePackageLocaleFromWorkerGlobal({ value: undefined })).toBeUndefined();
  });

  it('fails closed on an unsupported Worker bootstrap locale', () => {
    expect(() => TEST_ONLY.resolveStandalonePackageLocaleFromWorkerGlobal({ value: 'fr' })).toThrow(
      /Unsupported standalone package locale/u,
    );
  });

  it('uses the real Worker bootstrap global when no document metadata exists', () => {
    const previous = Reflect.get(globalThis, STANDALONE_PACKAGE_LOCALE_WORKER_GLOBAL_NAME) as unknown;
    Reflect.set(globalThis, STANDALONE_PACKAGE_LOCALE_WORKER_GLOBAL_NAME, 'ja');
    try {
      expect(TEST_ONLY.resolveStandalonePackageLocaleFromWorkerGlobal({
        value: Reflect.get(globalThis, STANDALONE_PACKAGE_LOCALE_WORKER_GLOBAL_NAME) as unknown,
      })).toBe('ja');
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, STANDALONE_PACKAGE_LOCALE_WORKER_GLOBAL_NAME);
      else Reflect.set(globalThis, STANDALONE_PACKAGE_LOCALE_WORKER_GLOBAL_NAME, previous);
    }
  });

});
